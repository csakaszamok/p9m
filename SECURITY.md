# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: **Security** tab → **Report a vulnerability** ([direct link](https://github.com/csakaszamok/p9m/security/advisories/new)).

Include what you found, how to reproduce it, and which version or commit you ran. You will get an answer within a few days; once a fix is out, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Fixes go to the latest release series (e.g. 0.13.x) and to `main`. Purgatorium is before 1.0: upgrade to the latest release to get a fix.

## Security model

In short (the details: [Security](https://csakaszamok.github.io/p9m/latest/security/) in the documentation):

- **Purgatorium controls the host.** Its container mounts the host's Docker socket, so whoever takes over Purgatorium has root on the host. Run it on a server dedicated to it, best behind a VPN or with the sign-in limited to your domain, and keep it up to date.
- **Sandboxes are containers, not VMs, unless you opt in.** By default only the `sysbox` runtime is allowed (unprivileged, its own user namespace), but a sandbox shares the host's kernel. It keeps a team's mistakes apart; it is not a boundary against hostile code. For code from strangers use the `kata` runtime (a VM per sandbox, on a host with KVM; its residual risk, virtiofsd running as host root, is described in the [Security](https://csakaszamok.github.io/p9m/latest/security/) page) or a microVM-based sandbox.
- **Closed by default.** `docker compose` does not start without an `ADMIN_TOKEN` (`setup.sh` generates one); the plain-HTTP API port `8081` listens on the host only; with OIDC on, Purgatorium does not start until `OIDC_ALLOWED_DOMAINS` or `OIDC_ALLOWED_EMAILS` says who may sign in (or `OIDC_ALLOW_ANYONE=true`); with an `https://` `PUBLIC_URL` it does not start with example secrets. `check-host.sh`, run in the install directory, lists what is still open.
- **What it is built on.** The image is built on [`rododentron`](https://github.com/csakaszamok/rododentron) (Node.js base with the MCP server core), sandboxes run [`foxglove`](https://github.com/csakaszamok/foxglove); both are open source, and every release image is scanned with Trivy. `setup.sh` can be read before running it, or skipped: see [Install](https://csakaszamok.github.io/p9m/latest/install/).

## Scope

The privileged `dind` runtime (development only, not allowed by default) lets code with root inside a sandbox reach the host, and the host's Docker socket is Purgatorium's by design: those are documented limitations, not vulnerabilities. Reports about escaping a `sysbox` or `kata` sandbox, bypassing sign-in or tokens, reaching another user's sandbox, or anything else the documentation says Purgatorium prevents are in scope.
