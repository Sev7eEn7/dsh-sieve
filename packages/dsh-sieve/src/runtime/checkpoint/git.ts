/**
 * Running git for the shadow snapshots: no shell, an argument array, a time
 * limit, an abort signal, and an environment with the agent's `GIT_*` and
 * secrets taken out.
 *
 * Ported from mu `packages/kyrn-judge/src/checkpoint/git.ts`; sieve adds the
 * abort signal and drops secret-looking variables from git's environment.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** Output stopped at `OutputLimit.maxEntries` and git was ended: `stdout` holds only the first entries. */
  readonly truncated?: boolean
}

/** How much NUL-separated output (`-z`) is wanted at most. A listing of a huge folder is cut off there. */
export interface OutputLimit {
  readonly maxEntries: number
}

/** The exit code a command gets when it outlived the runner's time limit. */
export const TIMED_OUT = 124

/**
 * Runs git with exactly this environment. Injected into the store so its
 * logic is tested without caring how a process is started, and so a test can
 * stand in for a machine without git.
 */
export type GitRun = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  input?: string,
  limit?: OutputLimit,
) => Promise<GitResult>

/** git is not installed, or could not be started. The feature says so once and stays quiet. */
export class GitMissing extends Error {
  constructor(binary: string, cause?: unknown) {
    super(`"${binary}" could not be started`, { cause })
    this.name = 'GitMissing'
  }
}

/**
 * Why git is there and still cannot run, on macOS, where git comes with
 * Apple's developer tools:
 * - `xcode_license`: an Xcode whose license nobody has accepted yet. Every git exits 69 and says so.
 * - `developer_tools_missing`: no developer tools at all. /usr/bin/git is then a stub that opens the
 *   system dialog offering to install them, each time it runs, and fails.
 */
export type GitUnusableReason = 'xcode_license' | 'developer_tools_missing'

/** git cannot run on this machine as it is. The feature says so once and stays quiet, as without git. */
export class GitUnusable extends Error {
  readonly reason: GitUnusableReason
  constructor(reason: GitUnusableReason, message: string) {
    super(message)
    this.name = 'GitUnusable'
    this.reason = reason
  }
}

/** A git command that ran and failed. */
export class GitFailed extends Error {
  readonly result: GitResult
  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args[0] ?? ''} exited with ${result.code}: ${result.stderr.trim().slice(0, 300)}`)
    this.name = 'GitFailed'
    this.result = result
  }
}

/** What is looked at before git first starts (`stubProblem`). Tests stand in for a Mac here. */
export interface GitProbe {
  readonly platform: NodeJS.Platform
  /** The file `binary` is on this PATH, as spawn finds it. */
  find(binary: string, path: string | undefined): string | undefined
  /** Whether `xcode-select -p` names a developer folder that is there. It opens no dialog when there is none. */
  hasDeveloperTools(): Promise<boolean>
}

/** The first executable file called `binary` in the folders of `path`, or `binary` itself when it is a path. */
export function findOnPath(binary: string, path: string | undefined): string | undefined {
  const candidates = binary.includes('/')
    ? [binary]
    : (path ?? '').split(delimiter).filter(Boolean).map(folder => join(folder, binary))
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

export const hostProbe: GitProbe = {
  platform: process.platform,
  find: findOnPath,
  hasDeveloperTools: () => new Promise((done) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }, (error, stdout) => done(error === null && existsSync(stdout.trim())))
  }),
}

/** Where macOS itself puts git: a stub that runs the developer tools' git, or offers to install them. */
const MAC_STUB = '/usr/bin/git'
/** EX_UNAVAILABLE, the exit of every developer tool until the Xcode license is accepted. */
const XCODE_LICENSE_EXIT = 69

/**
 * Why `binary` must not be started, found before it ever is: on a Mac, a git
 * that is the system's stub with no developer tools behind it opens their
 * install dialog at each start. Undefined when it may run.
 */
export async function stubProblem(binary: string, path: string | undefined, probe: GitProbe = hostProbe): Promise<GitUnusable | undefined> {
  if (probe.platform !== 'darwin' || probe.find(binary, path) !== MAC_STUB) return undefined
  if (await probe.hasDeveloperTools()) return undefined
  return new GitUnusable('developer_tools_missing', `${MAC_STUB} needs the developer tools, which are not installed`)
}

/** Whether a git that ran was held back by the Xcode license rather than failing at its command. */
export function heldByLicense(code: number, output: () => string): boolean {
  return code === XCODE_LICENSE_EXIT && /licen[cs]e/i.test(output())
}

/** Why checkpoints are off when git cannot run on this Mac. Only the user can change it, in a system dialog or with sudo. */
export const UNUSABLE_TEXT: Readonly<Record<GitUnusableReason, string>> = {
  developer_tools_missing: 'git cannot run on this Mac: Apple\'s command line developer tools are not installed',
  xcode_license: 'git cannot run on this Mac until the Xcode license is accepted',
}

/**
 * The real runner. A command that outlives `timeoutMs`, or whose `signal`
 * aborts, is killed and reported as failed, so a huge project costs a turn
 * its checkpoint rather than its start. With a `limit`, git is ended as soon
 * as its output holds more entries than that, and only those are kept.
 *
 * Before git first runs on a Mac, the probe checks that it is no stub without
 * the developer tools behind it: that git is never started, since each start
 * opens the system's install dialog again. A git held back by the Xcode
 * license is reported as such, not as a command that failed.
 */
export function spawnGit(binary = 'git', timeoutMs = 30_000, signal?: AbortSignal, probe: GitProbe = hostProbe): GitRun {
  let stub: Promise<GitUnusable | undefined> | undefined
  return async (args, env, input, limit) => {
    stub ??= stubProblem(binary, env['PATH'], probe)
    const problem = await stub
    if (problem !== undefined) throw problem
    const result = await spawnOnce(binary, timeoutMs, signal, args, env, input, limit)
    if (heldByLicense(result.code, () => `${result.stderr}\n${result.stdout}`)) {
      throw new GitUnusable('xcode_license', `git ${args[0] ?? ''} exited with 69: ${result.stderr.trim().slice(0, 300)}`)
    }
    return result
  }
}

function spawnOnce(
  binary: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  input?: string,
  limit?: OutputLimit,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    signal?.throwIfAborted()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, [...args], { env: { ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new GitMissing(binary, error))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let stopped: string | undefined
    let entries = 0
    let truncated = false
    const stop = (why: string): void => {
      stopped ??= why
      child.kill()
    }
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs)
    timer.unref()
    const abort = (): void => stop('aborted')
    signal?.addEventListener('abort', abort, { once: true })
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return
      out.push(chunk)
      if (limit === undefined) return
      for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, at + 1)) entries++
      if (entries > limit.maxEntries) {
        truncated = true
        child.kill()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      settle()
      reject(new GitMissing(binary, error))
    })
    child.on('close', (code) => {
      settle()
      if (truncated) {
        resolve({ code: 0, stdout: Buffer.concat(out).toString('utf8'), stderr: '', truncated: true })
        return
      }
      resolve({
        code: stopped !== undefined ? TIMED_OUT : (code ?? 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stopped ?? Buffer.concat(err).toString('utf8'),
      })
    })
    // A git that exits before reading its input must not take the process down with EPIPE.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

/** Variables whose names say they hold a secret: git has no use for them. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i

/**
 * The environment every shadow command runs in. Whatever `GIT_*` the agent
 * was started with is dropped first: inside a git hook `GIT_INDEX_FILE` points
 * at the user's real index, and one inherited variable would be enough to
 * make a snapshot write there. Secrets go too.
 */
export function shadowEnv(
  base: Readonly<Record<string, string | undefined>>,
  gitDir: string,
  workTree: string,
  indexFile = join(gitDir, 'index'),
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_') && !SECRET_NAME.test(key)) env[key] = value
  }
  return {
    ...env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
    // Snapshots are nobody's commits: no dependence on, and no trace of, the user's identity.
    GIT_AUTHOR_NAME: 'sieve',
    GIT_AUTHOR_EMAIL: 'sieve@localhost',
    GIT_COMMITTER_NAME: 'sieve',
    GIT_COMMITTER_EMAIL: 'sieve@localhost',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Paths are taken as they are: a file called "a[1].txt" or ":x" is not a pattern.
    GIT_LITERAL_PATHSPECS: '1',
  }
}
