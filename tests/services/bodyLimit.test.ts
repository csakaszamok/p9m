import { describe, it, expect } from 'vitest'
import { bodyLimit, DEFAULT_BODY_MAX } from '../../services/bodyLimit'

// Every request's body is read into memory before its route runs: without a sign-in, a few dozen parallel requests
// of FILES_MAX_UPLOAD (100 MB) each would run Purgatorium out of memory. Only a signed-in upload gets the large limit.
const MB = 1024 * 1024
const deps = (signedIn: boolean) => ({ signedIn: () => signedIn, filesMax: () => 100 * MB })
const H = new Headers()

describe('how much of a request body is read', () => {
  it('2 MB at most for any route: no route but the Files upload takes more', () => {
    expect(DEFAULT_BODY_MAX).toBe(2 * MB)
    expect(bodyLimit('POST', '/sandboxes', H, deps(true))).toBe(2 * MB)
    expect(bodyLimit('POST', '/device/code', H, deps(false))).toBe(2 * MB)
    expect(bodyLimit('GET', '/sandboxes/p9m-a/files/content', H, deps(true))).toBe(2 * MB)
  })
  it('the Files upload: FILES_MAX_UPLOAD and a little more, signed in only', () => {
    expect(bodyLimit('PUT', '/sandboxes/p9m-a/files/content', H, deps(true))).toBe(101 * MB)
    expect(bodyLimit('PUT', '/sandboxes/p9m-a/files/content', H, deps(false))).toBe(DEFAULT_BODY_MAX)
    expect(bodyLimit('PUT', '/sandboxes/p9m-a/files/contentx', H, deps(true))).toBe(DEFAULT_BODY_MAX)
  })
  it('signed in: a session cookie or a token, as the routes check it', () => {
    expect(bodyLimit('PUT', '/sandboxes/p9m-a/files/content', new Headers({ authorization: 'Bearer nope' }))).toBe(DEFAULT_BODY_MAX)
  })
})
