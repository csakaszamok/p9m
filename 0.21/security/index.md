# Security

Purgatorium is built for a team that trusts each other's intentions but not each other's mistakes: it keeps one person's broken compose file, runaway container or exposed port from affecting everyone else. It is **not** a boundary against hostile code.

What it does:

- each user gets their own Docker daemon, so their containers, images, volumes and networks are separate from everyone else's and from the host's Docker;
- an app's private addresses are reachable only inside its own sandbox, and ports published on `127.0.0.1` only through its tunnel (see [Isolation between sandboxes](https://csakaszamok.github.io/p9m/0.21/networking/#isolation-between-sandboxes));
- users see and change only their own sandboxes, through the UI, the API or a personal access token; the admin sees all;
- a sandbox's web apps open only for its owner (and the admin) unless labelled `domain` or `public` ([App access](https://csakaszamok.github.io/p9m/0.21/app-access/index.md));
- with an `https://` `PUBLIC_URL`, Purgatorium refuses to start with default secrets; `docker compose` does not start without an `ADMIN_TOKEN`, and Purgatorium does not start with OIDC open to anyone (`OIDC_ALLOW_ANYONE=true` aside);
- the direct plain-HTTP API port `8081` listens on the host only (`P9M_API_BIND`): from elsewhere everything goes through Traefik.

**On every server**: install [sysbox](https://github.com/nestybox/sysbox) on the host. Only `sysbox` is allowed by default (`ALLOWED_RUNTIMES`), so nobody can create a privileged `dind` sandbox; without sysbox no sandbox can be created at all. **The `dind` runtime is for development only** (a laptop, Docker Desktop): never allow it on a server. For code you do not trust, add the [`kata` runtime](#the-kata-runtime-a-vm-per-sandbox). `check-host.sh` tells whether sysbox works on the machine, and, run in the `p9m` folder, lists what else is not secure. Sandboxes that already exist keep their runtime: recreate the `dind` ones.

What it does not do:

- **Without sysbox, sandboxes run `privileged` (the `dind` runtime).** Code with root inside such a sandbox can escape to the host. That is why only `sysbox` is allowed by default, which runs Docker in an unprivileged container; Docker Desktop cannot run sysbox, so for development there `dind` is allowed (`docker-compose.dev.yml`), and Purgatorium says so at startup. Only let people and agents you would give a shell on the host run code in `dind` sandboxes.
- **`sysbox` is not a VM:** its sandboxes run unprivileged, in their own user namespace, but share the host's kernel, so a kernel exploit would still reach the host. The `kata` runtime below is the one with a VM.
- There is no network policy between a sandbox and the internet, and no hard disk quota per sandbox: only a warning above its disk limit (see [Disk](https://csakaszamok.github.io/p9m/0.21/resources/#disk)); CPU and memory limits exist (see [CPU and memory](https://csakaszamok.github.io/p9m/0.21/resources/#cpu-and-memory)).
- The Purgatorium container mounts the host's Docker socket, so whoever controls Purgatorium controls the host. That is why a sandbox's starter stack is always its template's (no compose text of the user's goes through Purgatorium), and is run by `docker compose` inside the sandbox, not in the Purgatorium container; why the files Purgatorium reads and writes in a sandbox's directory are mounted into the sandbox read-only (`/inner`, and of `/certs` only its dockerd's certificate), and read and written without following a symlink; and why Purgatorium's internal port (app access for Traefik) listens only on a network no sandbox is on. Traefik's API is not served.
- A sandbox is on its own network only: Purgatorium and Traefik reach it through its frp tunnel (frpc connects out of it), so no sandbox reaches another one's ports past [app access](https://csakaszamok.github.io/p9m/0.21/app-access/index.md).
- A [host folder](https://csakaszamok.github.io/p9m/0.21/web-ui/#host-folders) the admin mounts into a sandbox (`HOST_MOUNT_ROOTS`) is the sandbox owner's, as root, and every app's and agent's in it: read-only only limits writing. Keep the roots narrow.

## The `kata` runtime: a VM per sandbox

With `kata`, each sandbox runs in a hardware virtual machine (Kata Containers with Cloud Hypervisor) with its own guest kernel. Root inside a sandbox is root of the guest only: the sandbox container is not privileged on the host, and a kernel exploit inside it reaches the guest's kernel, not the host's. This is the runtime to use for code from people you do not trust. It is opt-in (`kata` in `ALLOWED_RUNTIMES`, see [Install](https://csakaszamok.github.io/p9m/0.21/install/#kata-containers-the-microvm-runtime)), and the `sudo scripts/install-kata.sh` script sets the host up for it.

What is left, and what the host must do about it:

- **virtiofsd runs as root on the host.** The sandbox's volumes are shared into the VM by virtiofsd, a host process that runs as root, behind the VM boundary, in its own sandbox and with a seccomp filter. A bug in it that a guest could reach would act with host root's rights. The installer starts it with the capabilities to create device nodes and file capabilities dropped, and keeps Kata's annotations locked down, so a sandbox cannot change the VM's configuration. `check-host.sh` verifies this, and keep Kata up to date.
- **Device nodes do not cross.** virtiofsd refuses to create a device node on the paths it shares (the root filesystem and the volumes): guest root's `mknod` there fails with `Operation not permitted`, except for the 0:0 whiteouts overlay filesystems use. Only the guest's own memory (its `/tmp`, a tmpfs) can hold one, and it never reaches the host. `check-host.sh` looks for device nodes left in the volumes from before the host switched to Kata.
- **Setuid files are inert on the data root.** Docker's data root (and `/var/lib/containerd`) is mounted `nosuid,nodev`, so a setuid file the guest writes does nothing if something on the host runs it. A Kata sandbox also gets a read-write [host folder](https://csakaszamok.github.io/p9m/0.21/web-ui/#host-folders) only on a mount that is `nosuid,nodev`.
- **One read-write folder is outside the data root: `ssh-host-keys`.** It lives in the sandbox's directory under `opt/sandboxes` and is bound read-write, so the sandbox keeps its SSH host keys. Guest root can leave a root-owned setuid file there and change the folder's mode, but not its parent's: Purgatorium makes every sandbox directory `0700`, so only root on the host can reach such a file. Mounting `opt/sandboxes` `nosuid,nodev` as well makes it inert; `check-host.sh` warns when it is not.
- **The running container's root filesystem is visible on the host,** and is protected only by directory permissions (`/var/lib/docker` is `0710`, and `/run/kata-containers` `0750`). Keep other users off the host, and do not loosen those modes.
- **Host tools must treat sandbox data as untrusted.** A backup, restore or scan tool that runs as root over a sandbox's volumes should not follow its symlinks, trust its permission bits, or open its device files.
- **On a host that also runs `sysbox` sandboxes,** the `nosuid,nodev` data root disables setuid programs in their `/opt`, `/home`, `/root` and `/srv` volumes too (a setuid program such as `sudo` there stops working). `check-host.sh` notes this as information.

On every runtime, `kata` or not, Purgatorium treats what it copies out of a sandbox as untrusted. An archive (a `0700` directory) keeps the sandbox's configuration as regular files only: no device nodes, no links, no SSH host keys. Its volumes, though, are tarballs of the volumes as they were, setuid bits and device nodes included: restore them only onto a `nosuid,nodev` target, or strip setuid bits and device nodes right after extracting, as export-restore does (see [Delete = archive](https://csakaszamok.github.io/p9m/0.21/archive/index.md)). Cloning drops device nodes other than whiteouts. Export-restore strips setuid and setgid bits and device nodes after each extract.

Limits of the runtime itself: x86_64 only, and the host needs KVM (bare metal, or a VM with nested virtualization; not Hetzner Cloud or a similar plain VPS).

In short, run it for a team, on a server you can rebuild, best behind a VPN or with the sign-in limited to your domain. For untrusted code (public sign-up, code from strangers), use the `kata` runtime on a KVM host, or a microVM-based service; on a host without KVM a gVisor runtime is on the [roadmap](https://csakaszamok.github.io/p9m/0.21/roadmap/index.md).

Found a vulnerability? See [SECURITY.md](https://github.com/csakaszamok/p9m/blob/main/SECURITY.md).
