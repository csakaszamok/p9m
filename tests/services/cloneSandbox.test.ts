import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain .mjs script
import { unpackScript } from '../../scripts/clone-sandbox.mjs'

// Running the script against a volume is covered by tests/clone-sandbox.sh (e2e)
describe('the script that loads a copied volume', () => {
  const script: string = unpackScript()

  it('extracts with the attributes, owners and modes the copy was made with', () => {
    expect(script).toContain("'--xattrs' '--xattrs-include=*' '--numeric-owner'")
    expect(script).toContain('-xzf - -C /data')
  })

  it('then drops device nodes other than the 0:0 whiteout', () => {
    expect(script).toContain(`find /data \\( -type b -o -type c \\) -exec sh -c 'for f; do [ "$(stat -c %t:%T "$f")" = 0:0 ] || rm -f "$f"; done' _ {} +`)
    expect(script.indexOf('stat -c')).toBeGreaterThan(script.indexOf('-xzf'))
  })
})
