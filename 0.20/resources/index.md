# CPU, memory and disk

## CPU and memory

Every sandbox runs with a CPU and memory limit: the sandbox and everything inside it share it (the inner containers live in the sandbox container's cgroup). New sandboxes get `SANDBOX_CPUS` / `SANDBOX_MEMORY` (default 2 CPUs, 4 GB); on create (**Advanced**) or later (**Resources…** in the panel, `PATCH /sandboxes/:name` with `cpus`, `memory`) a user can raise their sandbox's limits up to `SANDBOX_MAX_CPUS` / `SANDBOX_MAX_MEMORY` (default 4 and 8 GB), the admin up to the host's size. A change applies at once without a restart (`docker update`) and is kept in the sandbox's compose file. Memory below what a running sandbox uses now is refused (stop it first). There is no swap beyond the memory limit.

The panel shows the sandbox's current CPU and memory against its limits (sampled every 10 s), and the list a short *CPU · Mem* column for running sandboxes. The API gives `limits` (`cpus`, `memory` in bytes) and, for a running sandbox, `usage` (`cpu` in cores, `memory`, `memory_limit`).

## Disk

Everything a sandbox keeps (its inner images, containers and volumes) is in its own `docker_data` volume. Purgatorium measures it from outside with `du`: a running sandbox every 15 minutes, an asleep one once after it stopped (its size does not change while it sleeps); the results are kept in `data/disk-usage.json`. The **Resources** tab shows the use against the sandbox's disk limit, `SANDBOX_DISK` (20 GB by default); the admin can set another one per sandbox (**Change limits…**, or `PATCH /sandboxes/:name` with `disk`).

Above the limit the panel and the sandbox list show ⚠ and suggest cleaning up (`docker system prune` in the sandbox). It is **only a warning**: nothing is stopped or refused, and a sandbox can use more until the host's disk is full. A hard limit (a fixed-size disk per sandbox) is on the [roadmap](https://csakaszamok.github.io/p9m/0.20/roadmap/index.md).
