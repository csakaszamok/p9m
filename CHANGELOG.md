# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org/); before 1.0, a minor version may change behaviour.

## [Unreleased]

## [0.18.1] - 2026-10-31

Upgrading from 0.18.0: `docker compose pull && docker compose up -d`. A server still on an older release's `docker-compose.yml` should take this release's first (`curl -fsSL -o docker-compose.yml https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`). A `HOST_SANDBOXES_DIR` set by hand to get around the bug below can stay.

### Fixed

- **New sandboxes started for ever and never answered** on a server where Purgatorium's container had a hostname other than its ID (a container that compose recreated): it found its own container by hostname, so it could not tell where `opt/sandboxes` is on the host, and mounted every new sandbox's files from a guessed `/opt/sandboxes`. The sandbox restarted every few seconds (*Instance name file not found*), the list said *restarting* and its panel *deep sleep*. Purgatorium now finds its own container by the ID its mounts name; existing sandboxes mounted from the guess are moved to the right path at the next start. If it still cannot tell, creating a sandbox fails with what to set (`HOST_SANDBOXES_DIR`) instead of making one that never starts. The same lookup also fixes the disk usage, the free space and the internal port's network (*not on the sablier-net network* in the log).
- **A new end-to-end test on every pull request:** a sandbox made as the UI makes it, on sysbox, with Purgatorium's hostname not its ID, must be running in the list and in its details, not restart, have every mount from the host and its app answering.
- **A sandbox being created says so:** the list, its panel and the summary showed *deep sleep*, then *asleep · not counted* while a new sandbox was only being made (its directory comes before its containers, its containers before they run). It is now *creating…*, counted as running (it takes a place already).
- **The New sandbox dialog opens at once, and its name comes fast:** `GET /sandbox-name` (and a create without a name) picks a free name from the sandbox directories instead of asking Docker about every container, which took 10-20 seconds on a busy server; the dialog opens before the runtimes, templates and the template's stack have loaded, and does not wait for them for the name.
- **The admin opens a sandbox's app from the console:** since 0.16.0 the apps' sign-in is on `USER_HOST` (`sbx.<domain>`), where the admin, signed in on `UI_HOST`, has no session (and cannot sign in with the password): an app open to its owner or the domain asked the admin to sign in with Google, or refused. The admin's app links (Apps, Portainer) now go through `/auth/app/start` on `UI_HOST`, which hands the app a ticket from the admin's session there. Users' links are unchanged.

## [0.18.0] - 2026-10-31

Upgrading from 0.17.x: `docker compose pull && docker compose up -d`; nothing else changes on the server. The Claude Code plugin updates itself (`/plugin` → update, or reinstall).

### Added

- **`/p9m:teleport`: continue in the sandbox.** The Claude Code plugin moves the project you are working on into a `claude` container in its own sandbox, next to its apps: the files (uncommitted changes too, `.gitignore` respected), the secret files you confirm one by one, this conversation (`claude --resume` picks it up there) and your portable settings (global `CLAUDE.md`, skills, enabled plugins, `permissions`). It goes straight to the sandbox's Docker with the project's keys; secrets live in a volume only the `claude` container sees. `--ecc` for the image with ECC. One way: back with git.
- **Archives never hold a teleported project's secrets:** archiving leaves the `claude_secrets` volume out of the inner Docker's data, and the manifest says `secrets_excluded: true`.

## [0.17.0] - 2026-10-31

Upgrading from 0.16.x: `docker compose pull && docker compose up -d`. A script or agent that sent `compose` when creating a sandbox gets a 400: create from a template, then deploy the apps through the sandbox's Docker.

### Changed

- **A template is only the start, as it is.** A sandbox's starter stack can no longer be replaced or edited: `POST /sandboxes` (and the MCP `create_sandbox` tool) refuse a `compose` text, and the **New sandbox** dialog shows the template's stack read-only. Apps, Claude Code in a sandbox made from `starter`, anything else, go in afterwards like every app, through the sandbox's Docker (`docker`, SSH or an agent). One less way to hand Purgatorium a compose text of a user's. Sandboxes made from an edited text before keep it.
- **The `empty` template is a sandbox without a starter stack** (it wanted a pasted compose text).

## [0.16.3] - 2026-10-31

Upgrading from 0.16.x: `docker compose pull && docker compose up -d`; nothing else changes.

### Added

- **A `claude-code-ecc` template:** the slim image with [ECC](https://github.com/affaan-m/ECC) 2.2.3 (MIT) installed into Claude Code as the `ecc@ecc` plugin: agents, skills and hooks for a plan → test → review workflow, with Node.js and Python for its hooks. `ghcr.io/csakaszamok/p9m-claude-code-ecc`, built with every release on that release's `p9m-claude-code-minimal`. For trying ECC out: it adds about 31k tokens of context to every session.

## [0.16.2] - 2026-10-31

Upgrading from 0.16.x: `docker compose pull && docker compose up -d`; nothing else changes.

### Added

- **A `claude-code-minimal` template:** the same as `claude-code`, with a slim image of our own, `ghcr.io/csakaszamok/p9m-claude-code-minimal` (Claude Code, the Docker CLI with compose and buildx, git; the same `agent` user, home and sudo as Docker Sandboxes' image), built with every release. About 1.5 GB of disk per sandbox instead of about 5 GB.

## [0.16.1] - 2026-10-31

Upgrading from 0.16.0: `docker compose pull && docker compose up -d`; nothing else changes.

### Added

- **A `claude-code` template:** Claude Code in Docker Sandboxes' (`sbx`) own image, `docker/sandbox-templates:claude-code`, next to the sandbox's own Docker, with a hello app. Open the sandbox's terminal in the `claude` container and run `claude`: it builds and runs apps with `docker compose`, and what it publishes gets an address at once. Its home directory is a volume, so the sign-in and `~/workspace` survive sleep. The image is large: about 5 GB of disk per sandbox.

## [0.16.0] - 2026-10-30

Upgrading from 0.15.x: `docker compose pull && docker compose up -d` with this release's `docker-compose.yml`. **Users move to `sbx.<HOST_DOMAIN>`**: register `https://sbx.<HOST_DOMAIN>/auth/callback` with the OIDC provider first (the wildcard DNS record and certificate already cover it), or set `USER_HOST=off` to keep everyone on `UI_HOST`.

### Changed

- **The users' own address is on by default:** `USER_HOST` empty means `sbx.<HOST_DOMAIN>`, as `UI_HOST` empty means `p9m.<HOST_DOMAIN>`. `USER_HOST=off` (or the same as `UI_HOST`) turns it off.

## [0.15.0] - 2026-10-30

Upgrading from 0.14.x: `docker compose pull && docker compose up -d` with this release's `docker-compose.yml` (it routes `USER_HOST`). Nothing changes until `USER_HOST` is set.

### Added

- **The users' own address (`USER_HOST`, e.g. `sbx.example.com`).** Users sign in, approve `/p9m:init` and sign in to the sandbox apps there, and `UI_HOST` (e.g. `console.example.com`) is the admin's: a user who signs in on it is sent on to `USER_HOST`, the admin's pages on `USER_HOST` go to `UI_HOST`. The users' page, the `/activate` links, new `.p9m` folders and the apps' sign-in name `USER_HOST`; the API and `/mcp` answer on both, so existing `.p9m` folders keep working. To turn it on: `USER_HOST` in `.env`, its `/auth/callback` registered with the OIDC provider, `docker compose up -d`. Off unless set.

## [0.14.1] - 2026-10-30

Upgrading from 0.14.0: only `check-host.sh` changed; the server is unchanged but for the version (`docker compose pull && docker compose up -d` when convenient).

### Fixed

- **`check-host.sh` tells where the API port really listens.** It read only `P9M_API_BIND` from `.env`, so with the `docker-compose.yml` of 0.13 or earlier and the setting empty it said *on this machine only* while port 8081 was open to every network. With Purgatorium running it now asks Docker; otherwise it still reads `.env`.
- **`check-host.sh` no longer hangs on a Docker daemon that does not answer:** after 30 seconds it says so and goes on.

## [0.14.0] - 2026-10-30

Upgrading from 0.13.x to 0.14.0: **check `.env` first** (see [Upgrading](https://csakaszamok.github.io/p9m/latest/upgrading/)): `ADMIN_TOKEN` must be set, the API port `8081` is on the host only, and OIDC needs `OIDC_ALLOWED_DOMAINS` or `OIDC_ALLOWED_EMAILS` (or `OIDC_ALLOW_ANYONE=true`). Then `docker compose pull && docker compose up -d`; `./check-host.sh` lists what is still open.

### Changed

- **Closed by default.** A server set up without `setup.sh`, or with a setting left empty, no longer starts open:
  - `docker compose` refuses to start without an `ADMIN_TOKEN` in `.env` (it fell back to `abc123`). `setup.sh` fills in a random one, as before.
  - The direct plain-HTTP API port `8081` listens on the host only (`P9M_API_BIND` defaults to `127.0.0.1`, was `0.0.0.0`): from other machines everything goes through Traefik and `PUBLIC_URL`. `P9M_API_BIND=0.0.0.0` opens it again, for a trusted network.
  - With OIDC on and neither `OIDC_ALLOWED_DOMAINS` nor `OIDC_ALLOWED_EMAILS` set, Purgatorium refuses to start (it only warned): with Google, any Google account could sign in and create sandboxes. `OIDC_ALLOW_ANYONE=true` allows that on purpose.
- **SECURITY.md has a security model**: Purgatorium controls the host through its Docker socket, sandboxes are containers and not VMs, what is closed by default, and the open-source base images it is built on.

## [0.13.3] - 2026-10-29

Upgrading from 0.13.2: only the docs changed; the server is unchanged but for the version (`docker compose pull && docker compose up -d` when convenient).

### Changed

- **The docs follow users without a web UI:** *Put your app online with any agent* gets the `.p9m` folder from `/p9m:init` once, or a zip from the admin; *Web UI* says users get tokens from `/p9m:init` and only the admin revokes them; `USER_VIEW_SWITCH` has no effect any more. The Claude Code docs say how to move from the plugin installed as `p7y` (`claude plugin marketplace remove p7y`, then add `p9m-team/p9m`). The tutorial screenshots of the users' UI are gone.

## [0.13.2] - 2026-10-29

Upgrading from 0.13.1: plugin users run `/plugin marketplace update p9m`; the server is unchanged but for the version (`docker compose pull && docker compose up -d` when convenient).

### Changed

- **`/p9m:init` ends with what to do:** *Paste that new code here (XXXX-XXXX) and press Enter.*, on its own line, so the user knows Claude Code is waiting for the code from the page (not the one they approved).

## [0.13.1] - 2026-10-29

Upgrading from 0.13.0: `docker compose pull && docker compose up -d`. Plugin users: `/plugin marketplace update p9m`.

### Changed

- **The `/activate` page shows that it is working.** After **Create and approve** (or **Approve**, **Deny**) the buttons give way to *Creating the sandbox…* with a glowing ember until the next page comes, instead of a page that seemed frozen for up to a minute. The confirmation code has a **Copy** button.
- **`/p9m:init` tells the new sandbox by the name the user knows** (`k3x9q2`, as in its addresses), not by the full `p9m-k3x9q2`: `POST /device/token` also answers `name`. The plugin talks of a sandbox only by that name, and sends a sandbox without Docker access back to `/p9m:init` instead of a web UI users no longer have. Update the plugin to get it (`/plugin marketplace update p9m`).

## [0.13.0] - 2026-10-29

Upgrading from 0.12.25: `docker compose pull && docker compose up -d`. Users then have no web UI, only the admin: tell them to get their sandboxes with the Claude Code plugin (`/p9m:init <address>`). Everyone with the plugin runs `/plugin marketplace update p9m` once: the older plugin cannot connect a project any more.

### Changed

- **Users get their sandboxes from Claude Code; only the admin has a web UI.** `/p9m:init <address>` asks for a new sandbox (from the default template, or `--template <name>`), `/p9m:init <address> <sandbox>` for access to one the user has. The approval page only shows what was asked for, with nothing to pick: a new sandbox is created there (named by Purgatorium, under the same limits as `POST /sandboxes`, with Docker access at once), a name that is not the user's own is refused. A user who signs in sees only how to install the plugin, and a user's sign-in reaches no API (users work with tokens); the admin keeps every page.
- **`/p9m:init` needs the code the approval page shows.** After **Approve** the page shows a confirmation code, which the user pastes into Claude Code: only with it does `POST /device/token` give the token, so a link someone else started gets them nothing. 5 wrong codes end the request. The page warns when the code was asked for from another address than the browser's. `POST /device/poll` is gone: an older plugin cannot connect until it is updated (`/plugin marketplace update p9m`).

### Fixed

- The approval page's own messages (an expired code, a sandbox that is not yours) were replaced by the general not-found page.

## [0.12.25] - 2026-10-29

Upgrading from 0.12.24: `docker compose pull && docker compose up -d`.

### Changed

- **Right after a sandbox wakes, its apps show an hourglass (⏳), not a warning.** Until its apps have all answered (at most 90 seconds), an app that does not answer yet is on its way: no ⚠ and no "is not answering" tip, and "Starting: its apps show up in a moment" in place of "the server is busy". The API's `GET /sandboxes/{name}` (and the list) says so with `starting: true`.

## [0.12.24] - 2026-10-29

Upgrading from 0.12.23: `docker compose pull && docker compose up -d`. If `check-host.sh` says `traefik-net` has room for fewer sandboxes than `SANDBOX_MAX_TOTAL`, give it its own subnet (see "traefik-net" in the [install guide](https://csakaszamok.github.io/p9m/latest/install/)).

### Fixed

- **`check-host.sh` checks how many sandboxes can run at once on `traefik-net`.** Every running sandbox takes two addresses there; with the address pools the install guide suggests (`size: 28`), `traefik-net` got a `/28` too, room for 4 running sandboxes, and the next one started without its tunnel. The [install guide](https://csakaszamok.github.io/p9m/latest/install/) now gives `traefik-net` its own subnet in a `docker-compose.override.yml`, and suggests address pools for 65536 sandbox networks (`10.64.0.0/12`, in place of `10.10.0.0/16`'s 4096).

## [0.12.23] - 2026-10-29

Upgrading from 0.12.22 (or before: 0.12.21 and 0.12.22 can be skipped, but read 0.12.22's note on `ADMIN_TOKEN` and `SESSION_SECRET`): download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.22. This release needs the new one (the Docker Hub cache's name for the sandboxes). The sandboxes made before move to their own network at the next start of Purgatorium (running ones restart, on the sandbox image foxglove 0.11.0).

### Security

- **A sandbox no longer reaches the other sandboxes.** Every sandbox container was on `traefik-net`, so a sandbox reached every other sandbox's published ports directly, past [app access](https://csakaszamok.github.io/p9m/latest/app-access/). Now a sandbox is on its own network only, and everything into it goes through its frp tunnel: besides the web addresses, the TLS TCP addresses, SSH and Docker access too (foxglove 0.11.0's frpc registers them as tcp proxies; the sandbox's frps is on `traefik-net` under the sandbox's name). What the sandbox needs of Purgatorium's services (the Docker Hub cache, the registry, the UI) its socat relays under their usual names. frps's own ports move out of the apps' way (65000, 65080, 65075), as frps now listens on every port the sandbox publishes. `tests/isolation.sh` checks that nothing of one sandbox is reachable from another.

## [0.12.22] - 2026-10-29

Upgrading from 0.12.21 (or 0.12.20: 0.12.21 can be skipped): download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.21. This release needs the new one (Traefik's flags, Purgatorium's internal address): with one from before, Purgatorium warns at startup. After upgrading, change `ADMIN_TOKEN` and `SESSION_SECRET` in `.env` (then `docker compose up -d`): before this release a sandbox could read them.

### Security

- **A sandbox can no longer make Purgatorium read or write one of Purgatorium's own files.** Its `/inner` and `/certs` were mounted read-write, and Purgatorium reads and writes files there as root: root in the sandbox could put a symlink in their place. Now `/inner` is read-only, of `/certs` the sandbox gets only its dockerd's certificate, read-only, and Purgatorium reads and writes in a sandbox's directory without following a symlink, only plain files of a limited size. The sandboxes made before get the new mounts at the next start of Purgatorium (running ones restart).
- **Traefik's API is no longer served:** the sandboxes could read every router from it, so every user's sandboxes and apps.
- **Purgatorium's internal port (app access for Traefik) listens only on an internal network no sandbox is on** (`sablier-net`, where Traefik reaches it as `p9m-internal`): from `traefik-net` the sandboxes could read every sandbox's name and its apps' access levels.

## [0.12.21] - 2026-10-28

Upgrading from 0.12.20: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.20. Sandboxes made before keep running as they are; new ones use the sandbox image foxglove 0.10.0.

### Security

- **A sandbox's stack is brought up by `docker compose` inside the sandbox,** on its own Docker, no longer in the Purgatorium container (which holds the host's Docker socket). A compose text given on create could make the CLI there run a program of the server's: keys added to compose after the list of refused ones was written got past it. Now whatever a compose file reads, builds or runs is the sandbox's. Needs the sandbox image foxglove 0.10.0 (the `sysbox` one now has `docker compose`), which the runtimes name.

### Changed

- **A compose text may use `build`, `env_file`, `include`, `extends.file` and `secrets`/`configs` from a file:** they read the sandbox's files (relative paths under `/inner`). A text docker compose refuses still makes no sandbox: it is taken away again, volumes too.

### Fixed

- The disk measurement no longer touches a sandbox while it is created or woken: one taken back during a measurement kept an empty volume.

## [0.12.20] - 2026-10-28

Upgrading from 0.12.19: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.19.

### Added

- **A new sandbox needs no name:** **New sandbox** fills in a generated one, six letters and digits like `k3x9q2` (about 1.5 billion of them, a taken one is drawn again), selected, so typing replaces it; *another name* draws a new one. `POST /sandboxes` and MCP's `create_sandbox` without `name` generate one too, and the answer says which; `GET /sandbox-name` suggests one.

## [0.12.19] - 2026-10-27

Upgrading from 0.12.18: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.18.

### Added

- **`APPS_DOMAIN`: the sandboxes' apps under a domain of their own,** e.g. `example.app` beside `HOST_DOMAIN=example.dev`, as GitHub Pages and Vercel do: a phishing app reported to a blocklist cannot take the UI's domain with it, nor set cookies for it. The apps, TCP, SSH and Docker addresses move; the UI, the registry and the Hub stay. The sandboxes made before move at the next start, and their old web addresses redirect (308). Needs a wildcard DNS record and certificate for the new domain: see [A separate domain for the apps](https://csakaszamok.github.io/p9m/latest/networking/#a-separate-domain-for-the-apps). Empty, as before: everything under `HOST_DOMAIN`.

### Changed

- **The Claude Code plugin installs from `p9m-team/p9m`:** `/plugin marketplace add p9m-team/p9m`, then `/plugin install p9m@p9m` as before, in the docs and under **Let your agent deploy…**. The plugin is the same and still comes from this repository; a marketplace added as `csakaszamok/p9m` keeps working.

## [0.12.18] - 2026-10-27

Upgrading from 0.12.17: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.17.

### Fixed

- **Uploads and downloads in the Files tab work on sysbox sandboxes:** they went through Docker's archive API, which finds no path at all in a `sysbox-runc` container (*no such container - Could not find the file /home in container …*); listing worked, so the folders were offered. Files now go in and out with `tar` in an exec, like the listing.
- **Just after a wake, the Containers tab and the volumes list say *Docker is starting in the sandbox…*** and try again every 2 seconds, instead of showing `connect ECONNREFUSED …:2376` until the next refresh. The API answers 409 with reason `docker_starting` (`GET /sandboxes/<name>/containers`, `GET /sandboxes/<name>/volumes`).

## [0.12.17] - 2026-10-26

Upgrading from 0.12.16: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.16.

### Fixed

- **A token limited to one sandbox can list its containers:** `GET /sandboxes/<name>/containers` (the Containers tab, `list_sandbox_containers` over MCP) answered 403 to it.

## [0.12.16] - 2026-10-26

Upgrading from 0.12.15: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.15.

### Added

- **Two new 404 pages, one picked at random:** agents drifting in space, or hiding behind big crates in the dark while the pointer is a flashlight; no numbers on them, since people look for an app, not for an error code. Every `error-pages/404*.html` takes part; still self-contained, and still for reduced motion.
- **Time left before signing out, in the header:** next to the user's name, e.g. `27 min`; in the warning colour for the last two minutes. Hidden with `SESSION_IDLE_TIMEOUT=off`.

### Changed

- **The sandbox's Apps tab is now called App ports:** it lists the ports the sandbox's containers publish, with their links; the Containers tab lists all of them.

## [0.12.15] - 2026-10-26

Upgrading from 0.12.14: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml` (it passes `SESSION_IDLE_TIMEOUT`), then `docker compose pull && docker compose up -d`. Browser sessions idle for over 30 minutes are signed out. A `docker-compose.yml` you keep from before stays on 0.12.14.

### Added

- **Signed out for doing nothing:** after 30 minutes without a click, a key (also in a browser terminal), a scroll or opening a page, the web UI signs its user out (`SESSION_IDLE_TIMEOUT`, e.g. `2h`, or `off`). The list's automatic refreshes do not count, so a tab left open does not stay signed in. Two minutes before, a bar offers **Stay signed in**; after signing in again, the same page opens. Sessions still end after 7 days at the latest; tokens are not affected. Upgrading signs out the sessions idle for over 30 minutes.

## [0.12.14] - 2026-10-26

Upgrading from 0.12.13: if `.env` has `APPS_ACCESS_DEFAULT=public` (written by `setup.sh` before 0.12.12), empty it so apps without a `p9m.access` label open only for their owner (label the public ones `p9m.access: public` first). Then download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, and `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.12.13.

### Fixed

- **Apps owner-only by default on servers set up before 0.12.12:** `setup.sh` had written `APPS_ACCESS_DEFAULT=public` into `.env` (from `env.example`), which kept every app without a `p9m.access` label public. A new `.env` leaves it empty (the default, `owner`), and `check-host.sh` marks `public` as not secure. On a server set up before: empty `APPS_ACCESS_DEFAULT` in `.env`, then `docker compose up -d`.
- **"No such container: <id>_p9m-…-socat" for about a minute after changing a sandbox's sleep time:** the socat container was recreated by compose under a temporary name, which Sablier took into the sandbox's group until its next reconciliation, so opening an app failed meanwhile. The container is now removed first and created under its own name (also when a host folder mount recreates the sandbox container).

## [0.12.13] - 2026-10-26

Upgrading from 0.12.12: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.12.

### Fixed

- **`check-host.sh` on a server already set up:** it checked the DNS record of `p9m.<domain>` even with a `UI_HOST` of its own (e.g. `console.example.com`); now that one. And it no longer ends with *Next: ./setup.sh* when the folder has a `.env`.

## [0.12.12] - 2026-10-26

Upgrading from 0.12.11, **two defaults change; before `docker compose up -d`:** (1) install [sysbox](https://github.com/nestybox/sysbox) on the server, or no new sandbox can be created (existing ones keep running); (2) label the apps everyone should open `p9m.access: public` (or `domain`), or set `APPS_ACCESS_DEFAULT=public` in `.env` to keep the old behaviour: without a label an app now opens only for its owner. Then download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml` and `docker compose pull && docker compose up -d`. Afterwards, run the new `check-host.sh` in the `p9m` folder: it lists what is not secure. A `docker-compose.yml` you keep from before stays on 0.12.11.

### Changed

- **Only sysbox by default; `dind` is for development only:** `ALLOWED_RUNTIMES` defaults to `sysbox` (also `all` now allows every runtime). On a host without sysbox no new sandbox can be created, and Purgatorium says so at startup; `docker-compose.dev.yml` allows `all` for development (Docker Desktop has no sysbox). Upgrading: install sysbox on the server; existing `dind` sandboxes keep running, sleeping and waking (recreate them under sysbox). To allow `dind` anyway: `ALLOWED_RUNTIMES=sysbox,dind`, which `check-host.sh` reports as not secure.
- **Web apps open only for their owner by default:** `APPS_ACCESS_DEFAULT` defaults to `owner` (was `public`): an app without a `p9m.access` label opens only for its sandbox's owner and the admin, so an app is made public on purpose. Upgrading: label the apps everyone should open `p9m.access: public` (webhook receivers too, they cannot sign in), or `domain` for colleagues, or keep the old behaviour with `APPS_ACCESS_DEFAULT=public`. Apps with `p9m.publish` and no label are no longer on the Hub (owner-only apps are not published): label them `domain` or `public`.

### Added

- **Security checks in `check-host.sh`:** run in the `p9m` folder, it checks the `.env` (API port open to all networks, `ADMIN_LOGIN` on, default secrets, OIDC open to anyone, no HTTPS, `dind` allowed) and the host (other open ports, no firewall, no automatic updates, SSH passwords), marks each with **!**, and lists them all again at the end under a big *NOT SECURE* banner.

## [0.12.11] - 2026-10-26

Upgrading from 0.12.10: **if the admin signs in with the password, first add `ADMIN_LOGIN=on` to `.env`** (the new default is off; OIDC admins and `ADMIN_TOKEN` are not affected). Then download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml` (it passes `ADMIN_LOGIN`), and `docker compose pull && docker compose up -d`. If `.env` still has `UI_TITLE=Purgatorium` from `setup.sh`, empty it for the new name. A `docker-compose.yml` you keep from before stays on 0.12.10.

### Changed

- **The admin's password sign-in is off by default:** a new `ADMIN_LOGIN` (default `off`) decides whether the **Administrator sign-in** form is on the sign-in page (and the Hub's); off, it is not shown and the password is not even checked. Upgrading: on a server where the admin signs in with the password, set `ADMIN_LOGIN=on` in `.env` before `docker compose up -d`, or the admin can only sign in with OIDC (`OIDC_ADMIN_EMAILS`) and use the API with `ADMIN_TOKEN`. Meant as an emergency door: turn it on, sign in, turn it off. While on, Purgatorium warns at startup. See [Configuration](docs/configuration.md).

### Added

- **Limits against password guessing:** an address with 5 failed sign-ins within 15 minutes (the admin's password, or OIDC) waits 1 minute, then twice as long after each further failure, up to an hour; after 30 failed admin passwords in an hour from all addresses together, the admin password is refused for everyone for the rest of that hour. Each refusal is a `[login]` line in the log, with the address Traefik saw (for fail2ban).

### Fixed

- **The new name on installed servers:** `setup.sh` wrote `UI_TITLE=Purgatorium` into `.env` (from `env.example`), which kept the old name after 0.12.10. A new `.env` leaves `UI_TITLE` empty (the default). On a server set up before: change or empty `UI_TITLE` in `.env`, then `docker compose up -d` (a `restart` does not read `.env` again).

## [0.12.10] - 2026-10-26

Upgrading from 0.12.9: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (the version and `UI_TITLE`'s default change). A `docker-compose.yml` you keep from before stays on 0.12.9 and on the name *Purgatorium*.

### Changed

- **The default name is *Purgatorium Agentium*:** at the top left, on the sign-in page and in the browser tab titles (`UI_TITLE`'s default). A server with its own `UI_TITLE` keeps it; the About page still says *Based on Purgatorium (p9m)*.

## [0.12.9] - 2026-10-26

Upgrading from 0.12.8: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.8.

### Added

- **A terminal in a sandbox's containers:** a new **Containers** tab in the panel (not in Simple) lists the containers in the sandbox's own Docker (`GET /sandboxes/:name/containers`, MCP `list_sandbox_containers`), and **Terminal** next to a running one opens the browser terminal in it, as the container's own user in its working directory, with that user's login shell. For apps that only have a console, such as Claude Code in a devcontainer. See [SSH, terminal and logs](docs/shell-and-logs.md#terminal-in-a-container).

## [0.12.8] - 2026-10-25

Upgrading from 0.12.7: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.7.

### Changed

- **My area in the topbar:** *My sandboxes*, *Access tokens* and *SSH keys* are one menu item, **My area**, with the three as tabs in a row below it on those pages, so the topbar has room for the rest (e.g. the admin's newer-release notice). Simple shows no row: My area is the sandboxes there. The addresses (`/`, `/settings/tokens`, `/settings/ssh-keys`) stay.

## [0.12.7] - 2026-10-25

Upgrading from 0.12.6: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.6.

### Fixed

- **A half-deleted sandbox** (its directory gone, its container still there) can be deleted: its panel failed with `ENOENT … certs/server/ca.pem` and **Delete** answered *not found*. Now the panel opens, and **Delete** saves its volumes in the archive (without a config) and removes its containers and volumes.

## [0.12.6] - 2026-10-25

Upgrading from 0.12.5: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.5. To see the suggested `SANDBOX_MAX_TOTAL` for an existing server, run the new `check-host.sh` (or look at the Overview).

### Added

- **Whole folders on the Files tab:** **Upload folder…**, or drop a folder on the list, uploads it with everything in it (four files at a time); folders that are not there yet are made, empty ones too when dropped. `PUT /sandboxes/:name/files/content` makes the missing folders on its path instead of answering 404.
- **A suggested `SANDBOX_MAX_TOTAL` for the host:** twice as many sandboxes as can all use their full CPU and memory limits at once, at most as many as the disk holds at `SANDBOX_DISK` each. `setup.sh` puts it into a new `.env` instead of 200 (a number of your own stays), `check-host.sh` prints it and warns when `.env` has one well above it, and the admin's Overview shows it under Host resources. See [Configuration](docs/configuration.md).

## [0.12.5] - 2026-10-25

Upgrading from 0.12.4: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml` (it passes the new `OIDC_ADMIN_EMAILS` and `UI_HOST` to Purgatorium), then `docker compose pull && docker compose up -d`. Without either set, nothing changes. A `docker-compose.yml` you keep from before stays on 0.12.4.

### Added

- **`OIDC_ADMIN_EMAILS`:** the addresses on it are the admin when they sign in with Google (OIDC) in the browser, as the local admin is, and their sandboxes have no limits. Their tokens stay a user's; taken off the list (after a restart), their session is a user's again at once. The local admin stays.
- **`UI_HOST`:** the UI's address, `p9m.<HOST_DOMAIN>` by default, e.g. `console.example.com` while the sandbox apps stay `<sandbox>-<subdomain>.example.com`. `setup.sh` makes `PUBLIC_URL` from it. A sandbox name whose app addresses would include it is refused. See [Configuration](docs/configuration.md).

## [0.12.4] - 2026-10-25

Upgrading from 0.12.3: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.3.

### Added

- **A light theme:** the web UI follows the device's light or dark setting, until the account picks one with the sun / moon button in the top bar; the choice is kept for the account (`PUT /me/theme`, `theme` in `GET /me`). The page shown while a sandbox wakes up, the error pages, the terminal and the logs stay dark ([#4](https://github.com/csakaszamok/p9m/issues/4)).

## [0.12.3] - 2026-10-25

Upgrading from 0.12.2: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.2.

### Fixed

- **A sandbox whose stack publishes no port** (only workers, or only `127.0.0.1:` ports) becomes healthy: socat's health check waited for an HTTP proxy that never came, so such a sandbox had no router and every start or wake waited for the full timeout. Now frpc's readiness marker (`<name>.ready`) online for 15 seconds is enough when there is no HTTP proxy; a stack with an app is still healthy once its proxy is online. Sandboxes created before keep their old check: re-create one that has no public port ([#1](https://github.com/csakaszamok/p9m/issues/1)).
- The version links at the bottom of this changelog point to `csakaszamok/p9m` and cover every release.

## [0.12.2] - 2026-10-25

Upgrading from 0.12.1: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (only the version changes). A `docker-compose.yml` you keep from before stays on 0.12.1.

### Added

- **A newer release in the topbar** (the admin only): next to the version, `v0.12.3 available` when the running series has a newer release, or a quieter `v0.13.0 out` for a later series, linking to its release notes. The server checks GitHub's releases along with the star and fork counts, at most once an hour, and sends nothing about the installation; `GITHUB_STATS=off` turns it off.
- `scripts/release-downloads.mjs`: how often each release's files (`docker-compose.yml`, `setup.sh`…) were downloaded, a rough count of installations and upgrades.

## [0.12.1] - 2026-10-25

Upgrading from 0.12.0: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml`, then `docker compose pull && docker compose up -d` (besides the version, Traefik loses its `p9m.compose` label, so it is recreated once). A `docker-compose.yml` you keep from before stays on 0.12.0.

### Fixed

- **Deleting a sandbox Purgatorium does not know** removes nothing: the archive step only takes a known sandbox directory, never a path made up from the name (which could have been another directory).

### Removed

- What was left of upgrading an old checkout: Traefik's `p9m.compose` label in `docker-compose.yml`, and the notes about sandboxes or users "from before" in the docs.

## [0.12.0] - 2026-10-25

**Purgatory (p7y) is now Purgatorium (p9m).** There is no upgrade from Purgatory: install Purgatorium afresh ([install](docs/install.md)) in a new directory called `p9m`. Sandboxes, archives, users, tokens and settings are not carried over.

### Changed

- **The new name everywhere:** the repository `github.com/csakaszamok/p9m`, the image `ghcr.io/csakaszamok/p9m`, the documentation `csakaszamok.github.io/p9m`, the UI address `p9m.<domain>`, the Claude Code plugin (`/plugin marketplace add csakaszamok/p9m`, `/p9m:init`), the MCP Registry name `io.github.p9m-team/p9m` (remote `https://{purgatorium_host}/mcp`), settings `P9M_*` (`P9M_VERSION`, `P9M_API_BIND`; the scripts' `P9M_API`, `P9M_TOKEN`), labels `p9m.*` (`p9m.subdomain`, `p9m.access`, `p9m.publish`, …), sandboxes `p9m-<name>`, tokens `p9m_…`, the project folder `.p9m`.
- New sandboxes run foxglove 0.9.0 (`ghcr.io/csakaszamok/foxglove`), which names an app only after `p9m.subdomain`; the image is built on rododentron 0.4.0 (`ghcr.io/csakaszamok/rododentron`).

### Removed

- Everything that carried an older installation forward: the Leander names (`leander-*` sandboxes, `leander.*` labels, `ldr_` tokens, `LEANDER_*` settings, the `leander.<domain>` redirect), the label `frpc.subdomain`, `HOST_USERS_DIR` and the `./opt/users` mount, and the startup migrations of sandboxes from older versions (sandbox directories, archives, routers, the frps API password, socat's check, data volumes, resource limits).

## [0.11.12] - 2026-10-24

Upgrading from 0.11.11: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version).

### Changed

- **Lists ask Docker less:** a sandbox's container is inspected again only when its status changed since the last list (started, stopped, or a minute older), an asleep one's start error only when its state changed, and each compose file is parsed once per change instead of four times per row on every poll.

### Fixed

- **The MCP Registry entry under the new name** (`io.github.csakaszamok/p7y`) could not be published: the registry takes one server per remote address, and `https://p7y.{domain}/mcp` is the old `io.github.p7y-dev/p7y`'s, which stays at 0.11.10. The address is now `https://{purgatory_host}/mcp`, `purgatory_host` being Purgatory's own (its `PUBLIC_URL`), which also fits a server not at `p7y.<domain>`.

## [0.11.11] - 2026-10-24

Upgrading from 0.11.10: download the new `docker-compose.yml` from `https://github.com/csakaszamok/p7y/releases/latest/download/docker-compose.yml` (it pulls the image from `ghcr.io/csakaszamok/p7y`), then `docker compose pull && docker compose up -d`. A `docker-compose.yml` you keep from before stays on 0.11.10.

### Changed

- **The project moved to `github.com/csakaszamok/p7y`**, and with it its image: `ghcr.io/csakaszamok/p7y` (until 0.11.10 `ghcr.io/p7y-dev/p7y`, where those versions stay), the documentation (`csakaszamok.github.io/p7y`; the old address does not redirect), the Claude Code plugin's marketplace (`/plugin marketplace add csakaszamok/p7y`; one added as `p7y-dev/p7y` keeps working through GitHub's redirect) and the MCP Registry name (`io.github.csakaszamok/p7y`). The new `docker-compose.yml` pulls from the new place; one downloaded before keeps pulling the old versions from the old place.


## [0.11.10] - 2026-10-24

Upgrading from 0.11.9: download the new `docker-compose.yml` (its cache default is 30 days), then `docker compose up -d`. A `REGISTRY_CACHE_TTL` in `.env` still wins.

### Changed

- **The registry cache keeps an image for 30 days** by default instead of 7 (`REGISTRY_CACHE_TTL=720h`). The time only frees disk: a cached layer never changes, and a tag is checked with Docker Hub on every pull anyway, so after 7 days the same images were just downloaded again, every week. Where disk is short, set it lower (`168h` = 7 days, as before).

## [0.11.9] - 2026-10-24

Upgrading from 0.11.8: download the new `docker-compose.yml` (the registry cache is `registry:3.1.2`), then `docker compose pull && docker compose up -d`. The cache keeps what it has.

### Added

- **`REGISTRY_CACHE_TTL`:** how long the sandboxes' Docker Hub cache keeps an image (default `168h`, as before; `0` = for ever). The time counts from the image's first download, and pulling it again does not extend it: an image cached 6½ days before a workshop was downloaded again during it. See [Configuration](docs/configuration.md).

### Changed

- **The registry cache runs `registry:3.1.2`** instead of `registry:2.8.3` (only 3 lets the cache time be set). It serves what 2.8.3 cached. What was cached before keeps its old expiry (7 days from its download), unless `REGISTRY_CACHE_TTL=0`: then nothing expires, that included.
- **The load test** (`tests/load/soak.sh`) says where the images came from: before the run, whether the test app's image is in the registry cache; after it, how much the cache downloaded from Docker Hub and which images the server pulled itself. A second run should download nothing.
- **Releases publish the newest version to the MCP Registry** themselves (GitHub's OIDC token, no one signs in).

## [0.11.8] - 2026-10-24

Upgrading from 0.11.7: `docker compose pull && docker compose up -d` (the `docker-compose.yml` changes only in the image version).

### Changed

- **The top bar loads faster** (`GET /me`, asked on every page): it counts the caller's sandboxes for the quota, the running limit and the server's places from one listing of the sandboxes instead of three. On a test server with 26 sandboxes it took 0.5–0.9 s, now 0.2–0.3 s.

## [0.11.7] - 2026-10-24

Nothing changes in Purgatory itself; upgrading from 0.11.6 is optional (`docker compose pull && docker compose up -d`).

### Changed

- **The load test** (`tests/load/soak.sh`) also times the admin's pages: the list of all sandboxes, the Overview and one sandbox's page, next to the users' own lists.
- **The README** states the key idea: hide the complexity, keep it simple, focus on what matters.

## [0.11.6] - 2026-10-24

Upgrading from 0.11.5: download the new `docker-compose.yml` (it sets Purgatory's DNS timeout), then `docker compose pull && docker compose up -d`.

### Fixed

- **Purgatory slowed down for everyone with many sandboxes** (a list took seconds while the server was idle): a name that does not resolve (a sandbox's frps, which Purgatory never reaches, or a sandbox just removed) waited 5 s for the host's resolver and held up Purgatory's other lookups meanwhile. Purgatory no longer asks for frps by name, gives up on a name after 1 s (`dns_opt` in `docker-compose.yml`) and resolves on 16 threads instead of 4.
- **A sandbox sysbox would not start again** ("already pre-registered" with sysbox-fs, after a failed start) could not be woken; its containers are now recreated, its data stays.
- **Deleting many sandboxes at once** made everything else wait while their volumes were archived: at most 4 are archived at a time, the others wait their turn.

## [0.11.5] - 2026-10-24

Upgrading from 0.11.4: download the new `docker-compose.yml`, then `docker compose pull && docker compose up -d --remove-orphans` (the `error-pages` container is gone; its volume can go too: `docker volume rm <project>_error_pages`). When Purgatory starts, every sandbox's socat is recreated once (see Changed): a running sandbox's web addresses are gone for a second or two.

### Changed

- **Purgatory serves the 404 page itself**, on its internal port, instead of a separate nginx container (`error-pages`): one container and one volume fewer. The page is the same and still links to `PUBLIC_URL`. While Purgatory is down or restarting (a few seconds on an upgrade), a sandbox app's 404 reaches the browser as an empty 500, since Traefik cannot fetch the page; addresses without a sandbox already needed Purgatory.
- **Faster with many sandboxes** (a load test of 20 users with 3 sandboxes each: the list took 8–15 s, the Docker daemon was at 4 cores):
  - A user's sandbox list asks only their own running sandboxes for their apps, not every one on the server; callers asking for the same sandbox at once share one answer; the Overview, disk sampling and registry sign-in no longer ask for apps at all.
  - socat checks a running sandbox's tunnel every 10 s instead of every 2 s (each check is a `docker exec`); while it starts, still every 0.5 s, so a wake is as fast. A broken tunnel takes its router away within 2 minutes, as before. Existing sandboxes get this when Purgatory starts: socat is recreated, so a running sandbox's web addresses are gone for a second or two. On Docker Engine below 25 (no `start_interval`) the check stays at every 2 s.
  - CPU and memory are sampled every 10 s instead of every 5 s.
- **A sandbox that does not answer in time** (a busy server) shows the apps it had last time, with ⚠ *Could not see its apps just now* on the Apps tab and in the list, instead of no apps. The API says so with `apps_stale: true`.

## [0.11.4] - 2026-10-23

Upgrading from 0.11.3: download the new `docker-compose.yml` (it passes `USER_VIEW_SWITCH` and `HOST_MOUNT_ROOTS` to Purgatory), then `docker compose pull && docker compose up -d`. **Users lose the Simple | Advanced switch and stay in Simple** unless you set `USER_VIEW_SWITCH=true` (see Changed). New sandboxes run foxglove 0.8.0; existing ones keep their image, so in them use `frpc.subdomain` rather than `p7y.subdomain`.

### Added

- **Host folders in a sandbox:** the admin can mount host folders into an existing sandbox (**Resources** tab → **Host folders**, or `GET`/`POST`/`DELETE /sandboxes/:name/mounts`, over MCP `list_sandbox_mounts`, `add_sandbox_mount`, `remove_sandbox_mount`), read-write or read-only, at `/mnt/<name>` or a path of their choice; the apps in the sandbox's own Docker can bind them too. Only folders at or under the new `HOST_MOUNT_ROOTS` (a comma list, e.g. `/srv/shared`; empty: off). A host folder that does not exist is refused by Docker, not created empty. Adding or removing one recreates the sandbox container (a running one restarts). The owner sees the list, read-only. **A mount gives the sandbox's owner that host folder as root:** mount only what they may see, read-only what they need not change.

- **`p7y.subdomain` label:** the preferred name for `frpc.subdomain`, which gives an app in a sandbox the short address `<sandbox>-<subdomain>.<domain>` ([Isolation and TCP addresses](docs/networking.md#app-web-addresses)). `frpc.subdomain` keeps working; if a container has both, `p7y.subdomain` wins. The built-in templates and the docs use the new name. The sandbox's foxglove image must be 0.8.0 or newer for frpc to read `p7y.subdomain`: with an older image the app keeps its long address. A sandbox keeps the image it was created with, so only new sandboxes get 0.8.0; in older ones use `frpc.subdomain`.

### Changed

- **Users stay in the Simple view** unless `USER_VIEW_SWITCH=true`: without it the top bar has no **Simple | Advanced** switch for them, and `PUT /me/view` answers 403. A view a user chose before is kept, and comes back when the switch is turned on. The admin can always switch. `GET /me` says whether the account may switch, as `view_switch`.

## [0.11.3] - 2026-10-21

Upgrading from 0.11.2: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version).

### Fixed

- **A sandbox with a non-public app never went to sleep** (since 0.9.0): the app access check sent Purgatory's own Sablier probe to the sign-in page, so the sandbox got no session, its idle countdown never started (*not counting yet*), and the log said *could not open a Sablier session*. The probe's address now passes, unless an app uses it.

## [0.11.2] - 2026-10-21

Upgrading from 0.11.1: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version).

### Changed

- **Dependencies:** dockerode 5 (without the `uuid` package), TypeScript 7 and vitest 5 for the type check and the tests. js-yaml stays on 4.x: version 5 reads YAML differently (no `<<` merge keys, `yes` is no longer true), which would change how compose files read.

### Fixed

- **The image's license label** (`org.opencontainers.image.licenses`) said Apache-2.0 since the switch to the AGPL-3.0.

## [0.11.1] - 2026-10-21

Upgrading from 0.11.0: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version).

### Fixed

- **The install test** looked for the old 404 page's text, so CI failed since the new 404 page (nothing changes for a running server).

## [0.11.0] - 2026-10-21

Upgrading from 0.10: download the new `docker-compose.yml` (it passes `PUBLIC_URL` to `p7y-init`, for the 404 page's link to Purgatory; without it the page guesses `p7y.<domain>`), then `docker compose pull && docker compose up -d`. A server that follows the 0.10 series (`P7Y_VERSION=0.10`) moves with `P7Y_VERSION=0.11`. **From this version Purgatory is licensed under the AGPL-3.0** (see below); 0.10.3 and earlier stay Apache-2.0.

### Changed

- **License: AGPL-3.0** (`AGPL-3.0-only`) from this release, instead of Apache-2.0; versions up to 0.10.3 stay Apache-2.0. Free to use, also commercially; whoever changes Purgatory and lets people use it over the network gives them the changed source too. Additional terms (section 7, in [NOTICE](NOTICE)): a work based on Purgatory says *Based on Purgatory (p7y)* in its About page and docs, is marked as changed, and does not take the names "Purgatory" or "p7y". Contributions: licensed under the AGPL-3.0, with the right for the authors to release them under other licenses too (CONTRIBUTING).

### Added

- **About page** (`/about`, no sign-in; linked from the sign-in page, the top bar and the Hub): the license, the source code of the running version and the attribution, also with an own `UI_TITLE` and `UI_LOGO`.

### Fixed

- **The 404 page** (any address without a page) was a copied template that loaded its pictures from another site over plain http and sent **Go back home** there. Its own page now: nothing loaded from elsewhere, **Go back**, the site's start page and a link to Purgatory (`PUBLIC_URL`, which the `docker-compose.yml` now passes to `p7y-init`; without it the page guesses `p7y.<domain>`).

## [0.10.3] - 2026-10-21

Upgrading from 0.10.2: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version).

### Changed

- **The Claude Code tutorial** walks through connecting a project folder to a sandbox with `/p7y:init` step by step, with the approval page, what to do when a code runs out, and moving a folder to another sandbox.
- **Smaller image:** `better-sqlite3`, unused since the database went, is no longer installed.

### Fixed

- **Dependencies:** js-yaml 4.3.2, @grpc/grpc-js 1.14.6 (GHSA-f596-whhp-79r4), protobufjs 7.6.6 (GHSA-j3f2-48v5-ccww) and source-map-js 1.2.2 (CVE-2026-93749, development only). The GitHub Actions the workflows use are updated, still pinned to commits.

## [0.10.2] - 2026-10-21

Upgrading from 0.10.1: download the new `docker-compose.yml` (it passes `UI_TITLE`, `UI_LOGO` and `GITHUB_LINK` to Purgatory), then `docker compose pull && docker compose up -d`. Claude Code plugin users: `/plugin marketplace update p7y`, then `/p7y:init` once in each project (Purgatory shows the line under **Let your agent deploy…**); the plugin no longer asks for an address or a token.

### Changed

- **The Claude Code plugin keeps no address and no token** any more, and no longer brings the MCP server: each project's `.p7y` folder says which Purgatory and which sandbox it belongs to, and the deploy skill works from `.p7y/p7y.env` with the REST API. **Let your agent deploy…** shows two install lines and the `/p7y:init` line, in place of **Create token** and the long `--config` command. Upgrading: `/plugin marketplace update p7y`, then `/p7y:init` once in each project. The server's own MCP endpoint stays.

### Added

- **Users on the admin's Overview**: every account that signs in, with when it was first and last seen, its last sign-in and how many, its sandboxes now and created, and its last API use; *no sandbox yet* marks who signed in but never created one. Kept in `data/user-stats.json` until the admin deletes a row (`GET /users`, `DELETE /users/:account`).
- **`/p7y:init <address> <sandbox>`** in the Claude Code plugin: ties a project to a sandbox. Claude Code prints a link, the sandbox's owner approves it in the browser, and the project's `.p7y` folder (a token for that sandbox only, named `Claude Code init <date>`, and its Docker keys) goes straight to disk, never through the chat.
- **`POST /device/code`, `POST /device/poll` and the `/activate` page**: the device approval behind it. Codes live 10 minutes and work once; the approved link is the single-use link of `project_dir_link`.
- **Own name and logo, no GitHub card**: `UI_TITLE` replaces *Purgatory* at the top left, on the sign-in page and in the tab titles, `UI_LOGO` the logo (an `https://` address or an image file such as `/app/data/logo.png`), `none` hides either; `GITHUB_LINK=off` takes the GitHub card out of the topbar.
- **Filter in My sandboxes** too, not only in All sandboxes: free text (every word must match the name, status, template, runtime, an app's service or address, and the owner) and a status list (running, asleep, deep sleep).

## [0.10.1] - 2026-10-20

Upgrading from 0.10.0: `docker compose pull && docker compose up -d`.

### Fixed

- **Apps of the same name in different compose projects** (a `web` service in each) are told apart: the Apps tab shows them as `first / web`, `hello / web`; a name of its own stays as it is. `GET /sandboxes/:name` gives each app's compose `project`.

## [0.10.0] - 2026-10-20

Upgrading from 0.9: `docker compose pull && docker compose up -d` (the `docker-compose.yml` is unchanged but for the version). Claude Code plugin users: `/plugin marketplace update p7y`; the plugin no longer runs a helper on the user's machine.

### Changed

- **`GET /sandboxes/:name` (`get_sandbox`) no longer gives the Docker client certificates and private key** unless asked for with `?include_keys=true` (`include_keys: true` over MCP). A key in an answer goes into an agent's context and transcript, and an agent copying it by hand garbled it: a user's deploy failed with *tls: failed to parse private key*. A script that reads `ca_cert`, `client_cert` or `client_key` adds the parameter.

### Added

- **`project_dir_link`** (`POST /sandboxes/:name/project-link`): a link that works once, for 5 minutes, to the project's `.p7y` folder as a tar (`.gitignore`, `p7y.env`, the Docker keys, checked against each other first). The agent unpacks it with `curl -sf "<link>" | tar -x -C <project>`, so a key never passes through the model; a used or expired link answers 410. A token limited to one sandbox may ask for it. The Claude Code plugin's deploy skill uses it, creates the docker context again (it keeps copies of the files), checks Docker with `compose ls`, gets a new link after new keys or any TLS error, and waits for a new app to show in `apps`.
- `GET /me` (`who_am_i`) gives Purgatory's own address, `url`.

## [0.9.1] - 2026-10-19

Upgrading from 0.9.0: download the new `docker-compose.yml` (it passes the new sleep limits to Purgatory), then `docker compose pull && docker compose up -d`.

### Added

- **Sleep limits** for users' sandboxes: `SANDBOX_MAX_IDLE_TIMEOUT` and `SANDBOX_MAX_DEEP_SLEEP_AFTER` (e.g. `2h`, `1d`; unset: no limit, as before). A longer value, or never, is refused with *at most 2h on this server*; a template's longer default is cut to the limit; the admin is not limited. Together with `SANDBOX_MAX_CPUS` / `SANDBOX_MAX_MEMORY` this keeps a shared server (a workshop) from being held by sandboxes that never sleep.

### Fixed

- The **Sleep settings** window sent both times even when only one was changed, and the **New sandbox** window always sent its prefilled times: now only what was changed, so a limit on one never stops a change of the other.

## [0.9.0] - 2026-10-19

Upgrading from 0.8: download the new `docker-compose.yml` (Traefik now also reads Purgatory's HTTP provider for the app access middlewares, on Purgatory's internal port 3001), then `docker compose pull && docker compose up -d`. On its first start Purgatory recreates every sandbox's socat container once (a running sandbox's apps are unreachable for a few seconds). Nothing changes for apps until you use `p7y.access` or set `APPS_ACCESS_DEFAULT`.

### Added

- **App access** ([docs](https://csakaszamok.github.io/p7y/latest/app-access/)): who opens each web app of a sandbox, with a `p7y.access` label: `public` (anyone, as before), `domain` (anyone who can sign in to this Purgatory) or `owner` (the sandbox's owner); the admin opens all. `APPS_ACCESS_DEFAULT` (default `public`) for apps without the label; an invalid value means `owner`. The first visit makes a short sign-in hop to Purgatory and back; the app gets `X-P7y-User` (who is viewing), never Purgatory's sign-in. An asleep app wakes only for someone who may open it. Owner-only apps are not published on the Hub; Hub-only viewers see public apps. HTTP only: TCP addresses are not covered. Upgrading recreates each sandbox's socat container once (its apps are unreachable for a few seconds), and Traefik reads Purgatory's new HTTP provider (`docker-compose.yml`).

## [0.8.0] - 2026-10-19

Upgrading from 0.7: download the new `docker-compose.yml` (and see `env.example` for the new, optional Hub settings), then `docker compose pull && docker compose up -d`. The Hub stays off unless `HUB_ENABLED=true`; with single sign-on it also needs `https://hub.<HOST_DOMAIN>/auth/callback` at the provider.

### Added

- *Sleep after no traffic* (`idle_timeout`) takes days too, as the deep sleep time does: `1d` is kept as `24h` (Sablier's durations have no days).
- **Tutorials** in the docs ([Tutorials](https://csakaszamok.github.io/p7y/latest/tutorials/)), for people who just want their app online: with Claude Code and the p7y plugin, with any agent and the zip, and sharing an app on the Hub. The plugin's deploy skill also knows the Hub's labels.
- **The `.p7y` folder**: an export for coding agents (and the Claude Code plugin's deploy skill) puts a project's sandbox access in a `.p7y` folder in the project's root: `p7y.env`, the Docker keys, a README, and a `.gitignore` of `*`, so git leaves it out without changing the project's own `.gitignore`. The zip used to hold a `p7y-<sandbox>/` folder; agents still read that. In the Simple view, **Let your agent deploy…** offers the Claude Code plugin (**Create token** makes a token for the sandbox and a two-line command with it to paste into a terminal: `claude plugin marketplace add …`, `claude plugin install … --config …`) or the zip for other agents, which the agent unpacks itself.
- **Claude Code plugin** ([docs](https://csakaszamok.github.io/p7y/latest/claude-plugin/)): `/plugin marketplace add csakaszamok/p7y`, `/plugin install p7y@p7y`. It asks for your Purgatory's address and a token (kept in the system's secure storage), connects its MCP server, and adds a deploy skill (`/p7y:deploy`): *put my app online* picks or creates a sandbox, wakes it, deploys with Docker, checks the app answers and gives its address. Also in the Claude desktop app's Code tab; Claude chat and Cowork get only the skill.
- **Simple and Advanced views** ([docs](https://csakaszamok.github.io/p7y/latest/web-ui/#simple-and-advanced)): a switch in the top bar, remembered per account. Simple, the default for users, shows only what someone who wants an app online needs: the apps' web addresses, **Let your agent deploy…**, Wake/Sleep, when it last ran and the sleep times. Advanced, the default for the admin, is the UI as it was. **Let your agent deploy…** (on the Apps tab in both, and on Access in Advanced; it replaces *Export for coding agents…* and *Copy as .env*) is the same window in both views: the Claude Code plugin or a zip for other agents; Advanced adds its **Options** (token name and expiry, a zip without the Docker keys, **Copy as .env**), Simple uses a token for 90 days. Simple only hides; permissions, the API and MCP are the same. `PUT /me/view`, and `view` in `GET /me`.
- **When a sandbox last ran**: a sandbox that is asleep or in deep sleep says so on its panel's Details tab (*Last ran: 3 weeks ago*) and its apps on the Hub (*asleep · ran 3 weeks ago*); `GET /sandboxes/:name` gives `last_running_at`. Asleep, it is when its container stopped; Purgatory now keeps that time when it takes a sandbox into deep sleep. A sandbox already in deep sleep before this upgrade gets an estimate (`~`, `last_running_estimated`).
- **The Hub** ([docs](https://csakaszamok.github.io/p7y/latest/hub/)): the apps builders publish with a `p7y.publish: "true"` label (or `"1"`), at their own address `hub.<HOST_DOMAIN>`, for colleagues who only use them: search, *Popular* and *New*, whether an app runs or sleeps, **Open** (an asleep app wakes). Viewers sign in with the same single sign-on but only to the Hub (`HUB_ALLOWED_DOMAINS`, `HUB_ALLOWED_EMAILS`); everyone signed in can vote once per app, their own too. A card shows the app's image: `p7y.image` (a path inside the app) or its page's og:image, fetched in the background without waking anything; else the title's letter. An RSS and a JSON feed with a secret key (*Overview → Create feed link*). Off unless `HUB_ENABLED=true`; with single sign-on, add `https://hub.<HOST_DOMAIN>/auth/callback` at the provider. A published app has an *On the Hub* marker on the *Apps* tab.

### Changed

- The sandbox panel's **Settings** tab is called **Details**, and it says when an asleep sandbox goes into deep sleep and when it last ran; the panel's header keeps only what matters now (*Sleeps in …*, *Asleep*, *In deep sleep*).
- Single sign-on asks the provider for `profile` too (`openid email profile`): the Hub shows owners by name. An account that may use only the Hub is sent there by Purgatory's sign-in.

### Fixed

- The README in an export for coding agents said that connecting with Docker wakes the sandbox; it does not: wake it first.

## [0.7.3] - 2026-10-19

Upgrading from 0.7.2: download the new `docker-compose.yml`, then `docker compose pull && docker compose up -d`.

### Fixed

- Two sandboxes created with the same name at the same moment (two users typing the same name) both went ahead and worked on one sandbox, the second user getting the first one's. Now one is created and the other is refused: *Sandbox already exists*.
- After clicking another sandbox in the list, its panel kept showing the previous sandbox's details until the new ones arrived, for seconds on a slow or busy server. It now shows the clicked sandbox's name and status at once, its details loading.

## [0.7.2] - 2026-10-19

Upgrading from 0.7.1: download the new `docker-compose.yml`, then `docker compose pull && docker compose up -d`.

### Fixed

- **Export for coding agents** always showed *Enable Docker access and export* beside *Download*, also for sandboxes whose Docker access was ready: a button's style overrode `hidden`. Pressing it made new Docker keys (earlier exports stopped working) and restarted the sandbox, its apps unreachable for a few seconds. Hidden buttons now stay hidden everywhere in the UI.
- A sandbox recreated while asleep (by an upgrade's migration) and not started since never went into deep sleep and showed no *Deep sleep in*: its container has no stop time. Deep sleep now counts from when it was recreated, so it never comes earlier than it should; such sandboxes that have waited longer than `deep_sleep_after` go into deep sleep at the first check after the upgrade (their data stays).
- A sandbox whose idle time had just run out showed *not counting yet* for a few minutes while still running: Sablier drops an expired session at once but stops the containers a few minutes later. It now shows *going to sleep…* (`going_to_sleep` in the API).
- The log line of a sandbox taken into deep sleep (`[deep-sleep] … asleep since …`) showed Docker's empty stop time (`0001-01-01…`) for a sandbox recreated and never started; it now shows since when it has been asleep.

## [0.7.1] - 2026-10-17

Upgrading from 0.7.0: download the new `docker-compose.yml`, then `docker compose pull && docker compose up -d`.

### Added

- Purgatory is in the official MCP Registry as `io.github.csakaszamok/p7y` (`server.json`): a client that reads the registry asks for your server's domain and a token.
- `scripts/mcp-stdio.mjs`: the MCP server over stdio, for clients that only start a local process. Node.js 18+, no packages; it passes each message to `/mcp` with `P7Y_TOKEN` ([MCP](https://csakaszamok.github.io/p7y/latest/mcp/)).

### Changed

- The OpenAPI document (`/swagger.json`) gives Purgatory's own version instead of `1.0.0`, and the API page says how to generate a client from it ([OpenAPI and clients](https://csakaszamok.github.io/p7y/latest/api/#openapi-and-clients)).

## [0.7.0] - 2026-10-16

Upgrading from 0.6: download the new `docker-compose.yml` (it names this version), then `docker compose pull && docker compose up -d`; nothing is migrated. Existing sandboxes keep running on foxglove 0.6.0; new ones get 0.7.0 (see *Changed*). A request body may now be at most `FILES_MAX_UPLOAD` (100m): raise it if you send larger ones to the API.

### Added

- **Files** tab: browse a sandbox's files, upload them (pick or drop, several at once), download a file or a whole folder (.tar), make folders and delete. It shows `/root`, `/home`, `/srv` and `/opt`, the folders that are kept over a deep sleep, and, under **Volumes**, the volumes of the apps in the sandbox's own Docker (with the containers that use them, and a warning while one of them runs), and works while the sandbox runs (asleep, it offers to wake it). The same in the API (`/sandboxes/:name/files`, `/sandboxes/:name/volumes`, also for a token limited to the sandbox) and as MCP tools, so an agent can read and write files too. `FILES_MAX_UPLOAD` (100m) is the largest file; it is also the cap on any request body now, which used to be read whole into memory without a limit.
- **A guaranteed quota and a maximum while there is room:** `SANDBOX_QUOTA` (3) is now guaranteed to every user, and `SANDBOX_QUOTA_MAX` (e.g. `10`) lets them run more while the server has room. Above the guarantee a new sandbox, or one woken, must leave room for every other owner to reach their guarantee (their running sandboxes hold their places already) and for one newcomer; otherwise it is refused with why (409, the wake page says so too), and **Wake** offers to put one to sleep. Nobody is ever put to sleep to make room. Unset, nothing changes. The Overview shows *2 more guaranteed · up to 10 while the server has room*, the owner table *4 / 3 (+7)*.
- The top bar shows the server's sandbox places on every page, to everyone signed in: e.g. *142 / 200 places*, the free ones on hover, orange from 90% and red when the server is full. `GET /me` (and the MCP tool `who_am_i`) gives them as `server_places`.

### Changed

- A `NOTICE` file: who ships Purgatory or a product built on it keeps it (Apache-2.0, section 4), so its users see it is based on Purgatory. It is in the image with the licence (`/app/p7y/`). The licence stays Apache-2.0.
- New sandboxes run foxglove 0.7.0, now from `ghcr.io/p7y-dev/foxglove` (was `csakaszamok/foxglove` on Docker Hub): a port published on `127.0.0.1` (or `::1`) gets no tunnel any more, so it really is private to the sandbox, as the documentation already said (before, frpc still registered it). Existing sandboxes keep their image. The base image is `ghcr.io/p7y-dev/rododentron:0.3.1`, the same as `csakaszamok/rododentron:0.3.1`.

## [0.6.4] - 2026-10-15

Upgrading from 0.6.3: download the new `docker-compose.yml` (see [Upgrading](https://csakaszamok.github.io/p7y/latest/upgrading/)), because the image has moved to `ghcr.io/csakaszamok/p7y`; then `docker compose pull && docker compose up -d`. Images up to 0.6.3 stay at `ghcr.io/csakaszamok/p7y`.

### Changed

- The project has moved to [github.com/csakaszamok/p7y](https://github.com/csakaszamok/p7y): the documentation is at [csakaszamok.github.io/p7y](https://csakaszamok.github.io/p7y/latest/), the image at `ghcr.io/csakaszamok/p7y`. Links to the old repository redirect; the old documentation address does not.

## [0.6.3] - 2026-10-11

Upgrading from 0.6.2: as usual (`docker compose pull && docker compose up -d`). The server's places now count only running sandboxes: with `SANDBOX_MAX_TOTAL` set, more sandboxes may be asleep at once than before, and each keeps a Docker network until its deep sleep, so the host's Docker address pools must have room for them (`check-host.sh` says how many).

### Fixed

- The server's sandbox places (`SANDBOX_MAX_TOTAL`) counted asleep sandboxes too: with one running and 18 asleep the top bar and the Overview said *19 / 200 places*. Only running sandboxes take a place now, the admin's included, so letting a sandbox sleep frees it for everyone: the top bar, the sign-in page, the Overview's card and bar, and the server-full check of a create or a wake (from sleep too now, since it takes a place).
- Waking a sandbox at an app's address opened a 404 page while that app was still starting (Redmine takes about a minute): the sandbox's router comes up with its first tunnel, and frps answers 404 for an app whose port does not answer yet. The waiting page now asks Purgatory whether the app at its address answers (`GET /wake/ready?host=…`, probed on the sandbox container, which neither wakes nor keeps it awake) and keeps waiting, saying *starting redmine…*, for up to 5 minutes.

## [0.6.2] - 2026-10-10

Upgrading from 0.6.1: as usual (`docker compose pull && docker compose up -d`).

### Fixed

- The bar under the admin's Overview cards was scaled to the sandboxes there are, not to the server's places: with one running and one asleep of 200 places it was half full. It now shows the awake sandboxes against `SANDBOX_MAX_TOTAL` (deep sleep holds no place), and its legend says how many places are free.
- A user's Overview bar was full with two sandboxes running of two, though a third could run: it is now scaled to their running limit while they have fewer sandboxes than that.

## [0.6.1] - 2026-10-10

Upgrading from 0.6.0: as usual, with the new `docker-compose.yml` (it tells Traefik to apply new routes after 0.5 s); then `docker compose pull && docker compose up -d`. Sandboxes created before keep their socat health check as it was.

### Changed

- **New sandbox**: the compose is in a section that starts closed, so the dialog fits without scrolling when the template's stack is used as it is. It opens by itself for the `empty` template, for a compose of your own kept from a failed create, and when the create fails on the compose.
- **Creating a sandbox is faster: about 7.5 s instead of 9.3 s** until its app answers at its address (measured on a development machine). The inner stack tries again every 0.5 s instead of 3 s while the sandbox's own dockerd starts; Traefik applies new routes after 0.5 s instead of its default 2 s (`--providers.providersThrottleDuration=500ms` in `docker-compose.yml`); socat's health check runs every 0.5 s while it starts (`start_interval`, Docker Engine 25 or newer; left out on an older engine). Each create logs where its time went, e.g. `[create] p7y-shop ready in 7.5 s: … inner stack 3.1 s (3 tries), tunnel 0.5 s, router 2.1 s`.

### Fixed

- A user's create or wake counted the server's sandboxes for the quota with the full list, which asks every running sandbox's own Docker for its apps: about 2 s per create here, more on a server with many sandboxes. Counting now reads only states and owners.
- The server's sandbox places (`SANDBOX_MAX_TOTAL`) did not count the admin's sandboxes, although each holds a Docker network like any other: with one of the admin's running, the sign-in page said "0 taken · 200 free". They count now (the sign-in page, the Overview's "Sandbox places used", the server-full check); the admin is still never refused. A user was also told the server was full while some of the places counted were sandboxes in deep sleep, which hold none.
- A request to a sandbox's address while it was being created (an agent polling it, a browser tab opened early) read as a sandbox in deep sleep and started a second compose up next to the create's. It now gets the waiting page until the create is done; TLS TCP addresses wait too.
- A new sandbox's app links work when the create answers: it now waits for the sandbox's router (up to ~10 s) instead of answering as soon as the tunnel was up, so opening an app at once no longer lands on the waiting page. The panel shows the new sandbox's details before reloading the whole list, which takes seconds on a server with many sandboxes; the waiting page of a sandbox woken from sleep reloads every second instead of every 3 s.
- The waiting page of a sandbox woken from sleep said "rebuilding after a long sleep" from its first reload on, as if it had been in deep sleep. It now keeps saying "waking up"; only a deep-sleeping sandbox is rebuilt.

## [0.6.0] - 2026-10-10

Upgrading from 0.5: as usual (`docker compose pull && docker compose up -d`). At its first start Purgatory gives every sandbox's frps API a password, which recreates their frps and socat containers: running sandboxes' web addresses are gone for a few seconds. If you sign in with Google (or any provider anyone can get an account at), set `OIDC_ALLOWED_DOMAINS` or `OIDC_ALLOWED_EMAILS`: until you do, anyone can sign in, as before.

### Added

- While a sandbox is not running, `docker_access` in `GET /sandboxes/:name` (and the MCP tool `get_sandbox`, and the **Access** tab) carries a `hint`: a Docker connection does not wake it, so start it first. The `docker` command line only gets EOF then, which said nothing to an agent.
- **Who may sign in:** `OIDC_ALLOWED_DOMAINS` (e.g. `example.com,partner.org`, the exact domain) and `OIDC_ALLOWED_EMAILS` (single addresses). Until now anyone with an account at the OIDC provider could sign in and create sandboxes, with Google any Google account; an account not on the list is now told so on the sign-in page. It is checked on every request too: someone taken off the list (after a restart) is signed out and their tokens stop working at once. The admin is never limited. Without either setting nothing changes, and Purgatory says in its log at startup that anyone can sign in.
- The sign-in page shows the sandbox places on the server above the sign-in buttons: taken and free of `SANDBOX_MAX_TOTAL`, with a bar that turns orange from 90% and red when the server is full. The page is public: `LOGIN_CAPACITY=off` hides it. The count is kept for 30 seconds, so reloading the page does not list the sandboxes each time.

### Changed

- **A sandbox's frps API (`:7500`) has a password.** It lists the sandbox's proxies, and other sandboxes reach it over `traefik-net` through socat: without the password they now get 401. Each sandbox gets its own, in its `frps.toml`; Purgatory uses it to list the apps, socat's health check gets it in `FRPS_API_AUTH`. Existing sandboxes get one when Purgatory starts (their frps and socat containers are recreated: a running sandbox's web addresses are gone for a few seconds); one whose socat health check is not the runtime's (an edited runtime) keeps its API open and says so in the log.

### Fixed

- `p7y-init` emptied the volumes that Sablier, nginx and the registry read before filling them again, on every `docker compose up`: for a moment the error pages were nginx's own, and a run that failed (a release without one of its files) left them empty. It now checks every file first, puts each one in place under a temporary name, and only then removes what the release no longer has.

## [0.5.2] - 2026-10-09

### Fixed

- Every sandbox's socat relay ran with `-v`, which wrote every request and answer to its apps (passwords, tokens, cookies included) into the socat container's Docker log. It no longer does; existing sandboxes are switched over when Purgatory starts, and their socat container is recreated, which also drops the old log.
- `setup.sh` created `.env`, which holds the secrets, readable by every user of the machine. It is now readable by its owner only (`chmod 600`), also when it already existed.

## [0.5.1] - 2026-10-09

### Added

- `setup.sh <domain>` (piped: `| bash -s -- dev.example.com`) sets `HOST_DOMAIN` and `PUBLIC_URL` (`https://p7y.<domain>` if `certs/` holds a certificate, else `http://`; a `PUBLIC_URL` of your own is kept). Without a domain it warns that `lvh.me` only works on the machine itself: a new install used to answer 404 on its real address until `HOST_DOMAIN` was added to `.env` by hand, which no step mentioned. `env.example` has a `HOST_DOMAIN` line now.

### Changed

- **A Docker connection (`<raw>-docker.<domain>:443`) no longer wakes a sleeping sandbox.** Docker Desktop reconnects to every context at once, so it would wake the sandbox each time it fell asleep. Wake it first (**Wake**, `POST /sandboxes/:name/start`, the MCP tool `wake_sandbox`, or open one of its apps); until then `docker` cannot connect. TLS TCP addresses and SSH still wake it.

### Fixed

- A sandbox added as a Docker context in Docker Desktop never went to sleep: its Builds view keeps the connection to the sandbox's Docker open, and Purgatory renewed the sleep timer once a minute for as long as a Docker connection was open. It now renews it only while bytes go through the connection (a build, `docker logs -f`, a pull).

## [0.5.0] - 2026-10-09

Upgrading from 0.4: check that Docker Compose is 2.17 or newer **before** `git pull` (`docker compose version`), and read **Changed** first if you edited templates or runtimes in your checkout. Run `docker compose up -d --remove-orphans` right after the pull.

### Changed

- **Installed without a git clone**: `docker-compose.yml`, `setup.sh`, `check-host.sh` and `env.example` are files of each GitHub release (`releases/latest/download/…`), and the image carries everything else. A new one-shot service, `p7y-init`, copies the image's Sablier themes, error pages, registry config and `dynamic/errors.yml` into place on every `docker compose up`, so they always match the running version. Purgatory reads templates and runtimes from its image: **templates or runtimes edited in a checkout no longer apply**. See [Upgrading](https://csakaszamok.github.io/p7y/latest/upgrading/).
- `setup.sh` prepares the current directory (it no longer needs to sit in a checkout) and creates `data/`, `opt/`, `certs/`, `dynamic/`.
- Docker Compose 2.17 or newer is required; `check-host.sh` fails below it.
- Traefik waits for `p7y-init` and restarts when a new release recreates it; the upgrade from 0.4 recreates it once (the pull recreates `dynamic/`, which is now kept in git with a `.gitkeep`).
- A release checks that its `docker-compose.yml` runs the image of its own tag.
- Development: `docker-compose.dev.yml` now also builds the image and mounts the templates, runtimes and assets of the checkout.

### Fixed

- `setup.sh` stopped without a word on a machine whose `hostname` has no `-I` (macOS, busybox); it now falls back to `HOST_ADDRESS=localhost`.

## [0.4.2] - 2026-10-09

### Fixed

- A sandbox started without Purgatory opening its Sablier session (e.g. Purgatory restarted or upgraded just as it woke one) never went to sleep and showed "no traffic yet" until someone opened one of its apps. Purgatory now checks every minute: a sandbox running without a session on two checks in a row gets one, and sleeps after its `idle_timeout`. The list and the panel say "not counting yet" / "The idle countdown has not started yet" instead of suggesting there was no traffic.
- A single missed keep-alive of a Docker API connection (`*-docker`) no longer logs "could not open a Sablier session".

## [0.4.1] - 2026-10-09

### Changed

- Documentation: the `sysbox` runtime is used in production; on a shared server the recommended setting is sysbox on the host and `ALLOWED_RUNTIMES=sysbox` ([Security](https://csakaszamok.github.io/p7y/latest/security/)). The README no longer says that the default runtime is the privileged `dind`: with `DEFAULT_RUNTIME=auto` it is `sysbox` wherever sysbox is installed.

### Fixed

- The sandbox list (`GET /sandboxes`, and the MCP tool `list_sandboxes`) gave a sleeping or deep-sleeping sandbox no app addresses, while its details did. It now gives the same: the apps it had when it last ran.

## [0.4.0] - 2026-10-09

Upgrading from 0.3: `git pull` (or a checkout of `release/0.4`), then `docker compose pull && docker compose up -d`. The new settings are optional. Read **Changed** first if a client of yours creates sandboxes and uses their Portainer.

### Added

- `ALLOWED_RUNTIMES`: the runtimes new sandboxes may use (comma list, empty = all), e.g. `sysbox` so nobody creates a privileged `dind` sandbox on a shared server. The others are left out of `GET /runtimes` and the create form; asking for one is a 400. Existing sandboxes are not affected.
- The topbar links to the GitHub repo and shows Purgatory's version and its star and fork counts. The server fetches the counts at most once an hour, so users' browsers never contact GitHub; `GITHUB_STATS=off` turns the fetching off.
- **MCP server** at `/mcp` (Streamable HTTP): every API endpoint is a tool (`list_sandboxes`, `create_sandbox`, `wake_sandbox`, `sleep_sandbox`, …), run with the caller's token, so it can do what that token can do on the REST API; a token limited to one sandbox is offered only the tools it may call. Only tokens are accepted, not a browser session. Built on the base image `csakaszamok/rododentron:0.3.1`.
- **Documentation site** (MkDocs Material, GitHub Pages): the README's sections are now pages in `docs/`, one version per release series, with search and `llms.txt` / `llms-full.txt` for agents. The README is a short introduction.

### Changed

- **The `starter` template no longer has Portainer**, only the hello app: an agent deploys with the `docker` command line (the sandbox's own Docker daemon, with the client certificates `GET /sandboxes/:name` gives), SSH or MCP, and a sandbox no longer exposes a Portainer admin login on the internet unless asked for. The new **`portainer`** template is the former starter. A client that creates sandboxes without a template and reads `extras.portainer_url` / `portainer_password` must now ask for `"template": "portainer"`. Existing sandboxes keep their Portainer.
- **Creating a sandbox is faster** (about 10 s instead of 15 on a dev machine): Purgatory waits until the tunnel serves every app the inner compose publishes, instead of polling every 3 s until two answers match.
- The agent guide puts the `docker` command line first; Portainer is a section for sandboxes that have it. `P7Y_AGENT_GUIDE` in `p7y.env` points to its Markdown on the documentation site.
- Release images: `latest` is the highest version only, so a fix for an older series does not move it back; every release is also tagged `x.y` (e.g. `0.4`), the newest of its series.

### Fixed

- A sleeping sandbox's TCP addresses (Postgres, Redis, SSH… on port 443) were missing from its panel and from `GET /sandboxes/:name`, although a connection wakes it. They are now the ones it had when it last ran (kept in `tcp.json` in its directory, like the apps in `apps.json`).

## [0.3.1] - 2026-10-08

### Fixed

- A sleeping sandbox's **Apps** tab showed only the apps of its template's stack (e.g. Portainer and http-echo), not those deployed later through Portainer or SSH. It now shows the apps the sandbox had when it last ran (kept in `apps.json` in its directory); a sandbox not seen running since this version still shows its template's.

## [0.3.0] - 2026-10-07

The first release from the public repository. The images of 0.1.0 and 0.2.0 are no longer published: use 0.3.0 or later.

### Added

- `check-host.sh [domain]`: checks a machine before the first install — Linux and kernel, Docker and Compose, whether sysbox is there and works, how many sandbox networks the address pools allow, free ports 80/443/8081, disk, access to Docker Hub and ghcr.io, and with a domain its DNS records (the wildcard too) and the certificate in `certs/`. Changes nothing.

### Fixed

- **A sandbox's own files survive a deep sleep:** `/opt`, `/root`, `/home` and `/srv` of the sandbox container live in named volumes (`sandbox_opt`, …), like its inner Docker. Before, a deep sleep or a removed container lost what was written there. Existing sandboxes are moved over at startup: their current files are copied into the volumes (a running one restarts once).
- A sandbox put to sleep right after a wake no longer wakes again by itself (Purgatory's own session probe reached `/wake`).
- Disk use counts all of a sandbox's volumes.

### Changed

- **Sandbox files per owner:** `opt/sandboxes/<owner>/<name>/` instead of `opt/users/<name>/`, archives under `opt/archive/<owner>/` (the manifest names the owner). Existing sandboxes and archives are moved at startup; a running sandbox restarts once, asleep ones stay asleep, a failed move is retried at the next start. The `./opt/users` mount stays in `docker-compose.yml` for the move and goes in a later version. `HOST_SANDBOXES_DIR` replaces `HOST_USERS_DIR` (still read: its sibling `sandboxes` is used). Runtime files can use `${sandbox_dir}`; `${host_users_dir}/${name}` still names the sandbox's directory.
- `DEFAULT_RUNTIME` defaults to `auto`: new sandboxes use `sysbox` (no privileged container) where the host has sysbox installed, `dind` otherwise (with a warning at startup). Asking for `sysbox` on a host without it is a 400 that says so.
- Exact image versions instead of moving tags, so an updater such as Watchtower does not swap them on its own: `registry:2.8.3`, `traefik:v3.6.25`, `nginx:1.31.6-alpine`, and `alpine/socat:1.8.1.3` for new sandboxes (the same images the old tags point to today). Existing sandboxes keep `alpine/socat:latest`.

## 0.2.0 - 2026-10-06

### Changed (breaking)

- `SANDBOX_QUOTA` now counts **running** sandboxes per user (asleep and deep-sleeping ones are free); at the limit a create or a wake is refused. `SANDBOX_MAX_TOTAL` now defaults to `200` (users' running and asleep sandboxes on the server); set `0` for no server limit. A sleeping sandbox no longer has a Traefik router: every wake goes through Purgatory, so while it is down nothing wakes (running sandboxes keep serving).
- The registry's default domain is now `lvh.me`, like everything else (it was `my.local`, which made `registry.lvh.me` answer 404 when `HOST_DOMAIN` was not set): set `HOST_DOMAIN` if you relied on `registry.my.local`.
- A port an inner container publishes on `127.0.0.1` (or any one address) now gets no link, as it gets no TCP address: it is private to the sandbox. The starter and tcp-demo stacks publish on all interfaces now (they also get TCP addresses and other sandboxes can reach them). Existing sandboxes whose stack publishes on `127.0.0.1` (the old starter: Portainer, `http-echo`) lose those links until the compose file says `"9000:9000"` / `"5678:5678"` (Starter stack…); with the current foxglove image such an address still works for whoever knows it.
- A sandbox is now a **runtime** plus a **template**, picked separately: `runtimes/dind.yaml`, `runtimes/sysbox.yaml` (how it runs) and `templates/<name>/compose.yaml` with an optional `template.yaml` (what runs inside: `starter`, `tcp-demo`). `POST /sandboxes` takes `runtime` and `template`; the old names `dind-standard` and `sysbox-sandbox` now answer 400 `Unknown template` (use `runtime: "dind"` / `"sysbox"` with `template: "starter"`).
- New `DEFAULT_RUNTIME` (default `dind`); `DEFAULT_TEMPLATE` now defaults to `starter`. An `.env` still saying `DEFAULT_TEMPLATE=dind-standard` makes creates without a template fail with 400 `Unknown template`.
- `GET /templates` returns `name`, `description`, `default` (no more `runtime`, `port_ranges`); new `GET /runtimes` in the same shape. Sandboxes carry a `runtime` field (`""` for ones created before).
- With `create_inner_stack: false` the template's `before_script` no longer runs, so such a sandbox has no starter extras (Portainer password and URL).
- Existing sandboxes keep working from their own files; they show their old template name and no runtime.

### Fixed

- **Internal Server Error right after a wake:** Traefik reaches a sandbox's tunnel by name (`http://<name>-socat:8080`), not by the container's address, which it learned ~1.5 s after Sablier let the first request through. Existing sandboxes are switched over when Purgatory starts.

### Added

- **The quota counts running sandboxes:** `SANDBOX_QUOTA` (default 3) sandboxes run at once per user; asleep and deep-sleeping ones are not counted, so letting one sleep frees its place. At the limit a create or wake is refused (the address says *Running limit reached*) and **Wake** lets the owner choose one to put to sleep. Running sandboxes' web addresses no longer go through Purgatory: they keep working while it is down (TLS TCP addresses and Docker access still need it).
- **Overview page:** cards for running of how many allowed, asleep, deep sleep, archived (and a disk warning); for the admin also host CPU and memory, disk use and a table per owner, each linking to the filtered list. API: `GET /sandboxes/summary`.
- **`SANDBOX_MAX_TOTAL`** (default 200): the users' running and asleep sandboxes on the whole server, each with a Docker network (the admin is not limited and not counted).
- **Disk use per sandbox:** measured every 15 minutes while running, shown in the Resources tab against `SANDBOX_DISK` (20 GB; the admin can set it per sandbox); above it the panel and the list show ⚠. A warning only.
- **Copy as .env** and the export carry a Portainer API token (`P7Y_PORTAINER_URL`, `P7Y_PORTAINER_TOKEN`) instead of needing the Portainer admin password; without a public Portainer they say why it is missing.
- The token list shows each token's start and end (`p7y_aB3x…9fQz`) to tell them apart; tokens made before this show —.
- **Copy as .env** and **Export for coding agents…** at the top of the Access tab for every sandbox: before Docker access is enabled, export without the Docker keys or enable it in the same step.
- Coding agents: **Export for coding agents…** (a zip with a scoped token, Docker client keys and a README), the sandbox's Docker API at `<raw>-docker.<domain>:443` (TLS passed through, Enable / Rotate Docker keys), registry login with Purgatory tokens, anonymous pull of images that passed a secret scan, a **Registry** tab.
- The details panel has a header (status, main buttons, sleep countdown with Reset) and four tabs — **Apps** (a table: link, whether it answers, TCP address with copy, Connect…), **Access** (SSH, Portainer, token), **Resources**, **Settings** (with a danger zone: Deep sleep now, Archive…); the open tab is remembered. `GET /sandboxes/:name` `apps[]` carry `service`.
- **Reset** next to *Sleeps in*: starts a running sandbox's sleep countdown over (`POST /sandboxes/:name/keep-awake`, a token for that sandbox too).
- The panel marks a link whose app does not answer (⚠, with a tip); `GET /sandboxes/:name` has `apps[].answers`.
- **Download p7y.env** for a new access token: `P7Y_URL`, `P7Y_TOKEN`, `P7Y_SANDBOX`, `P7Y_AGENT_GUIDE` for a coding agent (made in the browser; the server keeps no copy).
- **Logs** in a sandbox's panel: the sandbox's app logs (every inner container, last 100 lines, then live) on their own page; `GET /sandboxes/:name/logs/stream` (Server-Sent Events, token too). Never wakes the sandbox.
- CPU and memory limits per sandbox (`SANDBOX_CPUS`, `SANDBOX_MEMORY`; users up to `SANDBOX_MAX_*`, the admin up to the host), changed live (**Resources…**, `PATCH` `cpus`/`memory`); current usage in the panel and the list. Older sandboxes get the default at startup.
- **Terminal** in a sandbox's panel: a root shell in the browser (nothing to install, no key); it wakes the sandbox and keeps it awake while open. Every SSH sandbox also gets a generated key (**Download key**, `GET /sandboxes/:name/ssh-key`).
- SSH into every new sandbox: root, keys only, at `<name>-shell-tcp.<domain>:443`; keys under **SSH keys** (`/ssh-keys`) and per sandbox (`ssh_keys`). Needs foxglove 0.6.0.
- New sandbox shows the chosen template's compose file and lets you edit it, or paste your own (`empty` template). API: `GET /templates/:name`, and `compose` on `POST /sandboxes`.
- The `tcp-demo` template: Postgres with sample data, Redis and SSH on TLS TCP addresses, pgweb in the browser, one generated password (in the panel and in **Connect…**, which shows the recipe for the service behind each address).

- TLS TCP addresses: every port an inner container publishes on all interfaces is reachable as `<http-name>-tcp.<domain>:443` (TLS only; Postgres with `sslmode=require`), waking the sandbox on connect.
- The details panel speaks the lifecycle: **Sleep**, **Deep sleep**, **Wake** and **Archive…** instead of Stop / Start / Delete, with visible progress while an action runs (archiving can take minutes). New `POST /sandboxes/:name/deep-sleep`.
- **Starter stack…** in the details panel shows the compose file of the starter stack Purgatory deployed into the sandbox, with secrets (password hashes, *token/password/secret/key* values) masked. New `GET /sandboxes/:name/compose`.
- The log says which address and client woke a deep-sleeping sandbox.
- An ember look: status dots that flicker (running), breathe (asleep) or turn to ash (deep sleep); a logo; drifting embers on the sign-in and waiting pages. The waiting pages update in place instead of reloading every few seconds. Still with reduced motion.
- Access tokens limited to one sandbox: they see and act on only that sandbox and cannot create or delete sandboxes or manage tokens.

### Fixed

- Archiving a sandbox in deep sleep now records its template and creation time in `manifest.json` (they were empty: there were no containers to read them from).
- Sandboxes of a checkout that was moved or renamed (e.g. `leander/` → `p7y/`) failed to start ("not a directory"), because their compose files point at the old directory. Purgatory now rewrites those paths at startup and recreates the sandboxes' containers.
- A sandbox whose last start failed is shown as "failed to start", with Docker's error, instead of "asleep".
- The waiting page no longer shows a sandbox woken from sleep in red ("container exited with code 2 / 137"): those containers are starting.
- A sandbox stops in under a second when it falls asleep; its socat container used to be killed after Docker's 10 s grace period (new sandboxes).
- The sandbox list no longer shows "-1 min" in Created when the browser's clock is behind the server's.

## 0.1.0 - 2026-09-28

The first release.

### Sandboxes

- Every sandbox gets its own Docker daemon (Docker-in-Docker, or sysbox with the `sysbox-sandbox` template), with Portainer and a starter stack.
- Every app published inside a sandbox gets a public address, `<name>-<app>.<domain>`, through an FRP tunnel. Ports published on `127.0.0.1` are reachable only through their tunnel.
- Sandboxes are defined by YAML templates.
- A per-sandbox image registry login, and a pull-through cache.

### Sleep, deep sleep, archive

- A sandbox sleeps after `idle_timeout` without HTTP traffic and wakes on the next request, with a waiting page meanwhile ([Sablier](https://github.com/sablierapp/sablier)).
- After `deep_sleep_after` asleep, its containers and network are removed and its data kept; the next request rebuilds it.
- Both times can be changed after creation, and `0` / `off` means never.
- Delete archives the sandbox's volumes and configuration; nothing is ever deleted automatically.

### Self-service

- Web UI: My sandboxes, All sandboxes (admin), Access tokens.
- Sign-in with OIDC (e.g. Google) for everyone, a local account for the admin.
- Users see and change only their own sandboxes; a per-user quota (`SANDBOX_QUOTA`).
- Personal access tokens for agents. An agent can deploy, build and update apps through the sandbox's Portainer API ([docs/agent-guide.md](docs/agent-guide.md)).

### Running it

- One `docker compose up -d`; `setup.sh` writes a `.env` with random secrets.
- A ready-made image: `ghcr.io/csakaszamok/p7y`.
- HTTPS with a copied-in wildcard certificate; with an `https://` `PUBLIC_URL`, Purgatory refuses to start with default secrets.

### Security

- The p7y container runs only the API. The base image's MCP Inspector, which ran without authentication and was reachable from sandboxes, is no longer started.
- The sandbox image (foxglove 0.5.10) recovers its tunnels after an abrupt kill.

### Renamed from Leander

- The project used to be called Leander. Existing `leander-` sandboxes and `ldr_` tokens keep working; see "Upgrading from Leander" in the README.

[Unreleased]: https://github.com/csakaszamok/p9m/compare/v0.18.1...HEAD
[0.18.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.18.1
[0.18.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.18.0
[0.17.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.17.0
[0.16.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.16.3
[0.16.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.16.2
[0.16.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.16.1
[0.16.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.16.0
[0.15.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.15.0
[0.14.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.14.1
[0.14.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.14.0
[0.13.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.13.3
[0.13.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.13.2
[0.13.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.13.1
[0.13.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.13.0
[0.12.25]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.25
[0.12.24]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.24
[0.12.23]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.23
[0.12.22]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.22
[0.12.21]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.21
[0.12.20]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.20
[0.12.19]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.19
[0.12.18]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.18
[0.12.17]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.17
[0.12.16]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.16
[0.12.15]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.15
[0.12.14]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.14
[0.12.13]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.13
[0.12.12]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.12
[0.12.11]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.11
[0.12.10]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.10
[0.12.9]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.9
[0.12.8]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.8
[0.12.7]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.7
[0.12.6]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.6
[0.12.5]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.5
[0.12.4]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.4
[0.12.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.3
[0.12.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.2
[0.12.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.1
[0.12.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.12.0
[0.11.12]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.12
[0.11.11]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.11
[0.11.10]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.10
[0.11.9]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.9
[0.11.8]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.8
[0.11.7]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.7
[0.11.6]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.6
[0.11.5]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.5
[0.11.4]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.4
[0.11.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.3
[0.11.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.2
[0.11.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.1
[0.11.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.11.0
[0.10.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.10.3
[0.10.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.10.2
[0.10.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.10.1
[0.10.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.10.0
[0.9.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.9.1
[0.9.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.9.0
[0.8.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.8.0
[0.7.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.7.3
[0.7.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.7.2
[0.7.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.7.1
[0.7.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.7.0
[0.6.4]: https://github.com/csakaszamok/p9m/releases/tag/v0.6.4
[0.6.3]: https://github.com/csakaszamok/p9m/releases/tag/v0.6.3
[0.6.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.6.2
[0.6.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.6.1
[0.6.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.6.0
[0.5.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.5.2
[0.5.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.5.1
[0.5.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.5.0
[0.4.2]: https://github.com/csakaszamok/p9m/releases/tag/v0.4.2
[0.4.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.4.1
[0.4.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.4.0
[0.3.1]: https://github.com/csakaszamok/p9m/releases/tag/v0.3.1
[0.3.0]: https://github.com/csakaszamok/p9m/releases/tag/v0.3.0
