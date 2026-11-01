import { getPrincipal } from './principal'
import { filesMaxUpload } from './sandboxFiles'

/** Every route's body is read into memory before it runs: this much at most, but for the Files upload */
export const DEFAULT_BODY_MAX = 2 * 1024 * 1024
const FILES_UPLOAD = /^\/sandboxes\/[^/]+\/files\/content$/

interface Deps { signedIn: (headers: Headers, path: string) => boolean; filesMax: () => number }
const defaults: Deps = {
  // From the headers alone, before the body is read: a session cookie or a token the routes would take
  signedIn: (headers, path) => getPrincipal(new Request(`http://localhost${path}`, { headers })) !== null,
  filesMax: filesMaxUpload,
}

/**
 * How much of a request's body to read. Only a signed-in Files upload gets FILES_MAX_UPLOAD (and a little more):
 * without a sign-in, parallel requests of that size each would run Purgatorium out of memory.
 */
export function bodyLimit(method: string, path: string, headers: Headers, deps: Partial<Deps> = {}): number {
  const d = { ...defaults, ...deps }
  if (method === 'PUT' && FILES_UPLOAD.test(path) && d.signedIn(headers, path)) return d.filesMax() + 1024 * 1024
  return DEFAULT_BODY_MAX
}
