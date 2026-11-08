# HTTPS

Purgatorium serves HTTPS with a certificate you copy in (no automatic issuing):

1. Copy a wildcard certificate for `*.<HOST_DOMAIN>` (ideally also `<HOST_DOMAIN>`; with an [`APPS_DOMAIN`](https://csakaszamok.github.io/p9m/0.19/networking/#a-separate-domain-for-the-apps), `*.<APPS_DOMAIN>` too, in the same certificate) to `certs/tls.crt` (PEM, full chain: certificate + intermediates) and its key to `certs/tls.key` (PEM, unencrypted). `certs/` is git-ignored.
1. Set `PUBLIC_URL=https://p9m.<HOST_DOMAIN>` and strong `ADMIN_TOKEN`, `SESSION_SECRET` and `ADMIN_PASSWORD` in `.env`.
1. `docker compose up -d p9m traefik`. At startup Purgatorium writes `dynamic/tls.yml` (the certificate + an HTTP→HTTPS redirect for every host); Traefik serves the UI, API, registry and every sandbox app on port 443.

To renew, overwrite the two files and run `docker compose restart traefik`. Remove them and restart Purgatorium (`docker compose up -d p9m`) to go back to plain HTTP.

## Trying it locally with HTTPS (e.g. on Windows)

With `PUBLIC_URL=https://p9m.lvh.me` but no certificate in `certs/`, Traefik answers with its own self-signed one: the browser says *Not secure*, and although you can click through for the pages, it refuses the connections pages open themselves — the browser **Terminal** stays *disconnected*. (`lvh.me` and every `*.lvh.me` resolve to 127.0.0.1, so nothing else is needed.) Make a certificate your machine trusts with [mkcert](https://github.com/FiloSottile/mkcert). In PowerShell:

```
winget install FiloSottile.mkcert
# winget changes PATH for new shells only: pick it up in this one
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
mkcert -install                     # adds a local CA to Windows' trusted roots (confirm the dialog)
cd <your p9m checkout>
New-Item -ItemType Directory -Force certs | Out-Null
mkcert -cert-file certs\tls.crt -key-file certs\tls.key "*.lvh.me" lvh.me
docker compose restart p9m traefik
```

Then close the browser completely and open `https://p9m.lvh.me` again. On macOS / Linux the same with `brew install mkcert` / your package manager, and `certs/tls.crt`, `certs/tls.key`. The TLS TCP addresses (`psql`, SSH) use this certificate too, so their *self-signed certificate* warnings go away. Firefox keeps its own trust store: `mkcert -install` covers it when `certutil` (NSS tools) is installed.

The direct plain-HTTP API port 8081 is reachable only on the host (`P9M_API_BIND=127.0.0.1`, the default since 0.14.0): keep it so in a public deployment — with `PUBLIC_URL` set, docker clients get registry tokens from `$PUBLIC_URL/v2/auth`, i.e. over HTTPS.

With an `https://` `PUBLIC_URL`, Purgatorium **refuses to start** while `ADMIN_TOKEN` or `SESSION_SECRET` is a default or `.env.example` value (or `SESSION_SECRET` is unset), or `ADMIN_PASSWORD` is while `ADMIN_LOGIN=on`. A running sandbox whose address no router matches shows "This address does not reach the sandbox" instead of an endless waiting page.
