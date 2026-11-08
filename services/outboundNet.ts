import net from 'node:net'

/** Node gives each address of a host this long to connect before it tries the next one, and fails when all ran out. */
const CONNECT_ATTEMPT_MS = 2000

/**
 * Node's default is 250 ms per address: on a network slower than that, every outbound fetch (the sign-in provider's
 * too) fails with ETIMEDOUT though the host answers. A larger value set by the operator (NODE_OPTIONS) stays.
 */
export function raiseConnectTimeout(): void {
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_MS) net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS)
}

/** An error for the log: a failed fetch says only "fetch failed", its cause says why (ETIMEDOUT, ENOTFOUND…). */
export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined
  const why = cause?.code ?? cause?.message
  return why ? `${err.message} (${String(why)})` : err.message
}
