import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'style.css'), 'utf8')

describe('style.css', () => {
  // button.primary sets display, which beat the browser's own [hidden] rule: the export dialog showed
  // "Enable Docker access and export" (new keys, a restart) to sandboxes that already had Docker access
  it('hidden always hides, whatever display a class sets', () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/)
  })
  it('ember is the primary colour', () => {
    expect(css).toMatch(/button\.primary[^{]*\{[^}]*background:\s*#ea580c/)
  })
  it('no Google blue, no Google Sans', () => {
    expect(css).not.toMatch(/#1a73e8|#0b57d0|Google Sans/i)
  })
  it('the console font stack', () => {
    expect(css).toContain('Inter, Roboto, "Segoe UI", system-ui, sans-serif')
  })
  it('the old topbar navigation is gone', () => {
    expect(css).not.toMatch(/\.subnav|\.topbar nav/)
  })
  it('the collapsed rail and the mobile overlay exist', () => {
    expect(css).toContain('body.rail-collapsed')
    expect(css).toContain('body.rail-open')
  })
  it('reduced motion still stops the embers', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.status::before/)
  })
  // Moved off screen is not enough: Tab would walk through links nobody sees
  it('the closed slide-in menu is out of the keyboard order too', () => {
    const narrow = /@media \(max-width: 800px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(narrow).toMatch(/\.rail \{[^}]*visibility: hidden/)
    expect(narrow).toMatch(/body\.rail-open \.rail \{[^}]*visibility: visible/)
  })
})
