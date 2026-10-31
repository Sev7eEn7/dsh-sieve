/**
 * The rule half of Jev approval: which calls need permission at all, which
 * commands deserve a second look, and which are never approved for the user.
 * The judge only weighs what these rules pass to it.
 *
 * Wrong in the safe direction only: a tool nobody listed needs permission, a
 * command counts as only looking when every part of it is on the short
 * read-only list, and a path counts as inside the project only when it really
 * is, links followed.
 *
 * The risk flags and the reading of paths are ported from mu
 * `packages/kyrn-judge/src/extension/features/guard.ts` and
 * `packages/kyrn-judge/src/permissions/modes.ts`, with DSH's tool names in
 * place of pi's and without pi's conversation grants (DSH approvals are
 * allowed once). The credential rule is new in sieve (harness plan §4 phase 3).
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandOf, isMutatingCall, isReadOnlyCommand, isShellTool } from '../monitor/mutating.ts'

const RULES: readonly (readonly [RegExp, string])[] = [
  [/\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]/, 'recursive or forced delete'],
  // find deletes what it finds with -delete, or with rm run on each.
  [/\bfind\b[^|;&\n]*\s-(?:delete\b|(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?rm\b)/, 'recursive or forced delete'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/, 'discards git work'],
  // The same deeds spelled otherwise: clean forced by a later option, a checkout of everything or by force, a
  // restore of the working tree, a branch deleted by force.
  [
    /\bgit\s+(?:clean\b[^|;&\n]*\s(?:-[a-zA-Z]*f|--force)\b|checkout\s+(?:\.(?:\s|$)|-f\b|--force\b)|restore\b(?:(?![^|;&\n]*--staged)|(?=[^|;&\n]*(?:--worktree|\s-W\b)))|branch\b[^|;&\n]*(?:--delete\s+--force|--force\s+--delete|\s-(?:D|df|fd)\b))/,
    'discards git work',
  ],
  [/\bgit\s+push\b.*(--force|\s-f\b)/, 'force push'],
  // A `+` refspec forces as well; --mirror, --delete and `:branch` remove what is on the remote.
  [/\bgit\s+push\b[^|;&\n]*\s(?:\+\S|--mirror\b|--delete\b|-d\b|:\S)/, 'force push'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'drops database objects'],
  [/\bmkfs\b|\bdd\b.*\bof=\/dev\//, 'overwrites a device'],
  [/\bchmod\s+-R\s+0?777\b/, 'opens permissions recursively'],
  // The same deeds in PowerShell and cmd.
  [/\b(Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^|;\n]*(-Recurse|-Force|-r\b|-rf\b|\/s\b|\/q\b)/i, 'recursive or forced delete'],
  [
    /\b(Invoke-Expression|iex)\b[^|;\n]*\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|DownloadString)\b|\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^|;\n]*\|\s*(Invoke-Expression|iex)\b/i,
    'runs a downloaded script',
  ],
  [/\bStart-Process\b[^|;\n]*-Verb\s+RunAs\b|\brunas\b/i, 'runs as administrator'],
  [/\bformat\s+[a-z]:|\bFormat-Volume\b|\bClear-Disk\b/i, 'overwrites a device'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(?:(?:ba|z|da|k)?sh|python\d*|perl|ruby|node)\b/, 'runs a downloaded script'],
  // Without a pipe: a download read as a file (`bash <(curl …)`) or as the text of `sh -c "$(curl …)"`.
  [/<\(\s*(?:curl|wget)\b|\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/, 'runs a downloaded script'],
  [/\b(?:sudo|doas|pkexec)\b/, 'runs as root'],
]

/**
 * The command as the shell reads its words: `r\m` is `rm`, and so are `"rm"` and `r''m`. Only for matching the rules,
 * which also see the command as it was written.
 */
function unquoted(command: string): string {
  return command.replace(/\\(?=[A-Za-z])/g, '').replace(/(["'])([^"'\s]*)\1/g, '$2')
}

/** Something that talks to another machine. */
const NETWORK
  = /(?:^|[\s|;&(`$'"])(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|tftp|telnet|rsync|ssh|http|https|xh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?![\w-])|\/dev\/(?:tcp|udp)\/|\b(?:python\d*|node|deno|bun|ruby|perl|php)\b[^|;&\n]*(?:requests|urllib|http\.client|fetch\(|net\/http|socket|LWP|curl_)/i

/** A secret held in a variable, as a command expands it. */
const SECRET_VARIABLE = /\$\{?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*\}?/i

/**
 * Where credentials are kept, or a program that prints them. A key named with
 * `-i`, or a `.env` loaded into the shell, is how a credential is used, not
 * sent: those are taken out first (`usedNotSent`).
 */
const CREDENTIAL_SOURCE = new RegExp([
  String.raw`\.ssh\/(?!known_hosts\b|config\b)`,
  String.raw`\bid_(?:rsa|ed25519|ecdsa|dsa)\b`,
  String.raw`\.aws\/credentials\b`,
  String.raw`\.(?:netrc|git-credentials|npmrc|pypirc)\b`,
  String.raw`\.docker\/config\.json\b`,
  String.raw`\.kube\/config\b`,
  String.raw`\.config\/gh\/hosts\.yml\b`,
  String.raw`\.gnupg\/`,
  String.raw`(?:^|[\s/'"=@<])\.env(?:\.[\w-]+)?(?![\w.-])`,
  String.raw`\/proc\/(?:self|\d+)\/environ\b`,
  String.raw`\bprintenv\b`,
  String.raw`(?:^|[|;&(]\s*)env\s*(?:$|[|>;&)])`,
  String.raw`\bsecurity\s+find-(?:generic|internet)-password\b`,
  String.raw`\bgh\s+auth\s+token\b`,
  String.raw`\baws\s+configure\s+(?:get|export-credentials)\b`,
  String.raw`\bgcloud\s+auth\s+print-(?:access|identity)-token\b`,
].join('|'), 'i')

/** `ssh -i KEY`, `IdentityFile=KEY`, `source .env`: a credential used where it is, which the rule must not read as one sent. */
function usedNotSent(command: string): string {
  return command
    .replace(/(?:^|\s)(?:-i|--identity(?:-file)?|-o\s*IdentityFile=)\s*\S+/gi, ' ')
    .replace(/(?:^|[;&|(]\s*)(?:source|\.|dotenv)\s+\S*\.env\S*/gi, ' ')
}

/**
 * The hard rule: a command that reads credentials and talks to another
 * machine is never approved for the user, whatever the judge would say.
 * Undefined when the rule does not apply.
 */
export function sendsCredentials(command: string): string | undefined {
  const plain = unquoted(command)
  const sends = NETWORK.test(command) || NETWORK.test(plain)
  if (!sends) return undefined
  const reads = [command, plain].some(text => CREDENTIAL_SOURCE.test(usedNotSent(text)))
  return reads ? 'sends credentials to another machine' : undefined
}

/** Why a shell command deserves a second look, or undefined when no rule matches. */
export function riskFlag(command: string): string | undefined {
  const plain = unquoted(command)
  const rule = RULES.find(([pattern]) => pattern.test(command) || pattern.test(plain))?.[1]
  if (rule !== undefined) return rule
  return SECRET_VARIABLE.test(command) && (NETWORK.test(command) || NETWORK.test(plain)) ? 'sends a secret over the network' : undefined
}

/** What each flag says to a person reading Chinese. The judge and the model read the English. */
export const FLAG_ZH: Readonly<Record<string, string>> = {
  'recursive or forced delete': '递归或强制删除',
  'discards git work': '丢弃 git 里的改动',
  'force push': '强制推送',
  'drops database objects': '删除数据库对象',
  'overwrites a device': '覆盖整个设备',
  'opens permissions recursively': '递归放开权限',
  'runs a downloaded script': '运行下载来的脚本',
  'runs as administrator': '以管理员身份运行',
  'runs as root': '以 root 身份运行',
  'sends a secret over the network': '把密钥发往网络',
  'sends credentials to another machine': '把凭据发到别的机器',
}

/** What a call that needs permission is. */
export type PermissionKind = 'edit' | 'shell' | 'outside' | 'delegate' | 'other'

export interface PermissionNeed {
  readonly kind: PermissionKind
  /** One line a person can read: the command, the path, the tool and its main argument. */
  readonly summary: string
  /** Never approved by Jev: the user decides, every time. The protected folder it touches. */
  readonly protected?: string
  /** In the project folder (edits): the one thing Jev approval lets through without a judgment. */
  readonly inProject?: boolean
}

/** DSH tools that write the file they are given, and where each takes its path. */
const EDITING: ReadonlyMap<string, string> = new Map([['write', 'file_path'], ['edit', 'file_path'], ['str_replace_editor', 'path']])

/** Tools that start other agents. */
const DELEGATING: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'create_worktree', 'hive'])

/** Agent bookkeeping that changes no file and reaches nothing outside DSH. */
const BOOKKEEPING: ReadonlySet<string> = new Set(['update_goal', 'wait_agent', 'send_message', 'interrupt_agent', 'team_task_create', 'team_task_update'])

const text = (value: unknown): string => typeof value === 'string' ? value : ''

const clip = (value: string, length: number): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= length ? line : `${line.slice(0, length - 1)}…`
}

/** The path with links resolved as far as it exists, a link to a place that does not exist yet included. */
function realPath(path: string, depth = 0): string {
  try {
    return realpathSync.native(path)
  } catch {
    if (depth < 40) {
      try {
        // Writing through such a link creates the file where it points.
        if (lstatSync(path).isSymbolicLink()) return realPath(resolve(dirname(path), readlinkSync(path)), depth + 1)
      } catch {
        // Nothing there at all.
      }
    }
    const parent = dirname(path)
    return parent === path ? path : join(realPath(parent, depth + 1), basename(path))
  }
}

const UNICODE_SPACES = /[  -   　]/g

/**
 * Where a file tool will really write, or undefined when it cannot be read as
 * a path. One leading `@` is dropped, `~` is the home and a `file://` URL is a
 * path, so `~/.zshrc` is never a folder called `~` inside the project. Links
 * are then followed as far as the path exists.
 */
export function toolPath(cwd: string, raw: string, home: string = homedir()): string | undefined {
  let path = raw.replace(UNICODE_SPACES, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (path === '~') path = home
  else if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) path = join(home, path.slice(2))
  else if (/^file:\/\//.test(path)) {
    try {
      path = fileURLToPath(path)
    } catch {
      return undefined
    }
  }
  return realPath(isAbsolute(path) ? resolve(path) : resolve(cwd, path))
}

/** `target` relative to the project, or undefined when it is not inside it. */
function inProject(cwd: string, target: string | undefined): string | undefined {
  if (target === undefined) return undefined
  const rel = relative(realPath(resolve(cwd)), target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel
}

/**
 * A file of the project, which Jev approval edits without asking: inside the folder, and not git's own. Git runs its
 * hooks and reads its config on the user's next git command, and a checkpoint never holds them.
 */
function projectFile(cwd: string, target: string | undefined): boolean {
  const rel = inProject(cwd, target)
  return rel !== undefined && !rel.split(/[\\/]/).some(part => part.toLowerCase() === '.git')
}

/**
 * DSH's own folders, which a call may only touch with the user's word: a
 * profile there can switch approval off. Mirrors `resolveDshHome` and
 * `resolveAgentsHome` of `@deepseek-ai/dsh-home-paths`: the variable when set
 * and not blank, else the default under the home.
 */
export function harnessFolders(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string[] {
  const root = (name: string, fallback: string): string => {
    const value = env[name]?.trim()
    return resolve(value === undefined || value === '' ? join(home, fallback) : value)
  }
  return [root('DSH_HOME', '.dsh'), root('DSH_AGENTS_HOME', '.agents')]
}

/** A folder as a command may spell it: as it is, from `~` and from `$HOME`. */
export function spellings(folder: string, home: string = homedir()): string[] {
  return folder.startsWith(`${home}${sep}`) ? [folder, `~${folder.slice(home.length)}`, `$HOME${folder.slice(home.length)}`] : [folder]
}

/**
 * Whether a call needs permission, and what it is. Undefined for a call that
 * only looks, or only does an agent's own bookkeeping.
 * @param cwd - the session's working directory; undefined counts every edit as outside the project.
 * @param protectedFolders - folders whose every touch is the user's to allow (`harnessFolders`).
 */
export function permissionNeed(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
  protectedFolders: readonly string[] = [],
): PermissionNeed | undefined {
  // Without regard to case: Windows and macOS name a folder in any case, and more protection is the safe direction.
  const spelled = protectedFolders.flatMap(folder => spellings(folder))
  const touches = (value: string): string | undefined => {
    const said = value.toLowerCase()
    return spelled.find(path => said.includes(path.toLowerCase()))
  }
  if (isShellTool(toolName)) {
    const command = commandOf(input)
    const guarded = touches(command)
    if (guarded === undefined && isReadOnlyCommand(command, toolName === 'pwsh')) return undefined
    return { kind: 'shell', summary: clip(command, 300), ...guarded === undefined ? {} : { protected: guarded } }
  }
  if (!isMutatingCall(toolName, input) || BOOKKEEPING.has(toolName)) return undefined
  const pathKey = EDITING.get(toolName)
  if (pathKey !== undefined) {
    if (toolName === 'str_replace_editor' && text(input['command']) === 'view') return undefined
    const path = text(input[pathKey])
    const summary = clip(`${toolName} ${path}`, 300)
    const target = cwd === undefined ? undefined : toolPath(cwd, path)
    const guarded = [path, ...target === undefined ? [] : [target]].map(touches).find(found => found !== undefined)
    if (guarded !== undefined) return { kind: 'edit', summary, protected: guarded }
    return cwd !== undefined && projectFile(cwd, target) ? { kind: 'edit', summary, inProject: true } : { kind: 'outside', summary }
  }
  if (DELEGATING.has(toolName)) {
    const title = text(input['goal']) || text(input['task']) || text(input['prompt']) || text(input['description'])
    return { kind: 'delegate', summary: clip(`${toolName} ${title}`, 300) }
  }
  const main = text(input['url']) || text(input['action']) || text(input['query']) || text(input['task']) || JSON.stringify(input)
  const guarded = touches(JSON.stringify(input))
  return { kind: 'other', summary: clip(`${toolName} ${main}`, 300), ...guarded === undefined ? {} : { protected: guarded } }
}
