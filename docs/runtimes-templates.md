# Runtimes and templates

A sandbox is a **runtime** (how it runs) plus a **template** (what runs inside), picked separately on create (`runtime`, `template`; the **New sandbox** form has a select for each):

| Runtime | Isolation | Use |
|---------|-----------|-----|
| `sysbox` | `runtime: sysbox-runc`, no privileged mode | every server (the only one allowed by default); requires [sysbox](https://github.com/nestybox/sysbox) on a Linux host |
| `dind` | `privileged: true` | **development only** (a laptop, Docker Desktop / WSL, where sysbox cannot run): root in a `dind` sandbox can reach the host. Never on a server; allowed only with `ALLOWED_RUNTIMES=sysbox,dind` (or `all`) |

| Template | What runs inside |
|----------|------------------|
| `starter` (default) | a hello app; deploy yours with `docker`, SSH or an agent |
| `portainer` | the same with Portainer, a web UI for the sandbox's Docker (its address and password in the API and the panel; it runs with `-H unix:///var/run/docker.sock`, so its environment exists from the start) |
| `claude-code` | Claude Code in Docker Sandboxes' (`sbx`) image, `docker/sandbox-templates:claude-code`, next to the sandbox's own Docker, and a hello app: open the sandbox's terminal in the `claude` container and run `claude`; it builds and runs with `docker compose`, and what it publishes gets an address. Its home directory is a volume (the sign-in and `~/workspace` survive sleep). The image is large: about 5 GB of disk per sandbox |
| `claude-code-minimal` | the same, slim: `ghcr.io/csakaszamok/p9m-claude-code-minimal` (built from `images/claude-code-minimal` with every release) has Claude Code, the Docker CLI with compose and buildx, git and little else, about 1.5 GB of disk per sandbox. The agent builds and runs the apps in containers, so it needs no toolchains of its own |
| `claude-code-ecc` | the slim one with [ECC](https://github.com/affaan-m/ECC) installed into Claude Code as the `ecc@ecc` plugin (pinned to a release): agents, skills and hooks for a plan → test → review workflow, Node.js and Python for its hooks. For trying ECC out: it adds about 31k tokens of context to every session, and its gate asks Claude to state the request before the first shell command of a session. `ghcr.io/csakaszamok/p9m-claude-code-ecc`, built from `images/claude-code-ecc` with every release; about 2 GB of disk per sandbox |
| `tcp-demo` | a demo of [TLS TCP addresses](networking.md#tls-tcp-addresses): Postgres, Redis, SSH and pgweb |
| `empty` | nothing: no starter stack; deploy your apps afterwards |

Both runtimes have the same wiring (FRP tunnel, Traefik route, Sablier sleep/wake, `docker_data` volume, archive on delete). The sysbox image runs plain `dockerd`, so its TLS listener is configured through the runtime's `daemon_json` field, which Purgatorium merges into the generated `daemon.json`. Only `sysbox` belongs on a server, and it is the only runtime allowed unless `ALLOWED_RUNTIMES` says otherwise (see [Security](security.md)).

**Runtimes** are `runtimes/<name>.yaml`: a `description`, the sandbox's own `docker_compose` (the DinD container, frps, socat, and their Traefik and Sablier labels) and an optional `daemon_json`. **Templates** are directories, `templates/<name>/`:

- `compose.yaml` (required): the stack deployed into the sandbox's own Docker on creation, a plain compose file.
- `template.yaml` (optional, every field optional): `description` (default: the directory name), `before_script` (JavaScript run on create; what it returns becomes `${variables}` for both compose files and the sandbox's `extras`, e.g. a generated password), `idle_timeout` (Go duration, default `30m`: how long a sandbox may go without HTTP traffic before it sleeps; a create request can override it), `deep_sleep_after` (default `7d`), `inner_project_name` (default `inner`).

A new template is a new directory; it shows up in `GET /templates` and the form without a restart. In both files Purgatorium fills in `${name}`, `${raw_name}`, `${host_domain}` (the domain of the sandbox's addresses: `APPS_DOMAIN`, or `HOST_DOMAIN` without it), `${template_name}`, `${runtime_name}` and whatever `before_script` returned; any other `${…}` is left for docker compose (write `$$` for a literal `$`). Publish a port on all interfaces (`"5432:5432"`) to give it a link and a [TLS TCP address](networking.md#tls-tcp-addresses); a port on `127.0.0.1` stays private to the sandbox; a `p9m.connect.user` label puts its login into the **Connect…** commands. Pass passwords through variables whose name contains `PASSWORD` (or `TOKEN`, `SECRET`, `KEY`): **Starter stack…** masks those.

**A template is only the start.** The **New sandbox** dialog shows the chosen template's starter stack, read-only: a sandbox starts with it as it is, and it cannot be changed, neither at the create (the API refuses a `compose` text) nor later. Your own apps, Claude Code added to a sandbox made from `starter`, anything else, go in afterwards like every app: through the sandbox's Docker, with `docker`, SSH or an agent ([Purgatorium for agents](agent-guide.md)). Sandboxes created from an edited compose text before 0.17 keep it and still show "(edited)". `docker compose` runs in the sandbox itself, on the sandbox's own Docker, with the file at `/inner/docker-compose.yml`: whatever the file makes it read, build or run (`build`, `env_file`, `include`, `secrets` from a `file`…) is the sandbox's, never the Purgatorium server's. `build` contexts and other relative paths are under `/inner`. The CLI gets an empty environment, so an unknown `${VAR}` is empty.

