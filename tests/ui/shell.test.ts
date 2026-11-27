import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const S = createRequire(import.meta.url)('../../ui/shell.js')

describe('searchTarget: where the app bar search goes', () => {
  it('the sandbox lists filter in place', () => {
    expect(S.searchTarget('shop', 'mine')).toBeNull()
    expect(S.searchTarget('shop', 'all')).toBeNull()
  })
  it('elsewhere, to My sandboxes, encoded', () => {
    expect(S.searchTarget(' a&b #c ', 'tokens')).toBe('/?q=a%26b%20%23c')
    expect(S.searchTarget('x', 'overview')).toBe('/?q=x')
  })
  it('nothing typed, nowhere', () => {
    expect(S.searchTarget('   ', 'overview')).toBeNull()
  })
})

describe('shell.js', () => {
  it('is served', async () => {
    const asset = (await import('../../routes/assets/[file]/GET')).default
    const res = await asset(new Request('http://x/assets/shell.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
  })
})
