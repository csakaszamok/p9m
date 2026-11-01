# Security

Purgatorium is built for a team that trusts each other's intentions but not each other's mistakes: it keeps one person's broken compose file, runaway container or exposed port from affecting everyone else. It is **not** a boundary against hostile code.

What it does:

- each user gets their own Docker daemon, so their containers, images, volumes and networks are separate from everyone else's and from the host's Docker;
- an app's private addresses are reachable only inside its own sandbox, and ports published on `127.0.0.1` only through its tunnel (see [Isolation between sandboxes](networking.md#isolation-between-sandboxes));
- users see and change only their own sandboxes, through the UI, the API or a personal access token; the admin sees all;
- a sandbox's web apps open only for its owner (and the admin) unless labelled `domain` or `public` ([App access](app-access.md));
- with an `https://` `PUBLIC_URL`, Purgatorium refuses to start with default secrets; `docker compose` does not start without an `ADMIN_TOKEN`, and Purgatorium does not start with OIDC open to anyone (`OIDC_ALLOW_ANYONE=true` aside);
- the direct plain-HTTP API port `8081` listens on the host only (`P9M_API_BIND`): from elsewhere everything goes through Traefik.

**On every server**: install [sysbox](https://github.com/nestybox/sysbox) on the host. Only `sysbox` is allowed by default (`ALLOWED_RUNTIMES`), so nobody can create a privileged `dind` sandbox; without sysbox no sandbox can be created at all. **The `dind` runtime is for development only** (a laptop, Docker Desktop): never allow it on a server. `check-host.sh` tells whether sysbox works on the machine, and, run in the `p9m` folder, lists what else is not secure. Sandboxes that already exist keep their runtime: recreate the `dind` ones.

What it does not do:

- **Without sysbox, sandboxes run `privileged` (the `dind` runtime).** Code with root inside such a sandbox can escape to the host. That is why only `sysbox` is allowed by default, which runs Docker in an unprivileged container; Docker Desktop cannot run sysbox, so for development there `dind` is allowed (`docker-compose.dev.yml`), and Purgatorium says so at startup. Only let people and agents you would give a shell on the host run code in `dind` sandboxes.
- **`sysbox` is not a VM:** its sandboxes run unprivileged, in their own user namespace, but share the host's kernel, so a kernel exploit would still reach the host.
- There is no network policy between a sandbox and the internet, and no hard disk quota per sandbox: only a warning above its disk limit (see [Disk](resources.md#disk)); CPU and memory limits exist (see [CPU and memory](resources.md#cpu-and-memory)).
- The Purgatorium container mounts the host's Docker socket, so whoever controls Purgatorium controls the host. That is why a sandbox's starter stack is always its template's (no compose text of the user's goes through Purgatorium), and is run by `docker compose` inside the sandbox, not in the Purgatorium container; why the files Purgatorium reads and writes in a sandbox's directory are mounted into the sandbox read-only (`/inner`, and of `/certs` only its dockerd's certificate), and read and written without following a symlink; and why Purgatorium's internal port (app access for Traefik) listens only on a network no sandbox is on. Traefik's API is not served.
- A sandbox is on its own network only: Purgatorium and Traefik reach it through its frp tunnel (frpc connects out of it), so no sandbox reaches another one's ports past [app access](app-access.md).
- A [host folder](web-ui.md#host-folders) the admin mounts into a sandbox (`HOST_MOUNT_ROOTS`) is the sandbox owner's, as root, and every app's and agent's in it: read-only only limits writing. Keep the roots narrow.

In short, run it for a team, on a server you can rebuild, best behind a VPN or with the sign-in limited to your domain; for untrusted code (public sign-up, code from strangers), use a microVM-based sandbox instead; a Kata Containers runtime (a VM per sandbox) is on the [roadmap](roadmap.md).

Found a vulnerability? See [SECURITY.md](https://github.com/csakaszamok/p9m/blob/main/SECURITY.md).
