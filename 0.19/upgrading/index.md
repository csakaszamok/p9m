# Upgrading

To a new version, in the install directory:

```
curl -fsSLO https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml
docker compose pull && docker compose up -d
```

If `.env` sets `P9M_VERSION`, change or remove it. Each release's notes are in the [changelog](https://github.com/csakaszamok/p9m/blob/main/CHANGELOG.md).

## To 0.14.0: the secure defaults

Purgatorium 0.14.0 no longer starts with open defaults. Before `docker compose up -d`, check `.env`:

- **`ADMIN_TOKEN`** must be set: `docker compose` refuses to start without it (the compose file had `abc123` as a fallback). `./setup.sh` fills in a random one; scripts and agents using the old token need the new one.
- **The API port `8081` listens on the host only.** If something on another machine called `http://<server>:8081` (a script, or docker clients getting registry tokens while `PUBLIC_URL` is empty), point it at `PUBLIC_URL` instead, or set `P9M_API_BIND=0.0.0.0` on a trusted network.
- **With OIDC on, set `OIDC_ALLOWED_DOMAINS` or `OIDC_ALLOWED_EMAILS`**, or Purgatorium refuses to start (`docker compose logs p9m` says why). To keep letting anyone with an account at the provider in, set `OIDC_ALLOW_ANYONE=true`.

`./check-host.sh`, run in the install directory, lists what is still open.

## From Purgatory (p7y)

There is no upgrade from Purgatory (p7y), the project's former name: [install](https://csakaszamok.github.io/p9m/0.19/install/index.md) Purgatorium afresh, in a new directory called `p9m`. Nothing is carried over: sandboxes, archives, users, tokens and settings start empty, and `P7Y_*` settings and `p7y.*` labels are not read.
