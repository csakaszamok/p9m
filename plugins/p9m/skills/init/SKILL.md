---
name: init
description: Tie this project folder to a Purgatorium (p9m) sandbox, a new one or one the user already has, with a link the user approves in the browser and a code they paste back; writes the project's .p9m folder (a token for that sandbox, its Docker keys) and the docker context. Use for /p9m:init <address> [sandbox | --template <name>], or when the user asks for a p9m or Purgatorium sandbox for this project.
argument-hint: <purgatorium address> [sandbox | --template <name>]
---

# Tie this project to a Purgatorium sandbox

Arguments: `$ARGUMENTS`: the Purgatorium address (e.g. `https://p9m.example.com`), then optionally either the
name of a sandbox the user already has (e.g. `k3x9q2`), or `--template <name>` for a new one from that template.
With neither, Purgatorium makes a new sandbox from its default template, and gives it a name itself.

The user approves in the browser and pastes back the code Purgatorium shows; the `.p9m` folder then comes by a
single-use link straight to disk. Say what you do in plain words. **Never print** `.p9m/p9m.env` (it holds the
token) or a key: never `cat` it, never `echo $P9M_TOKEN`, never copy a key or a certificate yourself.

**A sandbox has two names.** The user knows it by its short name (`shop`, as in its addresses); Purgatorium's
files and commands use the full one (`p9m-shop`, `P9M_SANDBOX`, the docker context). Talk to the user only
with the short name. Never build the full one yourself: take it from the `.p9m` folder or from Purgatorium's
answer.

## 1. What and where

- The address: the first argument. Without `http://` or `https://`, put `https://` in front; drop a trailing `/`.
  It must match `^https?://[A-Za-z0-9.:-]+$` before it goes into a command; otherwise ask the user for the
  address again.
- The sandbox (optional): a second argument that is not `--template`, as the user sees it (`shop`) or the full
  name (`p9m-shop`): one they already have. It must match `^[a-z0-9][a-z0-9_-]{0,62}$` (lower case letters,
  digits, `-`, `_`) before it goes into a command; otherwise ask the user for the name again.
- The template (optional): `--template <name>`, for a new sandbox. The name must match the same pattern. Not
  together with a sandbox: a template is only for a new one; ask the user which they want.
- No sandbox: a new one. Never make up a name for it, and never ask for one: Purgatorium names it.
- The address missing: ask the user for it (*the address of your Purgatorium, as in your browser*). Do not
  guess.
- The project's root folder: the folder you work in (where Claude Code was started). For the commands below it
  is absolute, with forward slashes: in Git Bash (Claude Code's Bash tool on Windows) `pwd -W` (`C:/Users/…`),
  elsewhere `pwd`. It replaces `<project folder>`, always inside double quotes (`"C:/Users/Ann/My shop"`):
  a folder name with a space must not break the unpack.
- `curl`, `tar` and `docker` (the command line only) must be installed; if one is not, say so and stop. On
  Windows, if curl fails with `CRYPT_E_REVOCATION_OFFLINE`, add `--ssl-no-revoke` (Windows' curl checks
  certificate revocation and fails when it cannot), and from then on add it to **every** curl, `command` in
  step 4 too (its `-sf` hides that error); in PowerShell call `curl.exe`, not `curl`.

**A `.p9m/p9m.env` already there:** the project is tied already. **Never start over by habit**: no new code, no
new token, no new keys, no new docker context while the one there works. Read only its address and sandbox, never
the whole file:

```sh
grep -E '^P9M_(URL|SANDBOX|DOCKER_HOST)=' .p9m/p9m.env
```

Compare by host name (`https://P9M.example.com/` and `p9m.example.com` are the same Purgatorium: ignore the
scheme, the case and a trailing `/`) and by the sandbox's name without its `p9m-` (`p9m-shop` and `shop` are the
same).

- **The same Purgatorium, and no sandbox named or the same one** (no `--template`): this is the sandbox the user
  means. Check that it works, with the context named as `P9M_SANDBOX`:

  ```sh
  docker --context <P9M_SANDBOX> compose ls
  ```

  - It answers: the keys work. Check the token too (it ends after 90 days; the keys do not), never printed:

    ```sh
    ( . ./.p9m/p9m.env && printf 'Authorization: Bearer %s\n' "$P9M_TOKEN" | curl -s -o /dev/null -w '%{http_code}\n' -H @- "$P9M_URL/sandboxes/$P9M_SANDBOX" )
    ```

    `200`: tell the user the project is tied to **<short name>** already and works; nothing changed. Add one line:
    for another sandbox, `/p9m:init <address> <name>` (one they have) or ask you for a new one. **Stop.** `401`:
    the token expired or was revoked: the link is broken (below).
  - `context … does not exist` (another machine, or the context was removed): make it again from the files that are
    there, nothing downloaded: `docker context create <P9M_SANDBOX> --docker "host=<P9M_DOCKER_HOST>,ca=<project
    folder>/.p9m/docker/ca.pem,cert=<project folder>/.p9m/docker/cert.pem,key=<project folder>/.p9m/docker/key.pem"`,
    then check again as above.
  - It cannot connect: the sandbox may be asleep (its Docker does not wake it). Wake it with the project's token,
    from the file, never printed:

    ```sh
    ( . ./.p9m/p9m.env && printf 'Authorization: Bearer %s\n' "$P9M_TOKEN" | curl -s -w '\n%{http_code}\n' -X POST -H @- "$P9M_URL/sandboxes/$P9M_SANDBOX/start" )
    ```

    It answers a line of JSON, then the status. `200`: waking; check with `compose ls` again every 10 seconds, up
    to a minute, then go on as when it answers. `409`: it cannot wake now (the server is full): tell the user its
    `error`, stop; the link is fine. `404`: the sandbox is gone (deleted): tell the user, and ask whether to make a
    new one (step 2 with `{}`).
  - Only when that fails too: `401` (the token expired: 90 days, or was revoked), a certificate error from docker,
    the key files missing: the link is broken. Only then tie it again: ask the user (*the link to <short name> no
    longer works: tie this project to it again?*), and on yes go on to step 2 for **that** sandbox
    (`{"sandbox":"<short name>"}`). A certificate error from **curl** alone is this machine not trusting the server's
    certificate, not a broken link: tell the user, do not tie again.
- **Another Purgatorium, another sandbox named, or `--template`:** tell the user which one it is tied to now and ask
  before replacing it. Yes: go on to step 2 with what they asked for. No: stop.

## 2. Ask for a code

`POST /device/code` (no token needed), with a body of what was asked for: `{"sandbox":"<sandbox>"}` for one the
user has, `{"template":"<template>"}` for a new one from a template, `{}` for a new one:

```sh
curl -sS -X POST -H "Content-Type: application/json" -d '<body>' "<address>/device/code"
```

It answers `device_code` (the secret that gets the token, with the user's code), `user_code`,
`verification_uri_complete` and `expires_in` (600 s). Keep the device code in your commands only: never write it
to a file. An error: 400: the sandbox's name is not a name, or the template is unknown (tell the user; `GET
/templates` needs a token, so do not look it up); 503: too many pending codes, try again in a few minutes; no
answer or not JSON: the address is wrong, ask the user.

Tell the user, with the link and the code as they are, and nothing after it (the last line is what they do
next), then **stop and wait** for their answer:

> Open **<verification_uri_complete>** and approve the code **<user_code>** (sign in first if Purgatorium asks).
> A new sandbox takes up to a minute; then the page shows a new code, with a **Copy** button.
>
> **Paste that new code here (XXXX-XXXX) and press Enter.**

## 3. The code the user pastes

The user's next message has the confirmation code (`XXXX-XXXX`, letters; lower case or a space instead of the
dash is fine). It must match `^[A-Za-z]{4}[- ]?[A-Za-z]{4}$` before it goes into a command; otherwise ask for it
again. The user says they clicked Deny, or does not want to go on: stop.

`POST /device/token`, with the device code and the user's code inline:

```sh
curl -sS -X POST -H "Content-Type: application/json" -d '{"device_code":"<device_code>","code":"<code>"}' "<address>/device/token"
```

- `{"status":"wrong","tries_left":N}` (400): not the code. Ask the user to paste it again, as Purgatorium
  shows it; after 5 wrong ones the request ends.
- `{"status":"pending"}` (409): not approved yet. Ask the user to approve in the browser first, then paste the
  code.
- `{"status":"denied"}` (403): the user said no. Say so and stop.
- `{"status":"expired"}` (410): the code expired (10 minutes), was used, or was wrong too often. Say so and
  stop; the user can run `/p9m:init` again.
- `{"error":"…"}` (400): the request was refused. Show the error and stop.
- `{"status":"approved", sandbox, name, url, expires_in, command, context_commands}`: this answer comes **once**:
  go on at once (the link works once, for 5 minutes). `name` is the sandbox as the user knows it (in its
  addresses, in `/p9m:init <address> <name>`): for a new one, tell the user that name, never `sandbox` (the full
  name, with the server's prefix). No `name` (an older Purgatorium): tell `sandbox` without its `p9m-`.

## 4. Unpack and connect

Run them yourself, with the project's root folder, absolute, put inside the quotes of `"<project folder>"`
(and in `context_commands`, where the path is already inside a quoted argument):

1. `command`: `curl -sf "<url>" | tar -x -C "<project folder>"` (with `--ssl-no-revoke` after `curl` if step 2
   needed it). It writes `.p9m/.gitignore`, `.p9m/p9m.env`
   (with a new token for this sandbox only, valid 90 days), `.p9m/README.md` and
   `.p9m/docker/{ca,cert,key}.pem`. An error 410 or an empty download: the link expired or was used; run
   `/p9m:init` again.
2. `context_commands`, in order: the docker context is removed, then created from those files. Its name is
   the one in these commands (`docker context create p9m-shop …`: `p9m-shop`); use that name below, never
   one you built from the argument (`p9m-shop` given would make a wrong `p9m-p9m-shop`).
3. Check it with a compose command (not only `ps`: it can work with a key that compose cannot read), with that
   context name:

```sh
docker --context <context> compose ls
```

A TLS error: never repair or guess at a key; tell the user and stop.

Then:

- Check that `.p9m/.gitignore` is there (a single `*`: git leaves the folder out). Never delete or empty it.
- A `.dockerignore` in the project without `.p9m` in it: add a line `.p9m`, so a build never copies the keys
  into an image.

Tell the user it is ready: this project is tied to the sandbox, and *deploy this app* puts it online.
