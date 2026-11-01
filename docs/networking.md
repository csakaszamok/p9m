# Isolation and TCP addresses

## Isolation between sandboxes
An app in one sandbox must not reach another sandbox's apps. Today:

- inner containers' private addresses are only reachable inside their own sandbox;
- Sablier's API is on its own network (`sablier-net`) shared only with Traefik;
- a sandbox container is on its own network only, with its frps and socat, so no other sandbox reaches it or its ports directly. Everything into it goes through its frp tunnel: its web addresses, its TLS TCP addresses, SSH and Docker access (frpc connects out of the sandbox to its frps, which is on `traefik-net` under the sandbox's name);
- a port an inner container *publishes* on all interfaces (`9000:9000`) gets a link (its tunnel) and a TLS TCP address; a port published on `127.0.0.1` (`127.0.0.1:9000:9000`) is private to the sandbox: no link, no TCP address. A link whose app does not answer is marked ⚠ in the panel — usually the app listens on 127.0.0.1 inside its container; make it listen on 0.0.0.0.

The Purgatorium API itself requires authentication (see [Web UI and sign-in](web-ui.md)). What a sandbox needs of Purgatorium's services it reaches through its own socat, under their usual names: the Docker Hub cache (`registry-cache:5000`, dockerd's mirror), the ghcr.io cache (`registry-cache:5001`: Purgatorium's own images, such as the claude container `/p9m:teleport` starts, pulled by that name), the registry and the UI (through Traefik). frps's own ports are high (65000 for frpc, 65080 for the web addresses, 65075 for its API, which has a per-sandbox password kept in `frps.toml`), because frps also listens on every port the sandbox publishes, and on 22 and 2376.

Who may open an app's **web address** can be limited per app with `p9m.access` ([App access](app-access.md)); that applies to HTTP through Purgatorium only, not to the TCP addresses below.

## App web addresses
Each TCP port an inner container publishes on all interfaces gets a web address, `<sandbox>-<project>-<container>-port<host port>.<domain>` (`shop-inner-web-port8080.<domain>`). A label on the container gives it a short one instead:

| Label | What it does |
|---|---|
| `p9m.subdomain: web` | The app's address becomes `<sandbox>-web.<domain>`. No other label does (`p7y.subdomain` and `frpc.subdomain` are ignored). `shell` gets no TCP address: that name is the sandbox's own SSH ([Shell and logs](shell-and-logs.md)). |
| `p9m.access` | Who may open the address ([App access](app-access.md)). |
| `p9m.connect.user` | The login the **Connect…** recipes use (below). |
| `p9m.publish`, `p9m.title`, `p9m.description`, `p9m.image` | Lists the app on the [Hub](hub.md). |

```yaml
services:
  web:
    build: .
    ports: ["8080:8080"]
    labels:
      p9m.subdomain: web
```

A container with `p9m.subdomain` that publishes several ports has one web address for all of them; each port's TCP address (below) gets `-port<N>` too.

## A separate domain for the apps
By default the apps are under `HOST_DOMAIN`, beside the UI. A server whose sandboxes run apps of people you do not fully trust should put them under a domain of their own, as GitHub Pages (`github.io`) and Vercel (`vercel.app`) do: set `APPS_DOMAIN=example.app` beside `HOST_DOMAIN=example.dev`.

- **What moves:** every sandbox address, `<sandbox>-<…>.example.app`: the apps, the TCP and SSH addresses, Docker access. The UI, the registry and the Hub stay under `example.dev`.
- **Why:** a phishing app reported to a blocklist (Google Safe Browsing, a company proxy) takes its domain with it; under its own domain, the UI and its sign-in stay reachable. To the browser, an app is then another site: it cannot set cookies for the UI's domain, nor send it same-site requests.
- **What it needs:** a wildcard DNS record `*.example.app` pointing to the server, and the certificate covering `*.example.app` as well as `*.example.dev` ([HTTPS](https.md): one certificate with both names).
- **The sandboxes made before:** at the next start (`docker compose up -d`) Purgatorium moves them to the new domain, restarting those that run. Their old web addresses redirect to the new ones (308). A TCP, SSH or Docker client has to use the new address; Docker access needs its certificates made again (**Docker access…** says so).
- **The Public Suffix List:** with the apps domain on the [Public Suffix List](https://publicsuffix.org/) (its private section; you request it), browsers and blocklists treat each app's address as a site of its own, so one bad app does not take the others with it. Purgatorium needs nothing for it: its app cookies are each app's own.

## TLS TCP addresses
A port an inner container publishes on all interfaces (`"5432:5432"`) also gets a TCP address, its HTTP name plus `-tcp`, on port 443, TLS only: `shop-inner-db-port5432-tcp.<domain>:443`. Ports published on `127.0.0.1` stay private: no TCP address and no link.

- Postgres: `psql "host=shop-inner-db-port5432-tcp.<domain> port=443 sslmode=require …"`
- Any client that speaks TLS (Redis `--tls`, MQTTS): connect with that name as SNI.
- SSH through TLS: `ProxyCommand openssl s_client -quiet -connect %h:443 -servername %h`.

Traefik passes these names through to Purgatorium's TCP gateway, which terminates TLS (with `certs/tls.crt`, or a self-signed `*.<domain>` kept in `data/`), wakes the sandbox if needed and connects to the sandbox's frps over `traefik-net` (the port's tcp proxy, through the tunnel to the sandbox). There is no extra authentication: the service's own login protects it. Only web traffic keeps a sandbox awake: without it the sandbox sleeps after its idle timeout even with an open TCP connection, which then drops; the next connection wakes it. Right after a wake the service itself may still be starting (Postgres answers `the database system is starting up`), so let the client retry. The details panel lists the addresses with ready-made commands (**Connect…**), picked by the container's own port (5432 Postgres, 6379 Redis, 22 or 2222 SSH; anything else gets the generic TLS recipe). A `p9m.connect.user` label on the container puts its login into those commands. The API gives the same as `tcp_addresses` (`address`, `port`, `user`) next to `tcp_urls`.

The `tcp-demo` template (on either runtime) shows it end to end. Its starter stack has a Postgres with a sample `orders` table (`<name>-db-tcp`), a Redis (`<name>-redis-tcp`), an SSH server with the user `demo` (`<name>-ssh-tcp`) and pgweb in the browser (`https://<name>-pgweb.<domain>`, user `demo`), all behind one generated password (**Demo password** in the details panel and in **Connect…**). Insert a row with psql and it shows up in pgweb:

```bash
psql "host=<name>-db-tcp.<domain> port=443 sslmode=require user=postgres dbname=postgres" -c "insert into orders (customer, item, amount) values ('me', 'espresso', 3)"
redis-cli -h <name>-redis-tcp.<domain> -p 443 --tls --sni <name>-redis-tcp.<domain> -a <password> ping   # add --insecure with the self-signed certificate
ssh -o ProxyCommand="openssl s_client -quiet -connect %h:443 -servername %h" demo@<name>-ssh-tcp.<domain>
```

The three TCP containers also get an HTTP link in **App ports** (frpc tunnels every published port); those links do not lead anywhere useful.
