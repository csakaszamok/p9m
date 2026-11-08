# Let your agent deploy

Give a coding agent (Claude Code, Codex, Cursor…) a personal access token and a sandbox, and it can ship your app there on its own: wake the sandbox, deploy a compose project to the sandbox's own Docker daemon, build images inside it, read the logs and roll out new versions. The app gets its public URL from the tunnel.

1. In the UI: create a sandbox (say `shop`), then in its panel's **Access** tab **Token for this sandbox…** — a token that works only for that sandbox.
1. **Download p9m.env** in the token's dialog and save it in your project folder (keep it out of git), then tell the agent: *Deploy this app to my Purgatorium sandbox — settings in p9m.env.* The file holds `P9M_URL`, `P9M_TOKEN`, `P9M_SANDBOX` and `P9M_AGENT_GUIDE`. Or tell the agent everything yourself, for example:

> Deploy this repo to my Purgatorium sandbox `p9m-shop` at `https://p9m.example.com` with the token `p9m_…`. Follow https://csakaszamok.github.io/p9m/latest/agent-guide/index.md.

[docs/agent-guide.md](https://csakaszamok.github.io/p9m/0.19/agent-guide/index.md) is written for the agent: every call it needs, tried against a live Purgatorium. A token limited to one sandbox keeps the agent away from your other sandboxes; a token for all your sandboxes (Access tokens → + New token) acts as you.

An agent with MCP can also use Purgatorium as an MCP server with the same token: see [MCP](https://csakaszamok.github.io/p9m/0.19/mcp/index.md). In Claude Code, the [p9m plugin](https://csakaszamok.github.io/p9m/0.19/claude-plugin/index.md) needs no token typed in: install it once (`/plugin marketplace add p9m-team/p9m`, `/plugin install p9m@p9m`), then run `/p9m:init <address>` in the project (a new sandbox; `/p9m:init <address> <sandbox>` for one you have), approve in the browser and paste back the code it shows.

## Docker, registry, export

A coding agent (Claude Code, Codex…) can work on a sandbox with plain `docker` commands:

- **Docker from outside:** `<raw>-docker.<domain>:443` reaches the sandbox's own Docker daemon. Purgatorium does not open that TLS: it only reads the name and passes the connection through, so the Docker command line and the sandbox talk to each other with the sandbox's own certificates (only whoever holds its client key gets in). It does not wake a sleeping sandbox (wake it first: **Wake**, `POST /sandboxes/:name/start`, or the MCP tool `wake_sandbox`); traffic on the connection keeps a running one awake, a connection that is only open (e.g. Docker Desktop keeping a context connected) does not.
- **Let your agent deploy…**, on a sandbox's **App ports** tab (and in the Advanced view also at the top of its **Access** tab), is the same window in both views. For the [Claude Code plugin](https://csakaszamok.github.io/p9m/0.19/claude-plugin/index.md): the two lines that install it (once), and the `/p9m:init <address> <sandbox>` line to paste into Claude Code in the project; you approve in the browser, and the project gets its `.p9m` folder with a token for the sandbox. For other agents: **Download** gives `p9m-<raw>.zip`, with a `.p9m` folder to unpack in the project's root folder (its own `.gitignore` of `*` keeps it out of git; add `.p9m` to `.dockerignore` too, so that a build never copies it into an image), and what to tell the agent (*set up the p9m zip from my Downloads in this project and deploy*). Before a sandbox has Docker access it offers to enable it, or to export without the Docker keys. In the Advanced view the window has **Options**: the token's name and expiry (for the zip), a zip without the Docker keys, and **Copy as .env**, which puts `p9m.env` (a new token for the sandbox) on the clipboard. When the sandbox's Portainer is public, both also carry `P9M_PORTAINER_URL` and a Portainer API token (`P9M_PORTAINER_TOKEN`, sent as `X-API-Key`), made for the export, so the agent never gets the Portainer admin password; making it wakes the sandbox. That token does not expire and revoking the Purgatorium token does not revoke it: delete it in the sandbox's Portainer (My account → Access tokens). The `.p9m` folder holds `p9m.env` (with a new token limited to the sandbox, `P9M_DOCKER_HOST`, `P9M_REGISTRY`), the Docker client keys and a README with the `docker context create` command for Windows and macOS/Linux. It is a secret; **Rotate Docker keys…** makes the keys of earlier exports useless.
- **Registry:** `docker login registry.<domain>` with a Purgatorium token as the password (a token limited to a sandbox pushes to `<raw>/…`, a personal one to its owner's sandboxes); the password returned at create still works.
- **Anonymous pull after a secret scan:** every push is scanned (files such as `.env`, private keys, and well-known key formats, in every layer and in the image config, where Dockerfile `ENV` lines end up). Anonymous pull is decided per repository: one whose versions are all clean — and that has nothing in the registry Purgatorium has not scanned — can be pulled by anyone without logging in; one flagged, unscanned or failed version keeps the whole repository private until it is deleted. The registry tells Purgatorium about pushes with a secret Purgatorium generates (`data/registry-notify.secret`). Garbage collection runs weekly; a push at that very moment may fail and needs a retry. The **Registry** tab shows the images, the scan results (masked) and a Delete button. `REGISTRY_PUBLIC_PULL=false` keeps everything private.

## An agent inside a sandbox

A coding agent can also run inside one sandbox (say, in a VS Code or code-server container there) and deploy to another: give it that other sandbox's access as usual (the [Claude Code plugin](https://csakaszamok.github.io/p9m/0.19/claude-plugin/index.md) with `/p9m:init` for that sandbox, or its zip). It needs two names to reach from inside the sandbox: Purgatorium's (`p9m.<domain>`, the API and MCP) and the other sandbox's Docker address (`<sandbox>-docker.<domain>`), plus its apps' addresses if it opens them.

**With a real domain** (a wildcard DNS record for `*.<domain>`), these names point at the server from inside a sandbox too: nothing to set. The server must reach its own public address from inside, which it usually does ("hairpin NAT"; most clouds and Docker do it).

**On a local development stack on `lvh.me`** they do not: `lvh.me` names point at `127.0.0.1`, which inside a sandbox's container is that container itself, not Purgatorium. With Docker Desktop (Windows, macOS), point them at the host, `192.168.65.254` (what `host.docker.internal` resolves to; a fixed address), with `extra_hosts` on the agent's service in that sandbox's compose file:

```
    extra_hosts:
      - "p9m.lvh.me:192.168.65.254"
      - "shop-docker.lvh.me:192.168.65.254"   # the other sandbox's Docker address
      - "shop-web.lvh.me:192.168.65.254"      # its app, if the agent opens it
```

It has to be an address: `extra_hosts` takes no names, and `host-gateway` inside a sandbox is the sandbox's own container, not the host. The names stay as they are, because the TLS certificates and Traefik's routing go by them. On a Linux host without Docker Desktop there is no such address: use a real domain there.
