# Sleep and wake

A sandbox is **running**, **asleep** (containers stopped, data intact), in **deep sleep** (containers and network removed, data intact) or **archived** (after an explicit delete). There is no fixed-time expiry: a sandbox only sleeps when nobody uses it, and only a person deleting it removes it.

Handled entirely by [Sablier](https://github.com/sablierapp/sablier). The sandbox's outer containers (DinD, frps, socat) form one Sablier group and its Traefik router carries the Sablier middleware. After `idle_timeout` without HTTP traffic the group is stopped — which stops everything inside the sandbox too. The sandbox's router exists only while it runs, so the next request reaches Purgatorium's catch-all `/wake`, which wakes it within the owner's limits (see [Web UI and sign-in](https://csakaszamok.github.io/p9m/0.21/web-ui/index.md)) and shows a waiting page until the router is back; the socat healthcheck only passes once the FRP tunnel is online (an app's HTTP proxy, or for a stack that publishes no port, frpc's readiness marker for 15 seconds). Sablier still measures the idle time and puts the sandbox to sleep. **Reset** next to *Sleeps in* in the panel (`POST /sandboxes/:name/keep-awake`) starts the countdown over, as a visit would; it does not wake a sleeping sandbox.

> **Apps must set a restart policy to come back after sleep.** When the sandbox wakes, its inner Docker daemon only restarts containers with `restart: unless-stopped` or `restart: always`. Without one, the app stays stopped and has to be started by hand (`docker start`, or from Portainer):
>
> ```
> services:
>   web:
>     image: my-app
>     restart: unless-stopped
>   db:
>     image: postgres:16
>     restart: unless-stopped
> ```

HTTP traffic through Traefik counts as activity, and so does traffic on a Docker connection (`DOCKER_HOST=tcp://<raw>-docker.<domain>:443`): Purgatorium renews the session once a minute while bytes go through it. A Docker connection that is only open does not count, and a Docker connection never wakes a sleeping sandbox: Docker Desktop keeps every context connected for its Builds view and reconnects at once, so it would wake the sandbox each time it fell asleep. Wake it first (**Wake**, `POST /sandboxes/:name/start`, or open one of its apps); until then `docker` cannot connect. Sablier persists its sessions (`--storage.file`), so restarting Sablier does not put running sandboxes to sleep. A sandbox started without Purgatorium (Docker restarting it, `docker compose start` by hand, or Purgatorium restarted while it was starting one) has no session at first; Purgatorium notices within two minutes and opens one, so it still sleeps after its `idle_timeout`. After a host reboot, sandboxes that were asleep stay asleep.

The sandbox list (`GET /sandboxes` adds `stops_at`, `deep_sleep_at` and `deep_sleep_after` to each row) and the details panel show **Sleeps in** (time until Sablier stops a running sandbox; every request resets it — read from Sablier's `/metrics`, which Purgatorium reaches on `sablier-net`) and **Deep sleep in** (time until an asleep sandbox is taken down).

Both times can be changed after creation — **Change…** next to *Sleep* on the panel's **Details** tab, or `PATCH /sandboxes/<name>` with `{"idle_timeout": "45m", "deep_sleep_after": "14d"}` (either field; same formats as at creation; owner or admin). The values are written into the sandbox's `docker-compose.yml`. A new `idle_timeout` recreates only the socat container, which carries the Sablier middleware labels: a running sandbox's apps are unreachable for a few seconds, an asleep one stays asleep, and the DinD container and its inner stack are not touched; it applies from the next request's Sablier session. A new `deep_sleep_after` applies immediately — Purgatorium reads it from the compose file.

`idle_timeout` takes seconds, minutes, hours or days (`30s`, `30m`, `2h`, `1d`); days are kept as hours (`1d` becomes `24h`), because Sablier's durations have no days. `deep_sleep_after` takes `m`, `h` or `d`. The server can set a ceiling for users' sandboxes: `SANDBOX_MAX_IDLE_TIMEOUT` and `SANDBOX_MAX_DEEP_SLEEP_AFTER` ([Configuration](https://csakaszamok.github.io/p9m/0.21/configuration/index.md)); a value above it, or never, is refused (*at most 2h on this server*). `0` or `off` means never, for both — at creation and when changing them. `deep_sleep_after: off` never takes the sandbox down. Sablier has no "never", so `idle_timeout: off` is written as a 10-year session (`87600h`): the sandbox keeps running, and if it is stopped by hand the next request still wakes it. The panel and the list show "never" for either.
