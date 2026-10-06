<div align="center">

**中文** | [English](README.en.md)

<img src="assets/banner.webp" alt="sieve" width="100%">

# sieve / dsh-sieve

**DeepSeek Harness（DSH）上下文管理与 token 优化插件**

**离线回放请求载荷减少 30% 以上（按字符数）**：100 条公开 Agent 轨迹的累计降幅为 **36.28%**，详见[实验口径与限制](#离线回放结果)。

在工具结果、历史上下文和技能目录进入主模型请求之前做判断，
只放行对当前任务有用的部分，原文全部归档、随时可取回。

为 LLM Agent 提供上下文管理（Context Management）：工具输出过滤（Tool Output Filtering）、历史上下文裁剪与技能按需披露（Progressive Skill Disclosure），减少主模型反复读取无关内容。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=nodedotjs&logoColor=white)](package.json)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-0.2.1--alpha.1-4D6BFE)](packages/dsh-sieve/package.json)
[![Cordis](https://img.shields.io/badge/Cordis-4.0.5--alpha.1-6E56CF)](packages/dsh-sieve/package.json)
<br>
![Tests](https://img.shields.io/badge/tests-250%20passed-brightgreen)
![Test keys](https://img.shields.io/badge/test%20suite-no%20API%20keys-brightgreen)
[![DSH core](https://img.shields.io/badge/DSH%20core-0%20patches-brightgreen)](#设计约束)
[![Cold restore](https://img.shields.io/badge/cold%20restore-replay%20safe-brightgreen)](#设计约束)

</div>

---

## 为什么需要它

Agent 循环里，主模型每一步都要重新读一遍完整上下文。真正决定请求体大小的往往不是用户输入，而是：

- **工具输出**：构建日志、测试报告、命令输出，动辄数千到数万字符，对下一步决策有用的通常只是其中一小段；
- **陈旧上下文**：已经被后续读取覆盖、或早已不再相关的工具结果，仍然每一步都被重新发送；
- **技能目录**：几十上百个技能描述在会话开始时整体注入，大多数与当前任务无关。

这些内容按输入 token 计费，占用上下文窗口，还会稀释模型注意力。sieve 在 DSH 的公开扩展点上插入一层**判断内核**，对上面三类内容做准入、遗忘和按需披露，让主模型每一步看到的上下文更短、更集中。

难点在于判断「哪些可以省」。只靠固定规则，遇到没见过的输出格式就只能保留原文；交给主模型自己判断，判断本身又要花掉主模型的 token 和一次完整的推理延迟，省下的可能还不够抵消。sieve 因此把这一步交给专门的判断模型 **Jev**：它通过 System One 协议直接回答结构化的是/否题和单选题，并给出概率，内核据此按门槛决定改写还是保留原文。在离线回放中，Jev 单次判断的延迟中位数约 0.3 秒，326 次请求总费用约 $0.03。没有 Jev 密钥时，判断改由会话模型完成，不需要额外账号，详见[判断服务](#判断服务judge)。

## 架构

```mermaid
flowchart LR
    subgraph Loop["DSH Agent Loop"]
        T[工具执行] -->|post-execute| A
        P[agent/pre-step] --> F
        S[技能目录注入] --> D
    end

    subgraph Sieve["dsh-sieve"]
        A["tool.admission<br/>tool.admission.test-log"]
        F[context.forget]
        D[skills.disclosure]
        K(("判断内核<br/>Judge Engine"))
        A <--> K
        F <--> K
        D <--> K
    end

    K <-->|"System One / ctx.llm"| J[("Judge<br/>Jev · 会话模型")]
    A & F -->|原文| SP[(spill 归档)]
    K -->|决策记录| L[(ctx.storage 账本)]
    L --> W["/sieve 命令 · Web 面板"]

    A & F & D -->|精简后的上下文| M[主模型请求]
```

| 组件 | 作用 |
|---|---|
| **判断内核** | 统一的决策引擎：组装题面、调用 judge、校验结构化输出、按置信度与预算门槛决定是否应用；judge 超时或失败时一律回退为不改写 |
| **`tool.admission`** | 工具结果写入会话前的准入控制，对长输出做分级处理，只改写 `content`，不改工具调用结构 |
| **`tool.admission.test-log`** | 针对测试运行输出的专用准入通道，保护失败、摘要与无法识别的内容 |
| **`context.forget`** | 对历史工具结果做批量遗忘，通过 DSH 原生 `compaction/prune` 与结果替换落地，考虑提示缓存前缀成本，攒够收益才提交 |
| **`skills.disclosure`** | 首份技能目录按任务相关性过滤，相关技能在后续回合按需公布；被隐藏的技能仍可直接加载 |
| **账本** | 每个会话一份 `ctx.storage` 文档，记录每次判断的模式、结果、usage 与预计净节省 |
| **`dsh-sieve-web`** | DSH Web 右侧边栏面板：显示本会话的输入 token 缩减（估算，含缩减率）与上下文缩减字符数，配置 Jev 判断服务的 API 密钥 |

## 判断服务（Judge）

规则能处理的情况由确定性规则直接处理；规则拿不准的部分交给 judge。决策点把待判断的内容整理成结构化问题（是/否题、单选题），judge 对每个问题返回概率或选项，内核再按门槛决定改写还是保留原文。

```mermaid
flowchart LR
    D[决策点] -->|结构化问题<br/>已脱敏| R{judge.type}
    R -->|auto：找到 Jev 密钥| JV["Jev<br/>System One 协议"]
    R -->|auto：没有密钥 / llm| LM["会话模型<br/>ctx.llm 旁路调用"]
    R -->|off| RU[只运行规则]
    JV & LM -->|概率 / 选项| P{门槛}
    P -->|通过| AP[改写上下文]
    P -->|未通过 / 超时 / 出错| KP[保留原文]
```

| 后端 | 说明 | 需要 | 费用 |
|---|---|---|---|
| **Jev** | TypeSafe 的结构化判断模型，通过 System One 协议原生回答是/否题和单选题，并返回每个回答的概率。sieve 的题型与该协议一致。可走 TypeSafe 官方端点或 OpenRouter | TypeSafe 或 OpenRouter 的 API 密钥 | 按 TypeSafe 计费（2026-10-06 [官方价格](https://docs.typesafe.ai/models)：输入 $0.042 / 百万 token，输出不计费） |
| **会话模型** | 通过 DSH 的 `ctx.llm` 调用当前会话的模型，或为判断单独指定的 provider/model；用固定提示词让模型按同一格式作答，`temperature: 0` | 无需额外账号 | 计入所用模型的 token；可以给判断配一个更便宜的模型 |
| **off** | 不调用任何模型，规则拿不准的部分一律保留原文 | — | 无 |

默认的 `auto` 在每次判断时查找 Jev 密钥：先找 `TYPESAFE_API_KEY`，再找 `SIEVE_JUDGE_OPENROUTER_API_KEY`，找到就用 Jev，找不到就用会话模型。密钥保存、更换或移除后，下一次判断立即生效，不需要重启。

**判断不进入主对话。** judge 调用是旁路请求，不写入会话日志，不进入主模型的上下文，也不影响主模型的提示缓存。发给 judge 的内容会先脱敏：只有可确定是凭据的内容才会被替换，包括凭据形态的 token、名称表明是密钥的赋值，以及当前进程凭据变量的值。

**失败一律保留原文。** 单次判断有时限（默认 4000 ms），超时、出错或回答不合法时都按保留原文处理；失败调用中已知的花费同样记入账本。

**实测（Jev）。** 离线回放中共 326 次 Jev 请求，全部成功；HTTP 延迟 P50 287 ms、P95 590 ms；总费用约 $0.031。详见[离线回放结果](#离线回放结果)。

### 配置 Jev 密钥

任选一种：

- **Web 面板**：右侧栏 **Sieve** 页的「Jev 判断服务」，为 TypeSafe 或 OpenRouter 粘贴密钥并保存。密钥存进 `$DSH_HOME/.credentials.yaml`，只发往宿主，面板不会回显。两个都配置时优先用 TypeSafe。
- **环境变量**：`TYPESAFE_API_KEY` 或 `SIEVE_JUDGE_OPENROUTER_API_KEY`，可以放在启动 `dsh` 的 shell 环境、启动目录的 `.env` 或 `$DSH_HOME/.env` 中。进程环境变量的优先级高于面板保存的密钥，此时面板只显示来源，不能修改。

> [!IMPORTANT]
> 使用默认的 `auto` 时，只要环境里存在 `TYPESAFE_API_KEY`（例如 shell 配置文件中的 export，或项目 `.env`），判断就会改走 Jev 并产生 TypeSafe 费用。只想用会话模型时，把 `judge.type` 设为 `llm`。

> [!NOTE]
> sieve 的判断内核源自 mu。mu 采用级联判断：先由本地 Laya 模型回答，拿不准的再交给 Jev。Laya 依赖 macOS Core ML 和一个本地 sidecar 进程，没有移植到 sieve。sieve 目前只支持上表中的三种后端。

## 三种运行模式

默认四个决策都是 `active`，装上即裁剪上下文。`off` 与 `shadow` 只保留给 profile 配置与 `/sieve mode` 命令，用于测量对照；Web 面板不提供模式切换。

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `active`（默认） | 限时判断，通过门槛后改写上下文 | 正常使用 |
| `shadow` | 后台判断并入账，**不改动模型看到的内容** | 测量对照：只看账本里的预计收益 |
| `off` | 不判断、不改写 | 基线或关闭某个决策 |

`active` 的判断有明确的等待上限，超时即放行原文；`shadow` 不阻塞 Agent 循环。

## 设计约束

sieve 的目标是**在不降低任务成功率的前提下**缩减上下文，因此对正确性有几条硬约束：

- **原文不丢**：任何有损改写之前，原文先写入 spill 归档，模型可以按需取回。
- **冷恢复一致**：模型可见的内容全部能从会话日志重建。在线请求与会话恢复、fork 之后的请求一致，不会重复判断或重复改写。
- **不写自定义事件**：状态只从 DSH 原生事件推导，账本放在 `ctx.storage`，不会让会话因未知事件而无法恢复。
- **DSH 核心零修改**：只使用公开扩展点（`agent/pre-step`、工具 post-execute、技能目录监听、`ctx.llm`、`ctx.storage`、`connection.fetch` 路由）。
- **资源随插件生命周期**：所有监听器与定时器通过 `ctx` 注册，处处响应 `AbortSignal`，卸载与热重载可完整清理。
- **失败即放行**：judge 不可用、输出不合法或超出预算，一律保留原文。

每条约束都有对应的契约测试，针对固定版本的 DSH 源码验证调用顺序、结果替换、spill 顺序、技能目录过滤与冷恢复行为。

## 离线回放结果

数据来自冻结的公开 Agent 轨迹与原始会话：同一批轨迹分别在四个决策全部 `off` 与全部 `active` 下回放并逐条配对，在真实 DSH Loop 与 sieve 监听器上运行，judge 使用真实模型（`jev-1.13.0`），主模型调用为回放。

| 数据集 | 配对数 | 累计请求载荷 | 工具输出 |
|---|---:|---:|---:|
| SWE-smith + Nebius 公开轨迹 | 100 | 537,410,284 → 342,420,598 字符（**−36.28%**） | 11,312,658 → 4,193,084 字符（**−62.93%**） |
| 　其中 SWE-smith | 50 | **−30.88%** | **−50.47%** |
| 　其中 Nebius | 50 | **−37.58%** | **−67.66%** |
| SWE-chat 原始会话 | 7 | 33,733,731 → 18,204,646 字符（**−46.03%**） | 314,263 → 128,407 字符（**−59.14%**） |

**提示缓存。** 改写历史会破坏缓存前缀，因此按相邻请求的最长相同前缀估算缓存命中，再算费用代理。假设命中价为未命中价的 0.1 / 0.25 时，100 条公开轨迹的费用代理分别少 **19.94% / 29.82%**，SWE-chat 少 **34.02% / 41.56%**。

**信息保留。** 在 38 个人工标注的工具输出样本上（29 条调优、9 条留出），必需信息保留 **72/72、19/19，零标注误删**。

**正确性。** 222 次回放全部通过工具返回值与错误状态、受保护日志行、原文归档、原生冷恢复和 projection 重建检查；1,422 份归档原文逐字节可取回。

**judge 开销。** 共 326 次 judge 请求，全部成功、零回退；输入 729,167 token、输出 30,868 token，总费用约 $0.031。HTTP 延迟 P50 **287 ms**、P95 **590 ms**、最大 1,195 ms，0 次超过 4 秒（回放使用更长的等待，生产默认的 4 秒截止未在本轮复跑）。

> [!NOTE]
> 载荷与工具输出按请求 JSON 的字符数计，两种口径有重叠，不能相加，也不等于实际 token 或账单；缓存一项是模型估算，不是实际命中数据。离线回放固定了后续动作，不能说明真实执行下的补读次数与任务成功率不变。SWE-chat 回放只覆盖首份技能目录，没有覆盖多轮再披露。带真实主模型的成功率与 token 对照实验尚未进行。

## 安装

| 包 | 作用 | 适用 profile |
|---|---|---|
| `dsh-sieve` | 插件本体：判断内核、四个决策、账本、`/sieve` 命令 | 任意（`web`、`headless` 等） |
| `dsh-sieve-web` | Web 右侧边栏面板，依赖同版本的 `dsh-sieve` | 仅 `web` |

**版本对应**：sieve 按 DSH 精确版本声明 peer，宿主在安装和启动时校验，版本不符会拒绝加载。

| sieve | DeepSeek Harness | Node.js |
|---|---|---|
| `0.1.0` | `0.2.1-alpha.1` | `^22.19.0 \|\| >=24.0.0` |

### 方式一：npm（推荐）

预构建包，不需要在本机编译，也不需要授权构建脚本。插件本体与 Web 面板一起装：

```bash
dsh plugin --profile web add dsh-sieve@0.1.0 dsh-sieve-web@0.1.0
```

`headless` 等没有 Web 界面的 profile 只装本体：

```bash
dsh plugin --profile headless add dsh-sieve@0.1.0
```

也可以在 DSH Web 侧边栏打开**插件 → 添加插件**，依次输入 `dsh-sieve@0.1.0`、`dsh-sieve-web@0.1.0` 安装，效果与命令行相同。

### 方式二：GitHub Release

npm 不可达或想锁定到构建产物时，直接装 [Release](https://github.com/Sev7eEn7/sieve/releases) 附带的 tgz，同样是预构建包、无需授权构建脚本。发布页附有 `SHA256SUMS` 供校验：

```bash
dsh plugin --profile web add https://github.com/Sev7eEn7/sieve/releases/download/v0.1.0/dsh-sieve-0.1.0.tgz https://github.com/Sev7eEn7/sieve/releases/download/v0.1.0/dsh-sieve-web-0.1.0.tgz
```

### 方式三：从源码构建

```bash
git clone https://github.com/Sev7eEn7/sieve.git && cd sieve
```

```bash
pnpm install && pnpm release:pack
```

```bash
dsh plugin --profile web add ./release/dsh-sieve-0.1.0.tgz ./release/dsh-sieve-web-0.1.0.tgz
```

`pnpm release:pack` 会构建两个包，检查版本与 peer 一致、产物里没有 `workspace:` 和本机路径，然后把 tgz 和 `SHA256SUMS` 输出到 `release/`。

> [!NOTE]
> 不支持 `github:Sev7eEn7/sieve` 这种 git 安装：仓库是 monorepo，git 安装只拿到源码，不带 `lib/` 构建产物。请用上面三种方式之一。

### 启用与验证

1. 重启 `dsh web`（升级已装版本时必须重启），然后刷新浏览器页面，让面板的前端代码重新加载。
2. 确认已加载：

   ```bash
   dsh --profile web --dump-config
   ```

   输出里应有 `# == dsh-sieve` 和 `# == dsh-sieve-web` 两层。
3. 在会话中输入 `/sieve status`，能看到各决策的模式与账本；Web 右侧边栏会出现 **Sieve** 页。

### 升级与卸载

升级时用新版本号重新 `add`，之后重启：

```bash
dsh plugin --profile web add dsh-sieve@<版本> dsh-sieve-web@<版本>
```

卸载时连同配置层一起移除，先卸面板，再卸本体：

```bash
dsh plugin --profile web remove dsh-sieve-web dsh-sieve
```

## 配置

不写配置即可使用：judge 为 `auto`，所有决策为 `active`。需要调整时在 profile 的 patch 中配置 `sieve` 服务：

```yaml
- id: sieve
  config:
    judge:
      type: auto           # auto | llm | system-one | off
      timeoutMs: 4000
    modes:
      default: active
      skills.disclosure: shadow
    routes:                # 可选：为单个决策指定更便宜的 llm judge 模型（auto 与 llm）
      context.forget:
        provider: <provider>
        model: <model>
```

| `judge.type` | 说明 |
|---|---|
| `auto`（默认） | 有 Jev 密钥时用 Jev，否则用会话模型，见[判断服务](#判断服务judge) |
| `llm` | 只用会话模型；可写 `provider` 与 `model` 指定判断用的模型，也可用 `routes` 按决策分别指定 |
| `system-one` | 只用 Jev，或任何兼容 System One 协议的端点；需要 `apiKey`（建议写 `!!js process.env.XXX`），可选 `baseUrl` 与 `model`（默认 `jev-latest`） |
| `off` | 不调用 judge，只运行规则 |

指定 Jev 端点的例子：

```yaml
- id: sieve
  config:
    judge:
      type: system-one
      apiKey: !!js process.env.MY_JUDGE_KEY
      baseUrl: https://<System One 端点>
      model: jev-latest
```

非法配置（例如未知的决策 id）在加载时直接报错，不会静默回退。

## 会话命令

```text
/sieve status                                   查看本会话各决策的模式、记录数、已应用数与预计净节省
/sieve mode <决策 id> <off|shadow|active|reset>  覆盖本会话某个决策的模式
/sieve route <决策 id> <provider> <model>        覆盖本会话某个决策的 judge 路由
/sieve route <决策 id> reset                     恢复 profile 中的路由
```

命令不调用模型，覆盖只在当前会话、本次插件装载期间有效。

## 开发

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm release:pack
```

- `pnpm build` 编译两个包，并把 Web 面板的浏览器端打成 DSH Web 可加载的单文件。
- `pnpm release:pack` 构建并打包出可安装的 tgz 与 `SHA256SUMS`，见[安装](#方式三从源码构建)。
- 依赖全部锁定精确版本；`@deepseek-ai/dsh-*` 以精确版本声明为 peer，宿主在安装与启动时校验。

```
packages/
├── dsh-sieve/          # 插件本体：判断内核、四个决策、账本、/sieve 命令
│   ├── src/judge/      # 决策引擎、providers、题面与 policy、脱敏
│   ├── src/features/   # 各决策点与 DSH 扩展点的接线
│   └── src/runtime/    # 配置、会话状态推导、账本、状态快照
└── dsh-sieve-web/      # DSH Web 面板（Host 路由 + 浏览器端）
```

## 致谢与许可

部分判断内核代码源自 mu，来源路径与 commit 记录在 [THIRD_PARTY_NOTICES.md](packages/dsh-sieve/THIRD_PARTY_NOTICES.md)。

本项目以 [MIT](LICENSE) 许可发布。
