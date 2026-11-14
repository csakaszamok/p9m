# Claude Code and Purgatorium on one page

Everything a user needs, from nothing to an app online and a conversation moved into the sandbox. Print it, or hand it out with your Purgatorium's address filled in. The longer walk-through: [Put your app online with Claude Code](https://csakaszamok.github.io/p9m/0.21/tutorials/claude-code/index.md).

**Your Purgatorium:** `https://p9m.example.com` (write yours here)

## Before you start (once)

1. **Claude Code in a terminal:** see [Claude Code's setup](https://code.claude.com/docs/en/setup). Check in a terminal: `claude --version`. (The desktop app alone is not enough for the next step: it needs the `claude` command.)
1. **Docker's command line:** [Docker Desktop](https://docs.docker.com/get-docker/), or only the CLI. Check: `docker --version`. Nothing runs on your computer: the command talks to your sandbox.
1. **A Purgatorium sign-in:** open your Purgatorium's address once and sign in.

## Install the plugin (once)

In a terminal:

```
claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m
```

Then **start Claude Code again**: one that was already running does not see the plugin.

`p9m-team/p9m` is the official marketplace (it points at Purgatorium's own repository). The sign-in page of your Purgatorium shows these lines too, under **Using Claude Code?**

Check (also good to do before a workshop): `claude plugin list` shows `p9m@p9m` with `Scope: user` and `Status: ✔ enabled`.

## Each project (once per folder)

Start `claude` in your project's folder, then:

```
/p9m:init https://p9m.example.com
```

Open the link it prints, check the code, click **Create and approve**, and paste the new code back into Claude Code. The folder now has its own sandbox. Running `/p9m:init` there again only checks that it still works.

## Then, in your own words

| Say                           | What happens                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- |
| *Deploy this app.*            | builds it in your sandbox, starts it, gives you its address                  |
| *Update it.*                  | after a change: deploys again, same address                                  |
| *Give it the address runner.* | a short address: `https://<sandbox>-runner.<domain>` instead of the long one |
| *Why does my app not answer?* | reads its logs in the sandbox and fixes the usual causes                     |
| *Let my sandbox sleep.*       | stops it; the next visit to the app wakes it                                 |
| `/p9m:teleport`               | moves this project and this conversation into your sandbox, to go on there   |

## Go on in the sandbox: `/p9m:teleport`

It shows what would move and asks about secret files (`.env`) one by one. At the end it gives you **a link**: open it, and Claude Code goes on in your browser, in the sandbox, in the project's folder, with the conversation (sign in to Purgatorium if it asks). The first time it asks you to sign in to Claude once.

From a terminal instead, the command it gives too (on Windows in PowerShell or Windows Terminal):

```
docker --context p9m-<sandbox> exec -it -w /home/agent/workspace/<project> claude claude --resume <id>
```

Bring work back with git (commit and push there, pull here).

## If something is off

- **`claude: command not found`:** Claude Code is not installed for the terminal (step 1). An *unknown option*: `claude update`.
- **`Unknown command: /p9m:init`:** start Claude Code again after installing. Still unknown: `claude plugin list`. `p9m@p9m` missing, `Scope: local` (an old install for another folder) or `disabled`: run `claude plugin install p9m@p9m --scope user` (`claude plugin enable p9m@p9m --scope user` if it stays disabled), and start Claude Code again. Not listed even then, and Claude Code says your organization manages its settings: ask your administrator to allow the `p9m-team/p9m` marketplace.
- **`marketplace update p9m-team/p9m` says *not found*:** updating takes the marketplace's name: `claude plugin marketplace update p9m`, then `claude plugin update p9m@p9m`.
- **The desktop app over SSH has no `/plugin`:** run the two `claude plugin …` lines in a terminal on that machine.
- **Windows, `CRYPT_E_REVOCATION_OFFLINE`:** Claude Code adds `--ssl-no-revoke` to its `curl` and goes on.
- **The code ran out** (10 minutes, once): run the same `/p9m:init` line again.
- **The sandbox could not be created:** the approval page says why, often that you have as many sandboxes running as you may. Let one sleep and approve again.
- **Never approve a code you did not ask for yourself**, and never give anyone the code the page shows after approving.
