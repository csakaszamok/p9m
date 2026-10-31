# Purgatorium for agents: deploy and update apps in a sandbox

This guide is for a coding agent (for example Claude Code on the user's machine) that deploys or updates apps in the user's Purgatorium sandbox. Every call below was run against a live Purgatorium.

Every sandbox has its own Docker daemon. The agent works with:

- the **Purgatorium API**, with the user's personal access token, to find the sandbox, wake it and get its Docker client certificates;
- the sandbox's **Docker daemon**, with the plain `docker` command line, to deploy, build and update.

An agent with MCP can make the Purgatorium API calls as tools instead: see [MCP](mcp.md). A sandbox made from the `portainer` template also has a Portainer API: see [With Portainer](#with-portainer) at the end.

## What the user gives the agent

| Value | Example | Where it comes from |
|---|---|---|
| Purgatorium URL | `https://p9m.example.com` | The address of the Purgatorium UI |
| Personal access token | `p9m_…` | UI → **My area** → **Access tokens** → **+ New token** |
| Sandbox name | `p9m-shop` | The name in the UI list with the `p9m-` prefix |

The user may instead give these in a `p9m.env` file in the project (UI → the new token → **Download p9m.env**; it may also be renamed `.env` or copied into one): `P9M_URL`, `P9M_TOKEN`, `P9M_SANDBOX` (only for a token limited to one sandbox; otherwise ask which sandbox, or list them with `GET /sandboxes`) and `P9M_AGENT_GUIDE` (this guide). Read them from there; do not print the token or commit the file.

The token may be limited to one sandbox. Then `GET /sandboxes` lists only that one, `GET /me` returns it as `sandbox`, and creating or deleting sandboxes answers 403. Everything in this guide works with such a token.

Every Purgatorium API call sends `Authorization: Bearer p9m_…`. The token acts as the user: it sees and changes only the user's own sandboxes.

## 1. Find the sandbox and wake it

```http
GET /sandboxes/p9m-shop
```

The answer includes:

- `status`: `running`, `exited` (asleep) or `deep_sleep`;
- `docker_access`: `host`, the address of the sandbox's Docker daemon (for example `shop-docker.example.com`), and `state`: `ready`, or `needs-certs` when its certificates do not cover that address (the user enables it once: **Access → Enable**, which restarts the sandbox); and, while the sandbox is not running, `hint`: a Docker connection does not wake it, so start it first (`docker` would only get EOF);
- with `?include_keys=true` only: `ca_cert`, `client_cert`, `client_key`, the Docker client certificates and private key (PEM). Write them to files with a program (below), never by copying them through a model: copied by hand a key gets garbled (and still looks like a key), and in an answer it goes into the model's context and transcript. A single-use link (below) puts them on disk without them passing through an answer;
- `tunnel_urls`: the app addresses.

If `status` is not `running`, wake the sandbox and poll until it is:

```http
POST /sandboxes/p9m-shop/start
GET  /sandboxes/p9m-shop        → repeat until "status": "running"
```

Waking from `exited` takes a few seconds; from `deep_sleep` about 30 seconds. Connecting to the Docker daemon does **not** wake it: while the sandbox sleeps, `docker` fails to connect (connection reset or EOF), so wake it first.

A request to an app address while the sandbox is not ready returns an HTML **waiting page** ("Sandbox is waking up") with status 200, instead of the real answer: treat it as "not ready yet" and retry after a few seconds.

## 2. Connect the docker command line

Ask for a single-use link to the project's `.p9m` folder (MCP: `project_dir_link`). Purgatorium checks the keys first; the link works once, for 5 minutes:

```http
POST /sandboxes/p9m-shop/project-link
→ { "url": "https://p9m.example.com/project-dir/…", "expires_in": 300,
    "command": "curl -sf \"https://p9m.example.com/project-dir/…\" | tar -x -C <project folder>",
    "context_commands": ["docker context rm -f p9m-shop", "docker context create p9m-shop --docker \"host=tcp://shop-docker.example.com:443,ca=<project folder>/.p9m/docker/ca.pem,…\""] }
```

Run `command`, then `context_commands`, with the project's root folder for `<project folder>`. The download writes `.p9m/.gitignore` (`*`: git leaves the folder out), `.p9m/p9m.env` (`P9M_URL`, `P9M_SANDBOX`, `P9M_DOCKER_HOST`) and `.p9m/docker/{ca,cert,key}.pem`. On Windows: `curl.exe --ssl-no-revoke`; `tar` comes with Windows 10 and later. A used or expired link answers **410**: ask for a new one.

```sh
docker --context p9m-shop compose ls
```

A context keeps its own copies of the files: after new keys run both again, with a new link. Check it with a compose command, as above: `ps` can work with a key that compose cannot read (`tls: failed to parse private key`). On a TLS error get a new link; do not repair a key file. Add `.p9m` to `.dockerignore`, so that a build never copies the keys into an image.

Only TLS with these certificates gets in: Purgatorium passes the connection through without opening it. Keep the key as secret as the token.

If the user gave you an export instead, it is a `.p9m` folder for the project's root folder (from the zip `p9m-<sandbox>.zip`; an older export is a `p9m-<sandbox>/` folder): `p9m.env`, `docker/` with the certificates, a README, and a `.gitignore` of `*` that keeps the folder out of git. `p9m.env` has `P9M_DOCKER_HOST`. Unpack a zip into the project's root and delete the zip (it holds a token); add `.p9m` to `.dockerignore`, so that a build never copies the keys into an image:

```sh
docker context create p9m-shop --docker "host=$P9M_DOCKER_HOST,ca=$PWD/.p9m/docker/ca.pem,cert=$PWD/.p9m/docker/cert.pem,key=$PWD/.p9m/docker/key.pem"
```

## 3. Deploy an app

A compose project in the sandbox, built and run there:

```sh
docker --context p9m-shop compose -p shop up -d --build
```

```yaml
services:
  web:
    build: .
    ports: ["8080:8080"]
    restart: unless-stopped
    labels:
      p9m.subdomain: shop
```

- **Publish ports on all interfaces** (`8080:8080`): that is what gives the app its public address. A port published on `127.0.0.1` stays private to the sandbox: no address at all. The app itself must listen on `0.0.0.0` inside its container (not `127.0.0.1`), or its address answers with an error; `GET /sandboxes/:name` → `apps[].answers` says whether it answers. An app labelled `p9m.access: domain` or `owner` ([App access](app-access.md)) answers your own `curl` with a redirect to Purgatorium's sign-in: check `apps[].answers` instead. Without a label an app opens only for its owner (the server's default, unless it sets another): set the label the user asks for (*for my colleagues* → `domain`, *for anyone* → `public`, e.g. a webhook receiver) before the first deploy.
- **Set a restart policy** (`restart: unless-stopped`): when the sandbox wakes from sleep, only containers with one start again.
- Pass secrets when the container runs (`environment:`, `env_file:` read on your machine by `docker compose`), **never in the image**.

### The app's public address

Every published TCP port gets an HTTP address. With the sandbox `p9m-shop` on `example.com`:

- with a `p9m.subdomain: shop` label: `https://shop-shop.example.com`, that is `<sandbox>-<subdomain>.<domain>`;
- without the label: `https://shop-<project>-<container>-port<host port>.example.com`. The container name is `<project>-<service>-1` unless `container_name` is set.

The app is reachable a few seconds after the container starts. `GET /sandboxes/p9m-shop` lists the addresses in `tunnel_urls`.

A database or other TCP service published the same way also gets a TLS address on port 443: see [Isolation and TCP addresses](networking.md#tls-tcp-addresses).

## 4. Update the app

Change the code or the image tag and run the same `docker --context p9m-shop compose -p shop up -d --build` again: compose recreates the changed containers and keeps the volumes. Use a fixed tag for every release (`:1.4.2`, `:1.4.3`, …) so you can roll back by deploying the previous one.

### Push to the registry

Every sandbox can push to Purgatorium's registry, so an image can be pulled elsewhere too:

```sh
docker login registry.example.com -u shop             # password: the token
docker --context p9m-shop tag shop-web registry.example.com/shop/web:3
docker --context p9m-shop push registry.example.com/shop/web:3
```

- Every push is scanned for secrets, and an image with a `.env` file or a key in it stays private (`GET /sandboxes/<name>/registry` shows what was found).
- Anyone can pull the image from any machine (`docker pull registry.<domain>/shop/web:3`) once **every** version of it passed the scan: one flagged version keeps the whole image private until it is deleted.

## 5. Other ways in

- **SSH:** `ssh root@<sandbox>-shell-tcp.<domain>` through port 443 ([SSH, terminal and logs](shell-and-logs.md)); inside, `docker` talks to the sandbox's Docker.
- **Logs** of every app in the sandbox: `GET /sandboxes/<name>/logs/stream` (Server-Sent Events).
- **Move the work itself into the sandbox:** with the Claude Code plugin, `/p9m:teleport` puts the project, its confirmed secrets and the conversation into a `claude` container next to the apps, to continue there ([Claude Code plugin](claude-plugin.md#continue-in-the-sandbox-p9mteleport)).

## With Portainer

A sandbox made from the `portainer` template (or one with Portainer in its own compose) also has Portainer, which proxies the sandbox's Docker daemon over HTTPS: an agent can deploy through its API without the `docker` command line. `GET /sandboxes/<name>` then has:

- `extras.portainer_url`, for example `https://shop-portainer.example.com` (if its host is not in `tunnel_urls`, Portainer is published on `127.0.0.1` and private to the sandbox: ask the user to publish it on all interfaces, `9000:9000`, in **Starter stack…**);
- `extras.portainer_password` (user `admin`).

`GET <portainer_url>/api/status` returning JSON means Portainer is ready (an HTML answer is the waiting page). Portainer traffic wakes an asleep sandbox and keeps it awake.

### Sign in to Portainer

If `p9m.env` has `P9M_PORTAINER_URL` and `P9M_PORTAINER_TOKEN`, skip the sign-in: use `P9M_PORTAINER_URL` as `<portainer_url>` and send `X-API-Key: <P9M_PORTAINER_TOKEN>` instead of `Authorization: Bearer <jwt>` on every Portainer call below. (A line `# Portainer: not included (…)` says why there is none; then sign in as below, or use the Docker command line, [2](#2-connect-the-docker-command-line).)

Otherwise sign in with `extras.portainer_password`:

```http
POST <portainer_url>/api/auth
Content-Type: application/json

{"username": "admin", "password": "<extras.portainer_password>"}
```

The answer is `{"jwt": "…"}`. Send `Authorization: Bearer <jwt>` on every Portainer call below.

Then find the environment (endpoint) ID. It is the sandbox's Docker daemon, usually `1`:

```http
GET <portainer_url>/api/endpoints      → [{"Id": 1, "Name": "primary", …}]
```

If the list is empty (nobody clicked **Get started** in the Portainer UI yet), create the environment once:

```http
POST <portainer_url>/api/endpoints
Content-Type: multipart/form-data

Name=local
EndpointCreationType=1
```

### Deploy an app as a stack

A Portainer stack is a compose project that Portainer can update later. Deploy it from compose text:

```http
POST <portainer_url>/api/stacks/create/standalone/string?endpointId=1
Content-Type: application/json

{
  "name": "shop",
  "stackFileContent": "services:\n  web:\n    image: registry.example.com/shop:1.4.2\n    ports: [\"8080:8080\"]\n    labels:\n      p9m.subdomain: shop\n",
  "env": [{"name": "LOG_LEVEL", "value": "info"}]
}
```

The answer includes the stack `Id`; keep it for updates. `GET <portainer_url>/api/stacks` lists the stacks with their IDs.

The same rules hold as in [3. Deploy an app](#3-deploy-an-app): publish ports on all interfaces, set a restart policy.

### Update a stack

Change the image tag in the compose text and redeploy. `pullImage: true` pulls the image again even if the tag did not change (for `:latest`):

```http
PUT <portainer_url>/api/stacks/<stack id>?endpointId=1
Content-Type: application/json

{"stackFileContent": "<the full compose text>", "env": [], "prune": true, "pullImage": true}
```

`prune: true` removes services that are no longer in the compose text. Portainer recreates the changed containers; the volumes are kept.

To build in the sandbox, send the build context as a tar archive to the Docker build endpoint through Portainer's Docker proxy:

```http
POST <portainer_url>/api/endpoints/1/docker/build?t=shop:1.4.3
Content-Type: application/x-tar

<tar of the directory with the Dockerfile>
```

The answer streams the build log as JSON lines; the last line is `{"stream":"Successfully tagged shop:1.4.3\n"}` on success, or an `{"error": …}` line on failure. Then redeploy the stack with `image: shop:1.4.3` and `pullImage: false` (the image only exists locally).

### Everything else Docker can do

`<portainer_url>/api/endpoints/1/docker/<Docker Engine API path>` is the sandbox's Docker Engine API. Examples:

| Call | Docker Engine API |
|---|---|
| `GET …/docker/containers/json` | list running containers |
| `GET …/docker/containers/<name>/logs?stdout=1&stderr=1&tail=200` | container logs |
| `POST …/docker/containers/<name>/restart` | restart a container |
| `POST …/docker/images/create?fromImage=alpine&tag=3.20` | pull an image |
| `DELETE …/docker/images/<image>` | remove an image |

The stack Purgatorium deployed when it created the sandbox (Portainer + `http-echo`) was deployed with `docker compose` outside Portainer: Portainer shows it but cannot edit it as a stack.

## Things to keep in mind

- **Sleep:** the sandbox sleeps after its idle timeout without HTTP traffic, 30 minutes by default. The user can change this or turn it off in the UI (**Sleep settings…**) or with `PATCH /sandboxes/<name>` `{"idle_timeout": "2h"}`, where `0` or `off` means never. Docker traffic keeps a running sandbox awake (a build, `docker logs -f`, a pull), but a connection that is only open does not; plain HTTP traffic to its apps (or to Portainer) counts too.
- **Archive** (`DELETE /sandboxes/<name>`, **Archive…** in the UI) archives the sandbox: its configuration and data are kept in the archive, and it is removed from the list.
- **The Purgatorium API reference** is at `<Purgatorium URL>/swagger`.
