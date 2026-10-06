/** Bounded waits for DSH extension points; an uncooperative backend may finish later. */
export async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); resolve(undefined) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function deadline(signal: AbortSignal, ms: number): { signal: AbortSignal, dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('sieve decision deadline')), ms)
  return { signal: AbortSignal.any([signal, controller.signal]), dispose: () => clearTimeout(timer) }
}
