// The New sandbox dialog in a real browser: Create, then the row and the panel show a ticking stopwatch, no script
// error, the sandbox runs, and its Details say how long the create took. Run by tests/browser.sh (P9M_UI, P9M_PASSWORD;
// TARGET_IP: where *.lvh.me goes). Prints `created <name>` for the cleanup.
import { chromium } from 'playwright'

const url = process.env.P9M_UI ?? 'http://p9m.lvh.me'
const fail = msg => { console.log(`FAIL: ${msg}`); process.exit(1) }
const pass = msg => console.log(`PASS: ${msg}`)

const browser = await chromium.launch({ args: ['--no-proxy-server', `--host-resolver-rules=MAP *.lvh.me ${process.env.TARGET_IP ?? '127.0.0.1'}`] })
const page = await browser.newPage({ ignoreHTTPSErrors: true })
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('requestfailed', r => { if (r.url().endsWith('/sandboxes') && r.method() === 'POST') errors.push(`POST /sandboxes: ${r.failure()?.errorText}`) })

await page.goto(`${url}/login`)
await page.fill('input[name=username]', 'admin')
await page.fill('input[name=password]', process.env.P9M_PASSWORD ?? '')
await page.click('button.primary.wide')
await page.waitForSelector('[data-new]')
await page.click('[data-new]')
await page.waitForFunction(() => document.querySelector('[data-new-form] input[name=name]')?.value && document.querySelector('[data-templates] option'))
await page.selectOption('[data-templates]', 'starter')
const name = await page.inputValue('[data-new-form] input[name=name]')
console.log(`created ${name}`)
await page.click('[data-new-form] button[value=create]')

const row = () => page.locator(`tr[data-name$="-${name}"] td:nth-child(2)`).first().innerText().catch(() => '')
const panel = async () => (await page.locator('[data-panel]').innerText().catch(() => '')).replace(/\s+/g, ' ')
const secs = text => { const m = /(\d+):(\d\d)/.exec(text); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
await page.waitForTimeout(500)
const first = { row: await row(), panel: await panel() }
await page.waitForTimeout(2500)
const later = { row: await row(), panel: await panel() }
if (errors.length) fail(`script errors while creating: ${errors.join('; ')}`)
if (!/creating… \d+:\d\d/.test(first.row)) fail(`no stopwatch in its row: [${first.row}]`)
if (!/Creating… \d+:\d\d/.test(first.panel)) fail(`no stopwatch in its panel: [${first.panel}]`)
// Finished meanwhile (a fast server): nothing more to see ticking
if (/creating/i.test(later.row) && !(secs(later.row) > secs(first.row))) fail(`its stopwatch does not tick: [${first.row}] → [${later.row}]`)
pass(`a stopwatch in its row and its panel: [${first.row}] → [${later.row}]`)

await page.waitForFunction(n => [...document.querySelectorAll('tr[data-name]')].some(r => r.dataset.name.endsWith(`-${n}`) && /running/.test(r.innerText)), name, { timeout: 300000 })
if (errors.length) fail(`script errors: ${errors.join('; ')}`)
pass('it runs')
await page.waitForSelector('[data-tab=settings]', { timeout: 30000 }).catch(async () => fail(`its panel did not open: [${await panel()}]`))
await page.click('[data-tab=settings]')
const details = (await page.locator('[data-tabpanel=settings]').innerText()).replace(/\s+/g, ' ')
const took = /Created in (\d+ s|\d+ min( \d+ s)?)/.exec(details)
took ? pass(`its Details: Created in ${took[1]}`) : fail(`no Created in in its Details: [${details.slice(0, 200)}]`)
await browser.close()
