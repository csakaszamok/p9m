# Claude Code plugin

!!! tip "New to this?"
    [Put your app online with Claude Code](tutorials/claude-code.md) walks through it step by step.

The `p9m` plugin teaches Claude Code to deploy: you say *put my app online*, it deploys the project to your sandbox's own Docker, checks that the app answers and gives you its address. The plugin itself keeps no address and no token: each project says which Purgatorium and which sandbox it belongs to, in its own `.p9m` folder.

## Install

Once on your computer, from a terminal (Purgatorium shows these lines once you sign in). Claude Code in an editor (the VS Code extension) has no `/plugin`, so there this is the way:

```
claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m
```

Or in Claude Code:

```
/plugin marketplace add p9m-team/p9m
/plugin install p9m@p9m
```

Claude Code asks where to install it: **user** (every folder of yours; usually what you want), **project** (this repository, for everyone who uses it, through its `.claude/settings.json`) or **local** (this folder, only you). It asks for nothing else: no address, no token. Updates come with Purgatorium's releases (`/plugin marketplace update p9m`).

Installed the plugin when it was called `p7y` (`/p7y:init`)? Claude Code knows that one by its old name, and `/plugin marketplace update p9m` finds nothing. Remove it and add the new one, in a terminal, in the folder where you installed it:

```sh
claude plugin uninstall p7y@p7y --scope local
claude plugin marketplace remove p7y
claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m
```

`--scope` is where you installed it (`claude plugin list` shows it: `user`, `project` or `local`); a `local` one only from its own folder. Then start Claude Code again.

## Connect a project: `/p9m:init`

Users get their sandboxes here, not in a web UI: only the admin has one. In Claude Code, in the project's root folder:

```
/p9m:init https://p9m.example.com                      # a new sandbox, from the default template
/p9m:init https://p9m.example.com --template empty     # a new sandbox, from that template
/p9m:init https://p9m.example.com k3x9q2               # one of your sandboxes
```

Claude Code prints a link. Open it in your browser (sign in first if Purgatorium asks). The page shows a code and what Claude Code asks for (a new sandbox from a template, or access to the named one); check that the code is the one Claude Code printed and click **Create and approve** or **Approve** (or **Deny**). There is nothing to pick on the page: a new sandbox gets a generated name, and a name that is not one of yours is refused. Only the sandbox's owner (or the admin) can approve. A new sandbox counts against the same limits as any other, and gets Docker access at once.

After the approval the page shows a second code. Paste it into Claude Code: only with it does Claude Code get the token, so a link someone else started gets them nothing unless you also send them that code. Both codes work once, for 10 minutes; 5 wrong pastes end the request.

Then Claude Code unpacks the project's `.p9m` folder straight to disk: a new token for that sandbox only (in `.p9m/p9m.env`, 90 days) and the sandbox's Docker keys. The token never shows on the screen or in the chat. The folder keeps itself out of git; the token is named `Claude Code init <date>` (the admin sees and revokes it under **Access tokens**).

Run `/p9m:init` with the sandbox's name again whenever the token has expired or was revoked. A project can be tied to one sandbox at a time; another project in another folder can be tied to another sandbox, or to another Purgatorium.

## The `.p9m` folder

The `.p9m` folder in the project's root folder says which Purgatorium and which sandbox the project belongs to: `p9m.env` (the address, the sandbox's name and its token) and the sandbox's Docker keys. `/p9m:init` writes it, or you unpack it from an export zip. It holds secrets, and it keeps itself out of git: its own `.gitignore` is a single `*`. Add `.p9m` to `.dockerignore` too, so that a build never copies it into an image; the agent does when it writes one.

## Use

In your project's folder, ask in your own words, e.g. *deploy this app to my sandbox* or *give me a link to show this to someone*, or run `/p9m:deploy`. You need Docker installed on your machine (the build runs in the sandbox, but the `docker` command line talks to it). In a project without a `.p9m` folder, the agent tells you to run `/p9m:init` first.

The plugin has three skills:

- **`/p9m:init`**: ties the project to a sandbox, as above;
- **`/p9m:deploy`**: the steps of the [agent guide](agent-guide.md) in short, for an agent that may be talking to someone who is not a developer. It works from `.p9m/p9m.env` with the REST API, and gets fresh Docker keys through a single-use link (unpacked to the disk, so a key never passes through the model: copied by a model a key gets garbled, and it would end up in the transcript);
- **`/p9m:teleport`**: moves the project into its sandbox, to continue there (below).

The plugin does not bring the MCP server. Purgatorium still has one, for other MCP clients: see [MCP](mcp.md).

## Continue in the sandbox: `/p9m:teleport`

`/p9m:teleport` (or `/p9m:teleport --ecc`) moves the project you are working on, with this conversation, into a `claude` container in the project's own sandbox, next to its apps; there `claude --resume` picks the conversation up where it stopped. It shows first what would move and asks:

- **the files**: the working folder as it is, uncommitted changes too; what `.gitignore` leaves out stays home (`node_modules`, build output; without git a built-in list);
- **secrets**: files that look like secrets (`.env`, `*.pem`, `credentials*.json`, …) go only if you say yes to each, by name. In the sandbox they are in a volume of their own, readable only by the `claude` container (folders `700`, files `600`), with a symlink in their place in the project; the container has no address; an [archive](archive.md) never holds them. The server's administrator can still read them, as everything on the server;
- **this conversation**, and your portable settings: global `CLAUDE.md`, your skills, the enabled plugins (installed again from their marketplaces), the `permissions`. Not your MCP servers, hooks or `env`: they point at things on your machine;
- **not the Claude Code sign-in**: sign in once in the container (`claude`, then `/login`); it stays there.

The files go straight to the sandbox's Docker with the project's keys (`.p9m/docker`): Purgatorium only wakes the sandbox. Then open the sandbox's panel → the **claude** container's terminal, `cd` into the folder it names and `claude --resume <id>`. It is one way: the local folder keeps the moment of the teleport; bring work back with git. `--ecc` starts the container from the image with [ECC](runtimes-templates.md) (only when the sandbox has no `claude` container yet). Teleporting the same project again asks before it replaces the sandbox's copy.

## Where it works

The plugin works fully in Claude Code: in the terminal, and in the Claude desktop app's **Code** tab; also in Claude Code inside a sandbox, deploying to another one (on a local `lvh.me` stack see [An agent inside a sandbox](agents.md#an-agent-inside-a-sandbox)). Claude chat and Cowork can install it too (**Customize → Plugins**, add the marketplace `p9m-team/p9m`), but they cannot run commands on your computer, so there it does not do much. Without the plugin, any agent can deploy with an export (**Let your agent deploy…** on a sandbox) or a token: see [Let your agent deploy](agents.md).
