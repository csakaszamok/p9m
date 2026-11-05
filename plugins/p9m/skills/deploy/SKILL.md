---
name: deploy
description: Deploy or update the user's app in their Purgatorium (p9m) sandbox and give them its public address. Use when the user asks to put their app online, deploy it, share it, publish it, or update it on Purgatorium or p9m, asks for a link to show their app to someone, or asks to set up a p9m zip.
---

# Deploy an app to a Purgatorium sandbox

The user may not be technical. Do the work yourself, say what you are doing in plain words, and finish with
the app's address. Never print a token or a Docker key, and never put them in git or in an image.

The project's `.p9m` folder says which Purgatorium, which sandbox and which token: you call Purgatorium's REST API
with `curl` from it (step 2). The plugin itself keeps no address and no token.

**Never copy a key or a certificate yourself**: not from an answer, not with Write or an editor, not character
by character, and never print one (`cat key.pem`). Copied by hand they get garbled (a wrong character in a key
still looks like a key), and in an answer they go into your context and the transcript. Only `/p9m:init`, a
single-use link (step 3) or an export zip puts them on disk. Never ask for `include_keys`.

**A sandbox has two names.** The user knows it by its short name (`shop`, as in its addresses); Purgatorium's
files and commands use the full one (`p9m-shop`, `P9M_SANDBOX`, the docker context). Talk to the user only
with the short name. Never build the full one yourself: take it from the `.p9m` folder or from Purgatorium's
answer.

## 1. The project's `.p9m` folder

A project is tied to its sandbox by a `.p9m` folder in the project's root folder:

```
.p9m/.gitignore     a single line: *   (git leaves the whole folder out)
.p9m/p9m.env        P9M_URL, P9M_TOKEN, P9M_SANDBOX, P9M_DOCKER_HOST, …
.p9m/docker/        ca.pem, cert.pem, key.pem: the sandbox's Docker client keys
.p9m/README.md      what the folder is, for the user
```

Look for it first:

- **`.p9m/p9m.env` is there, with `P9M_TOKEN`:** its `P9M_SANDBOX` is this project's sandbox. Do not ask which
  one. See what it holds without the token: `grep -E '^P9M_(URL|SANDBOX|DOCKER_HOST)=' .p9m/p9m.env`; check
  for the token with `grep -c '^P9M_TOKEN=' .p9m/p9m.env`.
- **Not there, but an export zip is** (`p9m-<name>.zip`, which holds a `.p9m` folder): in the project's
  folder, or the newest one in the user's Downloads folder (`~/Downloads`, on Windows
  `%USERPROFILE%\Downloads`) when the user says so. Unpack its `.p9m` folder into the project's root, check
  that `.p9m/.gitignore` is there, and delete the zip (it holds a token); tell the user you did. An older zip
  holds a `p9m-<name>/` folder instead: put its files in `.p9m/` and write the `.gitignore`.
- **A `.p9m` folder one level down** (unpacked into a subfolder): move it to the project's root.
- **None of these, or a `p9m.env` without `P9M_TOKEN`:** the project is not tied to a sandbox yet. Tell the
  user, and stop: *In Purgatorium, open the sandbox → **Let your agent deploy…**, copy the
  `/p9m:init <address> <sandbox>` line it shows and paste it here* (that runs this plugin's `init` skill: a
  link to approve in the browser, then the `.p9m` folder arrives by itself). Or **Download** the zip there and
  say *set up the p9m zip from my Downloads in this project and deploy*. If the user already gave you the
  address and the sandbox's name, do what the `init` skill says instead of asking.

If `.p9m` is not in the project's `.gitignore`, it does not have to be: the folder's own `.gitignore` keeps it
out. Never delete or empty that file.

## 2. The sandbox and the token

The sandbox is `P9M_SANDBOX`; the token is `P9M_TOKEN`, limited to that one sandbox. Never try to create a
sandbox or turn on Docker keys with it (it may not): the user does that in Purgatorium.

Call the API from bash (on Windows Claude Code's Bash tool is Git Bash: the same works). Every command is a new
shell, so load the file at the start of each one; the token stays in a variable:

```sh
set -a; . ./.p9m/p9m.env; set +a
curl -sf -H "Authorization: Bearer $P9M_TOKEN" "$P9M_URL/sandboxes/$P9M_SANDBOX"
```

- **Never print the token**: never `cat` or `type` the file, never `echo $P9M_TOKEN`, no `set -x`, never
  write the token into a command or a file yourself.
- On Windows, if curl fails with `CRYPT_E_REVOCATION_OFFLINE`, add `--ssl-no-revoke` (Windows' curl checks
  certificate revocation and fails when it cannot). In PowerShell call `curl.exe`, not `curl`.
- `-f` hides Purgatorium's error message: when a call fails, run it again with `-sS` instead of `-sf` to read it.
  401: the token has expired or was revoked: the user runs `/p9m:init` again. 404: the sandbox is gone.

The calls (`:name` is `$P9M_SANDBOX`):

- `GET /sandboxes/:name`: `status`, `docker_access.state`, `apps` (each with `url` and `answers`), `hub`.
- `POST /sandboxes/:name/start`: wakes it.
- `POST /sandboxes/:name/project-link`: a single-use link to new copies of the Docker keys (step 3).
- `PATCH /sandboxes/:name` with a JSON body (`-X PATCH -H "Content-Type: application/json" -d '{…}'`): sleep
  settings (step 5).

## 3. Wake it and connect Docker

`GET /sandboxes/:name` gives `status`. If it is not `running`: `POST /sandboxes/:name/start`, then
`GET /sandboxes/:name` every few seconds until it is (a few seconds; about 30 s from deep sleep). A Docker
connection does not wake it. A refusal that the running limit is reached: tell the user, and that putting
another sandbox to sleep frees a place. Never put a sandbox to sleep without asking.

`docker_access.state` must be `ready`. If it is `needs-certs`: the user runs `/p9m:init <address> <name>`
again and approves with **Enable Docker access and approve**. Tell them it restarts the sandbox and its apps are
unreachable for about 30 seconds; the token here may not do it.

The docker context is `p9m-<sandbox>`, with the sandbox's name as the user sees it (for `P9M_SANDBOX=p9m-shop`:
`p9m-shop`). Check it with a compose command, not only `ps` (`ps` can work with a key that compose
cannot read):

```sh
docker --context p9m-<sandbox> compose ls
```

- **No such context** (another machine, a `.p9m` from a zip): create it from the folder's files, with the
  project's root folder, absolute and with forward slashes (in Git Bash `pwd -W`, elsewhere `pwd`):

  ```sh
  set -a; . ./.p9m/p9m.env; set +a
  docker context create p9m-<sandbox> --docker "host=$P9M_DOCKER_HOST,ca=<project folder>/.p9m/docker/ca.pem,cert=<project folder>/.p9m/docker/cert.pem,key=<project folder>/.p9m/docker/key.pem"
  ```

- **Any TLS error** (`tls: failed to parse private key`, a bad certificate), or the user made **new keys** in
  Purgatorium: new copies of the keys. `POST /sandboxes/:name/project-link` answers `url` (a link that works
  **once**, for **5 minutes**), `command` and `context_commands`; never the keys. Its download holds a
  `p9m.env` without the token, so unpack **only the three keys**, never the whole `command`:

  ```sh
  curl -sf "<url>" | tar -x -C "<project folder>" .p9m/docker/ca.pem .p9m/docker/cert.pem .p9m/docker/key.pem
  ```

  The project's root folder, absolute, goes inside the quotes (a folder name may have a space); with
  `--ssl-no-revoke` after `curl` if other calls needed it. Then run `context_commands` in order, with the
  project's root folder for `<project folder>` (the context is removed, then created from those files), and
  check with `compose ls` again. A docker context keeps its own copies of the files, so fixing a file alone
  changes nothing. Never repair or guess at a key. An error 410 (or
  an empty download): the link has expired or was used; ask for a new one. 409: Docker access is not on.
- `docker` (the command line; the engine is the sandbox's) and `curl` must be installed on this machine; if one
  is not, say so and stop.

## 4. Deploy

Use the project's `compose.yaml` / `docker-compose.yml`, or write a small one (and a `Dockerfile` if needed):

```yaml
services:
  web:
    build: .
    ports: ["8080:8080"]
    restart: unless-stopped
```

- Publish ports **on all interfaces** (`8080:8080`, not `127.0.0.1:8080:8080`): that is what gives the app an
  address. The app must listen on `0.0.0.0` inside its container.
- `restart: unless-stopped` on every service, or it does not start again when the sandbox wakes.
- A short address: the label `p9m.subdomain: <name>` on the service makes it `https://<sandbox>-<name>.<domain>`
  instead of the long `<sandbox>-<project>-<container>-port<port>` one. Set it when the user names the address or
  asks for a shorter one (*call it runner*). Lowercase letters, digits and `-`, different for each app of the
  sandbox, never `shell` (the sandbox's SSH). Changing it changes the address: the old one stops working.
- Who may open it: `p9m.access: owner` (*only for me*; the server's default unless set otherwise), `domain` (*for my
  colleagues*: anyone who can sign in to their Purgatorium) or `public` (anyone: a public site, a webhook receiver).
  Without a label only the user opens it: set `public` or `domain` before the first deploy when the user wants that. Your own `curl` to a non-public app gets a sign-in redirect: rely on `answers`.
- Secrets go in `environment:` / `env_file:` at run time, never into the image. Add `.p9m` to a
  `.dockerignore` so the keys never reach a build.

```sh
docker --context p9m-<sandbox> compose -p <project> up -d --build
```

The build runs in the sandbox; it is the same command for an update.

## 5. Check and hand over

`GET /sandboxes/:name` again: `apps` lists each app with its `url` and `answers`. A new app shows there a few seconds
after `compose up` (first only in `tcp_urls`): ask every 3 s for up to about 30 s, until it is listed with
`answers: true`. Rely on `answers`, not on your own `curl` (on Windows the built-in curl fails with
`CRYPT_E_REVOCATION_OFFLINE` unless given `--ssl-no-revoke`).

- `answers: true`: give the user the `https://` address. It works for anyone with the link; when nobody
  uses it for a while (30 minutes by default) the sandbox sleeps, and the next visit wakes it in a few seconds.
- `answers: false`: the app does not answer. Usually it listens on `127.0.0.1`: make it listen on `0.0.0.0`,
  deploy again. `docker --context p9m-<sandbox> compose -p <project> logs --tail 50` shows why.
- No app at all: a port is not published on all interfaces.

A page that says the sandbox is waking up is Purgatorium's waiting page, not the app: wait and look again.

To change how long it stays awake: `PATCH /sandboxes/:name` with `{"idle_timeout": "2h"}` (or `"off"`), only
if the user asks.

## Publish on the Hub (when the user asks)

The Hub (`https://hub.<domain>`, if the admin turned it on) lists apps for the user's colleagues. Labels on the
app's service, then deploy again:

```yaml
    labels:
      p9m.publish: "true"            # "true" or "1"
      p9m.title: "Stock room"        # optional, up to 80 characters
      p9m.description: "Who took what from the stock room"   # optional, up to 280
      p9m.image: "/screenshot.png"   # optional: a path the app itself serves (PNG, JPEG, WebP, GIF; up to 2 MB)
```

It appears within about 90 seconds; `GET /sandboxes/:name` → `hub.published` lists it. Taking it off: remove
`p9m.publish` and deploy again.
