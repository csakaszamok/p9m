---
name: teleport
description: Move this project into its Purgatorium (p9m) sandbox and continue there - the files (uncommitted changes too, .gitignore respected), the secret files the user confirms by name, this conversation (claude --resume picks it up) and the portable Claude Code settings - into a claude container next to the project's apps. Use for /p9m:teleport [--ecc], or when the user wants to move or continue this work in the p9m sandbox.
argument-hint: [--ecc]
---

# Teleport this project into its sandbox

Arguments: `$ARGUMENTS`: `--ecc` puts the project into a container with ECC (agents, skills and hooks for a plan →
test → review workflow) instead of the slim one; only when the sandbox has no `claude` container yet.

The project moves into a `claude` container in **its own sandbox** (the one in `.p9m/p9m.env`), next to its apps:
the working folder (uncommitted changes too; what `.gitignore` leaves out stays home, e.g. `node_modules`), the secret
files the user confirms one by one, **this conversation**, and the user's portable settings (global `CLAUDE.md`, own
skills, the enabled plugins, the `permissions`). The Claude Code sign-in does not move: the user signs in once in the
sandbox. One way only: the local folder keeps the moment of the teleport; back home goes with git.

A script does the work: `"${CLAUDE_PLUGIN_ROOT}/scripts/teleport.sh"`, run in the project's root folder (where `.p9m`
is). It talks to the sandbox's own Docker with the project's keys; Purgatorium's API only wakes a sleeping sandbox
(`GET /sandboxes/:name`, `POST /sandboxes/:name/start`).

**Never print a secret or the token**: never `cat`, `type`, `head` or `grep` a secret file or `.p9m/p9m.env`, never
`echo $P9M_TOKEN`, no `set -x`. You see secret files by **name** only; the script copies them.

The sandbox is called by its short name when you talk to the user (`P9M_SANDBOX` without its `p9m-`):
`grep -E '^P9M_(URL|SANDBOX)=' .p9m/p9m.env`.

## 1. What would move

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/teleport.sh" --plan $ARGUMENTS
```

It answers tab-separated lines (exit 0):

- `project NAME`: the folder it gets in the sandbox, `/home/agent/workspace/NAME`;
- `files COUNT BYTES`: what goes;
- `secret PATH`: a file that looks like a secret (`.env`, `*.pem`, `credentials*.json`, …): goes **only** if the
  user says yes to it by name;
- `secret-link PATH`: one that is a symlink: never taken (it could point anywhere, e.g. at `~/.ssh`); tell the user,
  who can teleport the file it points to instead, if it is in the project;
- `session ID TIME`: this conversation (its id, its last message);
- `setting WHAT`: `CLAUDE.md`, `skills`, `permissions`, `plugins:N`;
- `exists yes|no`: the project is in the sandbox already (teleported before);
- `large yes|no`: more than 500 MB.

`error MESSAGE` (exit 2): tell the user the message as it is, and stop. *run /p9m:init first*: the project is not tied
to a sandbox: the `init` skill does that. *turn Docker access on*: the user does that in Purgatorium (the sandbox's
panel → Access → Enable), then runs `/p9m:teleport` again.

## 2. Ask

Tell the user in a few lines what will move: the folder name in the sandbox, the number and size of the files, the
conversation, the settings. Then:

- **Each `secret` line, by name, one question each** (*Take `.env` along? It may hold secrets: in the sandbox only
  the claude container can read it.*). The default is no. Keep the names the user said yes to.
- **`exists yes`:** *The sandbox has this project already: replace it? Work done there and not pushed is lost.* No:
  stop.
- **`large yes`:** show the largest folders (`du -sh -- */ | sort -h | tail -5`) and ask whether to go on; the user
  may add some to `.gitignore` first.
- **No `session` line:** say that this conversation was not found, so the sandbox starts without it; ask whether
  to go on.

## 3. Move

With every secret the user said yes to as its own `--secret`, and `--replace` only if they said yes to replacing. Run
it with the Bash tool's `timeout` set to `600000` (10 minutes): the first time it pulls the container's image, and a
run cut off halfway leaves the work undone:

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/teleport.sh" --run $ARGUMENTS --secret ".env" --secret "config/.env"
```

The first time it starts the `claude` container in the sandbox (pulling its image can take a minute or two). Its last
line is `resume ID FOLDER`. A `skipped-plugin NAME` line: that plugin could not be installed there (its marketplace is
a folder on this machine). `exists …` (exit 3): the project is there and `--replace` was not given. `error MESSAGE`
(exit 2): tell the user, and stop.

## 4. Continue there

Tell the user, with the id and folder from the `resume` line:

> The project is in the sandbox **<short name>**. Open its panel in Purgatorium → the **claude** container's
> terminal (or SSH into the sandbox and `docker exec -it claude bash`), then:
>
> ```
> claude            # the first time only: /login, then /exit
> cd <FOLDER>
> claude --resume <ID>
> ```
>
> Then tell Claude once: *the project now lives in <FOLDER>*. Work there from now on: this folder keeps the moment
> of the teleport. To bring work back, commit and push in the sandbox, pull here (the repository and your git name
> and e-mail went along; pushing needs your git host's credentials there once, e.g. an SSH key or a token).

List any `skipped-plugin` names (the user can install them there with `/plugin`).
