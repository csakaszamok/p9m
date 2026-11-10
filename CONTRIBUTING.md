# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are all welcome. For a larger feature, please open an issue first so we can agree on the approach before you write the code.

## Development setup

You need Docker with the compose plugin, and Node.js 22 for the unit tests.

```bash
git clone https://github.com/csakaszamok/p9m.git && cd p9m
./setup.sh
echo 'COMPOSE_PATH_SEPARATOR=:' >> .env
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml' >> .env
docker compose up -d --build
npm ci
```

`docker-compose.dev.yml` builds the image from the checkout and mounts `server.ts`, `routes/`, `services/`, `ui/`, `templates/` and `runtimes/` into the container, so a code, template or runtime change applies on the next request, without a rebuild. It also gives `p9m-init` the checkout's Sablier themes, error pages, registry config and `traefik/errors.yml`: a change to the error pages or `traefik/errors.yml` applies on the next `docker compose up -d`, one to the Sablier themes or the registry config after that and `docker compose restart sablier registry` (they read them at start). Changes to the `Dockerfile` or the dependencies need `docker compose up -d --build`.

## Code layout

- `server.ts`: the HTTP server; each file under `routes/` is one endpoint (`routes/sandboxes/[name]/GET.ts` → `GET /sandboxes/:name`).
- `services/`: everything else: creating and archiving sandboxes, sleep and deep sleep, sign-in, tokens, the UI pages.
- `templates/`: what goes into a sandbox (YAML).
- `docs/architecture.html`: diagrams of how a request reaches a sandbox and how a sandbox sleeps and wakes.

## Tests

- **Unit tests:** `npm test` (vitest). **Types:** `npm run typecheck` (tsc, the app code and the tests; tsx runs the code without checking types). Both run in CI on every push and pull request.
- **End-to-end tests:** the scripts in `tests/*.sh` run against a live stack. Run the ones your change touches: `bash tests/sablier-wake.sh`, `bash tests/app-streaming.sh`, `bash tests/archive.sh`, `bash tests/isolation.sh`, `bash tests/deep-sleep.sh` (needs `DEEP_SLEEP_CHECK_INTERVAL=15s`), `bash tests/self-service.sh` (needs the mock OIDC env), `bash tests/https.sh` (self-signed `*.lvh.me`, restores HTTP afterwards), `bash tests/quota.sh` (mock OIDC env + `SANDBOX_QUOTA=1`), `bash tests/sleep-settings.sh`.
- **Install scripts:** `bash tests/install-assets.sh` and `bash tests/setup.sh` run anywhere (also in CI). `bash tests/install.sh` installs from the release files; it refuses to run next to a Purgatorium, so on a development machine run it in `docker:dind` (the command is at the top of the file); CI runs it on every push.
- **Documentation:** the site in `docs/` (MkDocs Material). Preview it with `pip install -r docs/requirements.txt` and `mkdocs serve`; `mkdocs build --strict` must pass.

A pull request should add or update tests for what it changes.

## Branches and releases

Each release series has its own branch, `release/<major>.<minor>` (`release/0.3`, `release/0.4`, …); there is no separate development branch.

- **New features** go to the newest series' branch, the `release/*` with the highest number (now `release/0.20`), through a pull request from a feature branch. When you open the pull request on GitHub, change its base from `main` to that branch.
- **Fixes for a released series** go to its branch (e.g. `release/0.3`), and that branch is then merged into each newer one, so no fix is lost going forward.
- **A release** is a version bump (`package.json`, the two image defaults in `docker-compose.yml` and `server.json`, checked by `scripts/check-release-version.sh`) and a `[x.y.z]` section in `CHANGELOG.md` on the series' branch, then a `vx.y.z` tag on it. The tag builds and publishes the image as `x.y.z` and `x.y`; `latest` only for the highest version, so a fix for an older series does not move it back. The same workflow publishes a release of the newest series to the MCP Registry (`server.json`, signed in with GitHub's OIDC token, no one logs in); by hand, from `main`: `mcp-publisher login github` as csakaszamok, then `mcp-publisher publish`.
- **`main`** is the newest release: it is updated when a release of the newest series is made. Pull requests do not go to `main`.
- **A new series** starts as a `release/x.y` branch from the newest one; the branch named above, in `.github/pull_request_template.md` and as `target-branch` in `.github/dependabot.yml` then moves to it.

A server can follow one series with `P9M_VERSION=0.3` in `.env` (the newest `0.3.x` image) and a checkout of `release/0.3` (its templates and runtimes).

## Pull requests

- One topic per pull request, with a short description of what changes for the user and how you tested it.
- Keep documentation in step: the site in `docs/` describes the behaviour users see (the README only introduces it).
- Commit messages: a short summary line that says what changes (for example "Deep sleep: take down asleep sandboxes whose network is gone"), then the why in the body if it is not obvious.

## Security issues

Please do not report vulnerabilities in public issues; see [SECURITY.md](SECURITY.md).

## License

Purgatorium is licensed under the [AGPL-3.0](LICENSE), with the additional terms in [NOTICE](NOTICE).

By contributing you agree that your contribution is licensed under the AGPL-3.0, and you grant the Purgatorium (p9m) authors a perpetual, worldwide, royalty-free right to use, change and release it under other licenses as well (for example a commercial license, or a later license for the whole project). You confirm that you wrote it, or have the right to contribute it on these terms.
