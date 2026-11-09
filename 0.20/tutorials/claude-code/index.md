# Put your app online with Claude Code

You have an app on your computer (a website, a dashboard, a small tool) and you want a link to it that works for anyone. Claude Code builds and runs it in your Purgatorium sandbox and gives you that link.

**What you need:** Claude Code (in a terminal, or the **Code** tab of the Claude desktop app), [Docker](https://docs.docker.com/get-docker/) installed on your computer, and a Purgatorium account.

## 1. Install the p9m plugin in Claude Code (once)

Open a terminal (in VS Code: **Terminal → New Terminal**; on Windows also PowerShell, on a Mac the Terminal app), paste these two lines one after the other and press Enter after each:

```
claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m
```

It installs the plugin for you, in all your projects. It asks for no address and no token. Purgatorium shows these lines too, once you sign in at its address.

Good to know

- `claude` not found? Claude Code is not installed for the terminal: see [Claude Code's setup](https://code.claude.com/docs/en/setup). An *unknown option* means an older Claude Code: run `claude update`.
- Already in Claude Code? The same two lines there are `/plugin marketplace add p9m-team/p9m` and `/plugin install p9m@p9m`. (The Claude Code panel in VS Code has no `/plugin`: use the terminal.)

You install the plugin once. Each project then gets its sandbox in the next step.

## 2. Get a sandbox for your project folder (once per folder)

A sandbox is your own small server: your app runs there, not on your computer. You get it from Claude Code; Purgatorium's web page is only for approving.

1. Open your app's folder in Claude Code: start `claude` in that folder, or open the folder in VS Code or the desktop app.

1. Type this into Claude Code, with your Purgatorium's address, and press Enter:

   ```
   /p9m:init https://p9m.example.com
   ```

1. Claude Code answers with a link and a code, for example:

   > Open **https://p9m.example.com/activate?code=TGMH-BSGQ** and approve the code **TGMH-BSGQ**.

1. Open the link in your browser and sign in. The page shows the code and what Claude Code asks for: *a new sandbox*. Check that the code is the same one Claude Code printed, then click **Create and approve**. Creating it takes up to a minute.

1. The page then shows another code, for example `KPRW-DMXT`. Copy it, paste it into Claude Code and press Enter. Claude Code says the folder is connected, and the sandbox's name (like `k3x9q2`). That is all.

Approve only your own code

Approve a code only if you just ran `/p9m:init` yourself and Claude Code shows that same code. If someone sends you a link like this, do not approve it, and never give anyone the code the page shows after **Approve**: whoever has it gets into your sandbox. Click **Deny** instead.

What happened behind the scenes: Claude Code got a token for this one sandbox and the sandbox's Docker keys, and wrote them into a `.p9m` folder in your project. You never see or copy them. The folder is secret, and it keeps itself out of git on its own: leave it there. The token works for 90 days (then run `/p9m:init` again with the sandbox's name, see below).

If something goes wrong

- **The code ran out:** it works for 10 minutes and only once. Run the same `/p9m:init` line again for a new code.
- **You clicked Deny by mistake:** run `/p9m:init` again.
- **A wrong code pasted:** Claude Code asks again; after 5 wrong ones, run `/p9m:init` again.
- **The sandbox could not be created:** the page says why, often that you have as many sandboxes running as you may. Let one sleep (*let my other sandbox sleep*, in its project folder) and click **Create and approve** again.
- **The folder was connected already:** `/p9m:init` there only checks that the connection works (and wakes the sandbox if it sleeps); it makes a new one only when that one is broken, and asks first. For another sandbox it asks before it replaces the connection.

## 3. Deploy

In the same folder, say in your own words:

> Deploy this app.

Claude Code wakes the sandbox, builds your app there, starts it and checks that it answers. At the end it gives you a link like `https://shop-web.example.com` (your sandbox's name first). Open it: that is your app, and it works for anyone you send it to.

## 4. Change and update

Changed something? Say:

> Update the app.

The same link shows the new version a few seconds later.

## Good to know

- **Sleep:** when nobody uses the app for a while (30 minutes by default), the sandbox sleeps to free the server. The next visit wakes it in a few seconds: the visitor sees *waking up* and then your app. Nothing is lost.
- **Sleep later:** *let it sleep only after 2 hours without visitors* works too (*never sleep* as well).
- **It does not answer?** Ask Claude Code *why does my app not answer?*: it reads the app's logs in the sandbox. The usual cause is an app that listens only on `localhost`; Claude Code fixes that.
- **Only for you or your colleagues?** Say *make it visible only to me* (or *only to my colleagues*): Claude Code sets `p9m.access` ([App access](https://csakaszamok.github.io/p9m/0.20/app-access/index.md)), and opening the link then asks the visitor to sign in to Purgatorium.
- **Docker is needed on your computer** only for its command line: the build runs in the sandbox.

## More projects

Each folder is tied to one sandbox by its own `.p9m` folder, so different folders can use different sandboxes, even on different Purgatorium servers. For another folder, do step 2 there: a new sandbox for it. The plugin needs no new setup.

To use a sandbox you already have, add its name: `/p9m:init https://p9m.example.com k3x9q2`. The page then asks for access to that sandbox (only one of your own), and it works the same way. This is how you move a folder to another sandbox, or connect a folder again after 90 days: Claude Code asks, then replaces the connection.

A new sandbox comes from Purgatorium's default template. For another one, name it: `/p9m:init https://p9m.example.com --template <template>`.

Used the earlier plugin, which asked for an address and a token? Run `/plugin marketplace update p9m` once, then `/p9m:init` in each project.

Installed the plugin when it was called `p7y` (`/p7y:init`)? Claude Code knows that one by its old name, and `/plugin marketplace update p9m` finds nothing. Remove it and add the new one, in a terminal, in the folder where you installed it:

```
claude plugin uninstall p7y@p7y --scope local
claude plugin marketplace remove p7y
claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m
```

`--scope` is where you installed it (`claude plugin list` shows it: `user`, `project` or `local`); a `local` one only from its own folder. Then start Claude Code again.

More details: [Claude Code plugin](https://csakaszamok.github.io/p9m/0.20/claude-plugin/index.md).
