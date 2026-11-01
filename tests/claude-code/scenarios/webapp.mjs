// A user asks Claude Code to build a small web app from nothing and put it online.
const marker = run => `made-by-claude-${run}`

export default {
  name: 'webapp',
  title: 'A web app from nothing, online',
  files: () => ({ 'README.md': '# Tip calculator\n\nNothing here yet.\n' }),
  async run(h) {
    await h.init()
    await h.step('"build a web app and put it online"', () => h.claude(
      `Build a small tip calculator web app in this folder: one page where I enter the bill, the tip in percent and ` +
      `the number of people, and it shows the tip and the total per person. Put "${marker(h.run)}" in its footer. ` +
      `Then put it online in my Purgatorium sandbox, so that anyone with the link can open it.`))
    const url = await h.step('the app answers at its address', async () => {
      const u = await h.findApp(await h.apps(), body => body.includes(marker(h.run)))
      if (!u) h.fail('no app serves the page with its footer (not public, or not this app)')
      h.note(`${u} serves the tip calculator`)
      return u
    })
    await h.screenshot(url, 'The tip calculator, online')
  },
}
