import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const source = fs.readFileSync(path.join(process.cwd(), 'ui', 'activate.js'), 'utf8')

/** A fake element: what ui/activate.js reads and sets on one */
function el(props: Record<string, unknown> = {}) {
  const listeners: Record<string, (e: unknown) => unknown> = {}
  return {
    dataset: {} as Record<string, string>, textContent: '', children: [] as unknown[],
    addEventListener: (type: string, f: (e: unknown) => unknown) => { listeners[type] = f },
    fire: (type: string, e: unknown = {}) => listeners[type](e),
    appendChild(c: unknown) { this.children.push(c) },
    replaceChildren(...c: unknown[]) { this.children = c },
    ...props,
  }
}

/** ui/activate.js on a fake approval page: the form with its buttons, the confirmation code and its Copy */
function run(clipboard: (t: string) => Promise<void>, now: () => number = () => 0) {
  const actions = el()
  const form = el({ querySelector: (s: string) => s === '.actions' ? actions : null })
  const code = el({ textContent: 'BCDF-GHJK' })
  const copy = el({ dataset: { copyFrom: '[data-confirm]' }, textContent: 'Copy' })
  const select = { removeAllRanges: vi.fn(), addRange: vi.fn() }
  const document = {
    querySelectorAll: (s: string) => s === 'form[data-activate]' ? [form] : s === '[data-copy-from]' ? [copy] : [],
    querySelector: (s: string) => s === '[data-confirm]' ? code : null,
    createElement: () => el(),
    createRange: () => ({ selectNodeContents: vi.fn() }),
  }
  let tick: (() => unknown) | null = null
  vm.runInNewContext(source, { document, navigator: { clipboard: { writeText: clipboard } }, getSelection: () => select, setTimeout: () => 0, setInterval: (f: () => unknown) => { tick = f; return 1 }, Date: { now } })
  return { form, actions, copy, select, second: () => tick?.() }
}

describe('ui/activate.js', () => {
  it('a click swaps the buttons for a busy one and still sends the choice', () => {
    const { form, actions } = run(async () => {})
    form.fire('submit', { submitter: { name: 'decision', value: 'approve', dataset: { busy: 'Creating the sandbox…' } } })
    expect(form.children).toMatchObject([{ type: 'hidden', name: 'decision', value: 'approve' }])
    expect(actions.children).toMatchObject([{ className: 'busy', disabled: true, textContent: 'Creating the sandbox…' }])
  })

  it('the busy button counts the seconds waited', () => {
    let t = 0
    const { form, actions, second } = run(async () => {}, () => t)
    form.fire('submit', { submitter: { name: 'decision', value: 'approve', dataset: { busy: 'Creating the sandbox…' } } })
    t = 12_400; second()
    expect(actions.children).toMatchObject([{ textContent: 'Creating the sandbox… 12 s' }])
  })

  it('Copy puts the confirmation code on the clipboard, and selects it', async () => {
    const writeText = vi.fn(async () => {})
    const { copy, select } = run(writeText)
    await copy.fire('click')
    expect(writeText).toHaveBeenCalledWith('BCDF-GHJK')
    expect(copy.textContent).toBe('Copied')
    expect(select.addRange).toHaveBeenCalled()
  })

  it('no clipboard: the code is still selected for Ctrl+C', async () => {
    const { copy, select } = run(async () => { throw new Error('denied') })
    await copy.fire('click')
    expect(select.addRange).toHaveBeenCalled()
    expect(copy.textContent).toBe('Copy')
  })
})
