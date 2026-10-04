/**
 * dsh-sieve: token-saving judgment plugins for DeepSeek Harness, ported from mu.
 *
 * P0 shell: an installable bundle with no behavior yet, used to verify loading,
 * packaging and session resume with sieve mounted. Features land in P1 and P2
 * (see docs/OPUS-5.5-MIGRATION-PLAN.md).
 *
 * sieve must not append its own Session event types: at the pinned DSH version
 * a stored log containing an unknown event without the `ignorable` envelope
 * marker refuses to resume, and `Session.append` cannot set that marker
 * (tests/contracts/plugin-event-restore.spec.ts). State is derived from native
 * events or kept in `ctx.storage`.
 * @module dsh-sieve
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'sieve'

export function apply(_ctx: Context): void {}
