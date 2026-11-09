# Put your app online with any agent

For Codex, Cursor, Claude Code without the plugin, or any agent that can run commands on your computer. Your project gets a small `.p9m` folder from Purgatorium; the agent uses it to build and run your app in your sandbox, and gives you its link.

**What you need:** the agent, [Docker](https://docs.docker.com/get-docker/) installed on your computer, and a Purgatorium account.

## 1. Get the `.p9m` folder

Users have no web UI in Purgatorium, so the folder comes one of two ways:

- **With Claude Code, once:** in your app's folder, [`/p9m:init <address>`](https://csakaszamok.github.io/p9m/0.20/tutorials/claude-code/index.md) makes you a sandbox and writes the `.p9m` folder. From then on any agent can use the folder; Claude Code is not needed any more.
- **From the admin:** they open your sandbox in Purgatorium and download its zip (**Let your agent deploy…** → **Download**), `p9m-<sandbox>.zip`, and give it to you. Save it in your Downloads.

Either way it holds a token for this sandbox and its keys: treat it like a password. Do not email it or commit it.

## 2. Hand it to the agent

Open your app's folder with the agent and say:

> Deploy this app to my p9m sandbox.

With a zip, say where it is: *Set up the p9m zip from my Downloads in this project and deploy.* The agent unpacks it into a `.p9m` folder in your project and deletes the zip. Then it builds your app in the sandbox, starts it and gives you its link. The `.p9m` folder keeps itself out of git on its own (it has its own `.gitignore`); leave it there, the agent uses it for every later update.

If the agent does not know what to do, point it to the instructions inside: *read .p9m/README.md and deploy this app to my sandbox*.

## 3. Update

Changed something? *Update the app in my sandbox.* The same link shows the new version.

## Good to know

- The folder's token expires in 90 days. Then run `/p9m:init <address> <sandbox>` in Claude Code again, or ask the admin for a new zip.
- Lost the folder or the zip, or someone else got it? Tell the admin: they can make the old keys useless (**Rotate Docker keys…**) and revoke its token.
- Sleep and wake work the same as with Claude Code: see [Good to know](https://csakaszamok.github.io/p9m/0.20/tutorials/claude-code/#good-to-know) there.

For agent builders: everything the agent does is in the [agent guide](https://csakaszamok.github.io/p9m/0.20/agent-guide/index.md).
