# Install

No git clone is needed: every file comes from a GitHub release, and the image carries the rest.

First check the machine; it changes nothing (give it the `HOST_DOMAIN` you plan to use):

```
curl -fsSL https://github.com/csakaszamok/p9m/releases/latest/download/check-host.sh | bash -s -- dev.example.com
```

Or download it, read it, then run it:

```
curl -fsSLO https://github.com/csakaszamok/p9m/releases/latest/download/check-host.sh
less check-host.sh
bash check-host.sh dev.example.com
```

Then, on a Linux host with Docker Engine, the compose plugin (Compose 2.17 or newer) and [sysbox](https://github.com/nestybox/sysbox) 0.7.0 or newer (without it no sandbox can be created, unless you use the [Kata runtime](#kata-containers-the-microvm-runtime) instead: the privileged `dind` runtime is for development only):

```
mkdir p9m && cd p9m
curl -fsSLO https://github.com/csakaszamok/p9m/releases/latest/download/docker-compose.yml
curl -fsSL https://github.com/csakaszamok/p9m/releases/latest/download/setup.sh | bash -s -- dev.example.com   # .env with your domain and random secrets
docker compose up -d
```

The directory must be called `p9m`: the compose project name comes from it. For a given version, use `releases/download/v0.5.0/…` instead of `releases/latest/download/…`.

`check-host.sh` checks Docker and Docker Compose, sysbox (and, if you use it, Kata), the address pools, ports, disk and registry access, and changes nothing (its sysbox check runs one throw-away `alpine` container); with the `HOST_DOMAIN` you plan to use it also checks the DNS records and, if `certs/` has one, the certificate. Lines marked ✘ must be fixed first, ⚠ are worth reading. Run it again in the `p9m` folder once Purgatorium is set up: it then also checks the security of its `.env` and of the host (the API port, the admin's password sign-in, default secrets, an open OIDC sign-in, HTTPS, other open ports, the firewall, automatic updates, SSH passwords), marks each problem with **!**, and lists them all again at the end under *NOT SECURE*.

`setup.sh` works in the current directory: it creates `.env` from its release's `env.example`, sets `HOST_DOMAIN` to the domain you give it and `PUBLIC_URL` to `p9m.<domain>` (`https://` if `certs/` already holds a certificate, else `http://`: run it again with the domain after adding one; a `PUBLIC_URL` you set yourself is kept), fills in random secrets, creates `data/`, `opt/`, `certs/` and `dynamic/`, and prints the admin password and token. It keeps values you already set, so it is safe to run again. Without it: download `env.example` of the release as `.env` and set `HOST_DOMAIN`, `PUBLIC_URL` and the three secrets by hand.

`docker compose up -d` pulls the released image `ghcr.io/csakaszamok/p9m`. It carries the sandbox templates and runtimes, and the files the other services read: on every `up` the one-shot `p9m-init` service copies the Sablier themes, the error pages, the registry config and `dynamic/errors.yml` from it, so they always match the running version. To work on the code, see [CONTRIBUTING.md](https://github.com/csakaszamok/p9m/blob/main/CONTRIBUTING.md).

The stack runs Traefik v3.6 with the Sablier plugin, Sablier, a registry and the Purgatorium API. The UI is at `http://p9m.<HOST_DOMAIN>` (by default `http://p9m.lvh.me`, which resolves to `127.0.0.1`), the API also on port `8081` of the host.

An app takes seconds to open the first time?

In Chrome, *Settings → Privacy and security → Security → Use secure DNS*: with "your current service provider" each new `*.lvh.me` name can wait for a slow or filtering resolver. Turn it off, or pick a provider such as Cloudflare (1.1.1.1).

Each sandbox's files (compose file, certificates, tunnel config) live in `opt/sandboxes/<owner>/<name>/`, its archives in `opt/archive/<owner>/`; `<owner>` is `admin` or the user's sign-in e-mail.

> **Give the Docker daemon a larger address pool.** Every sandbox — sleeping ones included — keeps its own compose network until it is archived. Docker's default pools only allow about 30 networks; beyond that sandbox creation fails with `fully subnetted`. Set smaller subnets in the daemon config (`/etc/docker/daemon.json`, or Docker Desktop → Settings → Docker Engine) and restart Docker:
>
> ```
> { "default-address-pools": [ { "base": "10.64.0.0/12", "size": 28 } ] }
> ```
>
> A sandbox network needs only a handful of addresses, so `/28` subnets are enough: `10.64.0.0/12` holds 65536 of them (`10.10.0.0/16` would hold 4096). Pick a range your server's own networks do not use (see `ip route`). Changing the pools later leaves the networks made before as they are: list the old pool too, after the new one, so Docker never hands out its addresses twice.
>
> **traefik-net** is the exception: every running sandbox takes two addresses on it (its frps and socat), so on a `/28` only 4 sandboxes can run at once, and the next one starts without its tunnel (`no available IPv4 addresses on this network's address pools: traefik-net`). Give it its own subnet, outside the pools above, in a `docker-compose.override.yml` next to `docker-compose.yml` (Docker Compose reads it on its own, and it stays when you replace `docker-compose.yml` on an upgrade):
>
> ```
> networks:
>   traefik-net:
>     ipam:
>       config:
>         - subnet: 10.11.0.0/20
> ```
>
> On a server already running, the network must be made again: take Purgatorium and the sandboxes' containers down (their data stays: they wake as from a deep sleep), remove the network, and start Purgatorium again:
>
> ```
> docker compose down
> for p in $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep '^p9m-'); do docker compose -p "$p" down; done
> docker network rm traefik-net
> docker compose up -d
> ```
>
> `check-host.sh` tells how many sandboxes `traefik-net` has room for.

## Kata Containers, the microVM runtime

For code you do not trust, the `kata` runtime puts each sandbox in its own VM ([Security](https://csakaszamok.github.io/p9m/0.20/security/#the-kata-runtime-a-vm-per-sandbox)). It is optional and off by default. What it needs:

- **A host with KVM** (`/dev/kvm`), x86_64, kernel 5.8 or newer: a bare-metal server, or a cloud VM with nested virtualization. A plain VPS such as Hetzner Cloud has no KVM and cannot run it; there, use sysbox.
- **Kata 4.3.1** with Cloud Hypervisor (or QEMU), set up for Purgatorium. Do not install Kata by hand: run the script from the release (from a clone, `sudo scripts/install-kata.sh` is the same); it changes the host:

```
curl -fsSLO https://github.com/csakaszamok/p9m/releases/latest/download/install-kata.sh
less install-kata.sh
sudo bash install-kata.sh            # --hypervisor clh|qemu (default clh), --yes to allow stopping running containers
```

The script downloads Kata 4.3.1, adjusts its hypervisor configuration (VM sizing, the virtiofsd options that drop the capabilities to create device nodes and file capabilities, locked-down annotations), registers the `kata` runtime in `/etc/docker/daemon.json`, mounts Docker's data root and `/var/lib/containerd` `nosuid,nodev` (an `/etc/fstab` self-bind mount, so a setuid file or device node a sandbox writes is inert on the host), and sets `/run/kata-containers` to `0750`. It is safe to run again. Docker is restarted only when something changed, and with containers running only if you pass `--yes` (the script stops without it): they stop for the restart.

Then allow the runtime in `.env` and recreate Purgatorium: `ALLOWED_RUNTIMES=sysbox,kata`, and `DEFAULT_RUNTIME=kata` on top of that if new sandboxes should use it by default (`DEFAULT_RUNTIME=kata` alone does not allow it: every create without a runtime would be refused). Kata sandboxes also take their own address range, `SANDBOX_SUBNET_POOL` (default `10.213.0.0/16`, one `/28` per sandbox), which must not overlap the host's Docker address pools ([Configuration](https://csakaszamok.github.io/p9m/0.20/configuration/index.md)). `check-host.sh` has a Kata section that checks all of this, including a test run.

**Docker's volumes on a separate disk.** A filesystem mounted under the data root or `/var/lib/containerd` (`/var/lib/docker/volumes` on a disk of its own, say) keeps its own mount options, so the data root's self-bind does not harden it. The script carries such a mount along when it is `nosuid,nodev` itself, and refuses before it changes anything when it is not: add `nosuid,nodev` to that mount's own options in `/etc/fstab`, remount it (`sudo mount -o remount,nosuid,nodev /var/lib/docker/volumes`) and run the script again. Do not put `nosuid` on the root filesystem `/`: it breaks `sudo` and `su`. If the mounts it lists belong to running containers, stop those and run it again. When the data root is itself a filesystem of its own already mounted `nosuid,nodev`, no self-bind is added for it. `check-host.sh` checks the data root, `volumes` and `overlay2` separately for the same reason.

**On a host that also runs sysbox sandboxes**, the `nosuid,nodev` data root also disables setuid programs in their `/opt`, `/home`, `/root` and `/srv` volumes. `check-host.sh` says so as information; if you need setuid there, give the Kata sandboxes their own host.

> **Before exposing Purgatorium publicly**, set `ADMIN_TOKEN`, `SESSION_SECRET` and `ADMIN_PASSWORD` to real secrets (`setup.sh` does). `docker compose` does not start without an `ADMIN_TOKEN`; the `.env.example` placeholders are only meant for local dev and the e2e scripts: Purgatorium logs a startup warning while one is in effect, and refuses to start with an `https://` `PUBLIC_URL`. The direct API port `8081` listens on the host only (`P9M_API_BIND`), and OIDC needs `OIDC_ALLOWED_DOMAINS` or `OIDC_ALLOWED_EMAILS` (see [Configuration](https://csakaszamok.github.io/p9m/0.20/configuration/index.md)).

All settings: [Configuration](https://csakaszamok.github.io/p9m/0.20/configuration/index.md). For HTTPS: [HTTPS](https://csakaszamok.github.io/p9m/0.20/https/index.md).
