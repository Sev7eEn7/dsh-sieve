/** Panel copy; DSH requires every built-in locale, so English mirrors the Chinese keys. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace owned by the sieve panel. */
export const NS = 'sieve'

export const zh = {
  'tab.title': 'Sieve',
  'tab.description': '上下文缩减量与 Jev 判断服务密钥',
  'header.refresh': '刷新',
  'state.loading': '正在读取…',
  'error.unavailable': '无法连接 sieve：确认 profile 已安装 dsh-sieve 与 dsh-sieve-web。',
  'error.rejected': '宿主拒绝了请求：{message}',
  'error.version': '宿主的 dsh-sieve 与面板版本不一致，请让两个包使用同一版本。',
  'metric.tokens': '输入 token 缩减（估算）',
  'metric.tokensHint': '已生效裁剪移除的上下文按 DSH token meter 文本密度（{density} 字符/token）折算的 token 数；缩减率 = 缩减量 ÷（当前请求上下文 token + 缩减量）。',
  'metric.ratio': '缩减率 {ratio}',
  'metric.ratioUnknown': '缩减率需会话在宿主中运行',
  'metric.context': '上下文缩减',
  'metric.contextHint': '已生效裁剪从模型可见上下文中移除的字符数（准入、遗忘、技能披露的累计净值）。',
  'metric.chars': '{chars} 字符',
  'jev.title': 'Jev 判断服务',
  'jev.using.jev': '当前判断：Jev（{service}）',
  'jev.using.jevUnknown': '当前判断：Jev（profile 指定的端点）',
  'jev.using.laya': '当前判断：Laya（本地）',
  'jev.using.none': '未配置判断模型：保存 Jev 密钥或在 profile 中配置 Laya 之前，sieve 不改动任何上下文。',
  'jev.profileJudge': 'profile 指定 judge 为 {type}，这里保存的密钥不会被使用。',
  'jev.service.typesafe': 'TypeSafe',
  'jev.service.openrouter': 'OpenRouter',
  'jev.configured': '已配置（{source}）',
  'jev.notConfigured': '未配置',
  'jev.source.env': '进程环境变量',
  'jev.source.file': 'DSH 凭据存储',
  'jev.source.project-env': '工作区 .env',
  'jev.source.user-env': 'DSH_HOME/.env',
  'jev.readOnly': '由进程环境变量 {ref} 提供，面板不能修改',
  'jev.fallback': '来自 {source} 的 {ref}；在此保存的密钥会优先生效，移除需编辑该文件',
  'jev.unavailable': '宿主没有凭据存储，不能保存密钥',
  'jev.placeholder': '粘贴 API 密钥',
  'jev.inputLabel': '{service} 的 API 密钥',
  'jev.save': '保存',
  'jev.replace': '替换',
  'jev.clear': '移除',
  'jev.invalid': '密钥需为 {min}–{max} 个字符且不含空白。',
  'jev.note': '密钥保存在 DSH 凭据存储中，只发往宿主，不会回显；两个服务都配置时优先使用 TypeSafe。',
} as const

export const en: Record<keyof typeof zh, string> = {
  'tab.title': 'Sieve',
  'tab.description': 'Context reduction and Jev judge keys',
  'header.refresh': 'Refresh',
  'state.loading': 'Loading…',
  'error.unavailable': 'Cannot reach sieve: check that the profile has both dsh-sieve and dsh-sieve-web installed.',
  'error.rejected': 'The host rejected the request: {message}',
  'error.version': 'The host dsh-sieve and this panel differ in version; install matching versions of both packages.',
  'metric.tokens': 'Input token reduction (est.)',
  'metric.tokensHint': 'Context removed by applied cuts, priced at the DSH token meter text density ({density} chars/token); ratio = reduction ÷ (current request context tokens + reduction).',
  'metric.ratio': '{ratio} of context',
  'metric.ratioUnknown': 'The ratio needs the session running on the host',
  'metric.context': 'Context reduction',
  'metric.contextHint': 'Characters removed from the model-visible context by applied cuts (admission, forgetting and skill disclosure, net).',
  'metric.chars': '{chars} chars',
  'jev.title': 'Jev judge service',
  'jev.using.jev': 'Judging with Jev ({service})',
  'jev.using.jevUnknown': 'Judging with Jev (endpoint set in the profile)',
  'jev.using.laya': 'Judging with Laya (local)',
  'jev.using.none': 'No judge model: sieve changes nothing until a Jev key is saved or the profile configures Laya.',
  'jev.profileJudge': 'The profile sets the judge to {type}; keys saved here are not used.',
  'jev.service.typesafe': 'TypeSafe',
  'jev.service.openrouter': 'OpenRouter',
  'jev.configured': 'Configured ({source})',
  'jev.notConfigured': 'Not configured',
  'jev.source.env': 'process environment',
  'jev.source.file': 'DSH credential store',
  'jev.source.project-env': 'workspace .env',
  'jev.source.user-env': 'DSH_HOME/.env',
  'jev.readOnly': 'Supplied by the process environment variable {ref}; not editable here',
  'jev.fallback': '{ref} from {source}; a key saved here takes precedence, and removing it means editing that file',
  'jev.unavailable': 'The host has no credential store; keys cannot be saved',
  'jev.placeholder': 'Paste API key',
  'jev.inputLabel': '{service} API key',
  'jev.save': 'Save',
  'jev.replace': 'Replace',
  'jev.clear': 'Remove',
  'jev.invalid': 'A key is {min}–{max} characters with no whitespace.',
  'jev.note': 'Keys are kept in the DSH credential store, sent only to the host and never shown again; with both services configured, TypeSafe is used.',
}

/** Stable keys consumed through the framework `t` seat. */
export type SieveKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The sieve panel's copy. */
    sieve: SieveKey
  }
}
