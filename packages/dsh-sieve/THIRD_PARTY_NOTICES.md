# 第三方声明

## mu（qybaihe/mu）

来源：https://github.com/qybaihe/mu ，固定 commit `8dfebe36508ac0c2508735bb866756dab9283e74`（2026-09-30），MIT 许可。

sieve 的判断内核部分代码从 mu 的 `packages/kyrn-judge/`（包名 `@kyrn/judge`）移植或改写；执行管道（引擎、judge 包装、账本、providers）按 DeepSeek Harness 的扩展点重写。

| sieve 文件（`packages/dsh-sieve/`） | mu 来源（`packages/kyrn-judge/`） | 方式 |
|---|---|---|
| `src/judge/types.ts` | `src/types.ts` | 移植后修改 |
| `src/judge/errors.ts` | `src/errors.ts` | 移植后修改 |
| `src/judge/policy.ts` | `src/policy.ts` | 移植 |
| `src/judge/redact.ts` | `src/redact.ts` | 移植 |
| `src/judge/decision.ts` | `src/decision.ts`（DecisionSpec 部分） | 移植后修改 |
| `src/judge/engine.ts` | `src/decision.ts`（DecisionEngine 部分） | 改写 |
| `src/judge/judge.ts` | `src/judge.ts` | 改写 |
| `src/judge/ledger.ts` | `src/ledger.ts` | 改写 |
| `src/judge/providers/llm.ts` | `src/providers/llm.ts` | 移植 |
| `src/judge/providers/http.ts` | `src/providers/http.ts` | 移植 |
| `src/judge/providers/mock.ts` | `src/providers/mock.ts` | 移植 |
| `src/judge/providers/system-one.ts` | `src/providers/typesafe.ts` | 改写 |
| `src/judge/decisions/tool-admission.ts` | `src/decisions/tool-admission.ts` | 改写 |
| `src/judge/decisions/context-forget.ts` | `src/decisions/context-forget.ts` | 移植后修改 |
| `src/judge/decisions/skill-disclosure.ts` | `src/decisions/skill-disclosure.ts` | 移植 |
| `src/judge/admission/test-log.ts` | `src/admission/test-log.ts` | 移植后修改 |
| `src/features/admission-rules.ts` | `src/extension/features/admission.ts` | 改写 |
| `src/features/admission.ts`、`src/runtime/session-state.ts` | `src/extension/features/admission.ts`、`src/extension/runtime.ts` | 参考后重写 |
| `src/features/forgetting.ts` | `src/extension/features/forgetting.ts` | 改写 |
| `src/features/skills.ts` | `src/extension/features/skills.ts` | 改写 |
| `src/migration/import-config.ts` | `src/config.ts` | 参考配置格式，独立实现 |
| `tests/judge/test-log.spec.ts` | `test/test-log.test.ts` | 移植后修改 |
| `tests/judge/fixtures/test-log-cases.ts`、`tests/judge/fixtures/test-logs/*.txt` | `test/fixtures/test-log-cases.ts`、`test/fixtures/test-logs/*.txt` | 原样复制 |
| `tests/judge/redact.spec.ts` | `test/redact.test.ts` | 移植 |
| `tests/judge/engine.spec.ts` | `test/decision.test.ts`、`test/judge.test.ts` | 改写 |
| `tests/judge/providers.spec.ts` | `test/cascade.test.ts`、`test/typesafe-provider.test.ts` | 改写 |
| `tests/judge/decisions.spec.ts` | `test/features.test.ts` | 改写 |

mu 仓库的许可证原文：

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
