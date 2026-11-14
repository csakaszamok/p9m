# Why Purgatorium, and how it compares

*As of October 2026. What is said about other products comes from the public sources listed at the bottom, and can change quickly.*

## What Purgatorium is for

**A place where a team's apps run: the ones people build with AI agents or vibe-code in an afternoon.** Everyone gets their own space, every app gets a URL colleagues can open, and what nobody uses costs nothing. On your own server, not in someone else's cloud.

Think of it as **a self-hosted Vercel or Railway for the whole team**: you hand an agent a `p9m.env`, it deploys a `docker-compose.yml`, and a minute later `https://shop-web.example.com` works.

## How teams do this today, and what goes wrong

| Today | What goes wrong |
|---|---|
| **It runs on someone's laptop** | No URL to show it, it stops when the lid closes, and it only works on that machine. |
| **A cloud PaaS** (Vercel, Railway, Render, Fly.io, Netlify) | Every experiment is another project on the bill; code and data leave the company network; a multi-container stack (app + database + worker) has to be rebuilt service by service; Vercel runs request-driven functions, not always-on processes. |
| **One shared VPS with Docker or Portainer** | Everyone is on one Docker daemon: they see each other's containers, ports collide, one runaway stack slows everyone down, one wrong `docker rm` hits someone else. |
| **Coolify or Dokploy** | Built for running a team's production apps: an admin sets up projects, everything keeps running all the time, teams on one server still share the daemon. |
| **A VM for everyone** | Expensive while idle, and someone has to create, patch and clean up every one of them. |

## What Purgatorium does instead

- **Self-service, like a cloud PaaS.** Anyone signs in (Google or any OIDC) and creates a sandbox; a quota and CPU / memory limits keep one person from taking the whole server.
- **Its own Docker for everyone.** Every sandbox has its own Docker daemon: what an agent produces (`docker-compose.yml` with app, database, cache) runs as it is, and nobody sees or breaks anyone else's containers.
- **A URL for every app, automatically.** Whatever a sandbox publishes gets `https://<name>-<app>.<domain>`; databases and SSH get a TLS address on port 443. No DNS, no proxy rules per app.
- **Idle costs nothing.** A sandbox without traffic falls asleep and wakes on the next request; after a longer sleep its containers are freed. Twenty experiments, three in use: the server carries three.
- **Made for coding agents.** **Let your agent deploy…** (the Claude Code plugin with `/p9m:init`, or a zip for any agent) gives the agent a token for that one sandbox, Docker access from outside and a registry login; every pushed image is scanned for secrets before anyone can pull it anonymously.
- **Your server, your data, no bill per app.** One `docker compose up` on one Linux host, also inside a company network; no paid edition.
- **Nothing is lost.** Delete archives the sandbox's configuration and data.

## Against a cloud PaaS (Vercel, Railway, Render, Fly.io)

Purgatorium gives a team what these give one developer, on hardware the team already has.

| | Vercel / Railway / Render / Fly.io | Purgatorium |
|---|---|---|
| Where it runs, where the data is | Their cloud | Your server, also inside a company network |
| What you pay for | Every project, service and its usage | The server |
| What you deploy | Mostly one service per app (Vercel: request-driven functions, also from a Dockerfile); Fly.io's Docker Compose support is basic | A whole `docker-compose.yml`, as it is, with its own Docker daemon |
| Idle apps | Railway, Render (free tier) and Fly.io can scale to zero; otherwise they run and are billed | Sleep by default, wake on the next request |
| Many people on one account | A team plan; everyone sees the team's projects | Everyone sees only their own sandboxes; tokens limited to one sandbox |
| Production features | Global edge, autoscaling, managed databases, backups, zero operations | None of these: one host, you run it |

**Pick a cloud PaaS** for an app in production that has to scale and be up at 3 a.m. without you. **Pick Purgatorium** for the many apps before that point: experiments, demos, internal tools, vibe-coded apps, test environments, and for whatever must not leave the company network.

## Against self-hosted tools (Coolify, Dokploy, Portainer)

These also run on your own server, but they are built for **one team running its apps**, not for **many people each having their own space**.

| | Purgatorium | Coolify | Dokploy | Portainer CE |
|---|---|---|---|---|
| Separation between teams on **one** server | each sandbox has its own Docker daemon and network | teams get their own servers; on a shared server the daemon is shared | a shared daemon; members get access per project | a shared daemon; roles (read-only, operator) only in the paid Business Edition |
| What the dashboard hides, Docker also hides | yes | no | no | no |
| Who creates an environment | anyone, within a quota | an admin or team member, in the team's project | an admin, or a member given the permission | an admin |
| Idle apps | sleep | keep running | keep running | keep running |
| Roles and access control | free | free (admin, member) | free (owner, admin, member); custom roles in Enterprise | basic in CE, RBAC paid |
| For agents | an MCP server, a Claude Code plugin, tokens limited to one sandbox | an MCP server (`/mcp`; read-only at first, deploys in later releases) | an MCP server (`Dokploy/mcp`, also deploys) | none built in |
| A preview per pull request | not yet ([roadmap](roadmap.md)) | yes (GitHub, GitLab, Bitbucket, Gitea) | yes (GitHub) | no |

On a shared Docker daemon, anyone who may deploy an arbitrary compose file can, for example, bind-mount host paths or attach to another project's network: the separation in the dashboard does not reach the daemon.

**They work well together:** try and build in a Purgatorium sandbox, push the image to its registry, run it in production with Coolify or Dokploy. A Purgatorium sandbox can also have its own Portainer (the `portainer` template), for that sandbox's daemon alone.

## Looks similar, does a different job

These come up in the same searches ("sandbox", "dev environment", "AI agent"), but they solve another problem:

- **Coder, GitHub Codespaces, Gitpod / Ona, DevPod:** a workspace for **writing code** (an IDE, a repo, a terminal), not a place where the finished app keeps running for others. They fit next to Purgatorium: write in Coder or on the laptop, run in Purgatorium. Coder also runs coding agents: **Coder Tasks** starts one (Claude Code among them) in a workspace of its own, which pauses when idle, and **Coder Agents** runs its own agent from the control plane, so the model's keys never enter the workspace; process-level network and command rules for agents (Agent Boundaries) are not in the free edition. What the agent builds lives as long as its workspace, without an address for colleagues.
- **E2B, Daytona, Docker Sandboxes, Modal, Northflank sandboxes, kubernetes-sigs/agent-sandbox, Alibaba OpenSandbox:** they let an agent **execute code** in an isolated box for minutes or hours, driven from an SDK, usually inside a microVM. None of them is meant to keep a team's app online at a URL for weeks. Daytona is no longer open source: its development moved to a private codebase, and its AGPL repository is archived at v0.190.0 (a community fork, Nightona, carries it on).

## Where Purgatorium is weaker

1. **Isolation is not yet a boundary against hostile code.** The `dind` runtime runs the sandbox `privileged`: root inside a sandbox can escape to the host. That is fine for colleagues and their own agents, not for strangers. The `sysbox` runtime removes `privileged` and is used in production, but still shares the host's kernel. The **`kata`** runtime puts each sandbox in a lightweight VM with its own kernel, but needs a host with KVM (not a plain VPS), is x86_64 only, and leaves a residual risk on the host ([Security](security.md#the-kata-runtime-a-vm-per-sandbox)).
2. **One host for now.** No multi-host scheduling and no warm pool; a new sandbox takes about 10 seconds once its images are pulled (the first one on a new server a minute or two), a wake from deep sleep about 30. **Kubernetes support** is on the roadmap.
3. **Sleep stops the containers.** On wake the stack restarts by its restart policies; what was only in memory is gone.
4. **Missing pieces:** no teams yet (a sandbox has one owner), no hard disk quota (only a warning above a disk limit; CPU and memory limits exist), no egress rules, no SDK (a REST API with an [OpenAPI document](api.md#openapi-and-clients) to generate a client from, the Docker CLI and [agent-guide.md](agent-guide.md)).
5. **A young, small project:** no community yet, no external security audit.

## When to choose something else

- **Production that must scale and stay up without you** → a cloud PaaS, or Coolify / Dokploy on your own servers.
- **Untrusted code from strangers** (public sign-up) → Purgatorium's `kata` runtime on a KVM host, or a microVM sandbox service (E2B, Docker Sandboxes, Northflank) where you have no KVM.
- **Writing code in a cloud IDE** → Coder or Codespaces.
- **An agent running short scripts from an SDK** → E2B, Daytona (as a service) or agent-sandbox.
- **Coding agents for a large engineering team, with policies per process** → Coder (its agent features beyond Tasks are partly paid).
- **GPU or ML work** → Modal.

## Sources

- Cloud PaaS: [Railway serverless (app sleeping)](https://docs.railway.com/deployments/serverless), [Railway vs Vercel: containers and serverless](https://render.com/articles/railway-vs-vercel), [Vercel: Docker Compose concepts](https://vercel.com/kb/guide/docker-compose-concepts-on-vercel), [Vercel runs Dockerfiles](https://cloudnativenow.com/features/vercel-now-lets-you-deploy-any-dockerfile-straight-to-production/), [Docker on Render](https://render.com/docs/docker), [Railway vs Render vs Fly.io](https://devtoolpicks.com/blog/railway-vs-render-vs-fly-io-solo-developers-2026), [Fly.io: Docker Compose compatibility](https://community.fly.io/t/docker-compose-compatibility-the-journey-begins/25285)
- Coolify: [concepts: teams and servers](https://coolify.io/docs/get-started/concepts), [roles and permissions](https://coolify.io/docs/core/team/roles-and-permissions), [security model](https://coolify.io/docs/core/security-model)
- Dokploy: [GitHub](https://github.com/dokploy/dokploy), [permissions](https://docs.dokploy.com/docs/core/permissions), [custom roles (Enterprise)](https://docs.dokploy.com/docs/core/enterprise/custom-roles)
- Portainer: [CE vs Business Edition](https://oneuptime.com/blog/post/2026-03-20-portainer-ce-vs-business-edition/markdown), [multi-tenant setup](https://oneuptime.com/blog/post/2026-03-20-portainer-multi-tenant-setup/markdown)
- Coder: [GitHub](https://github.com/coder/coder), [workspace scheduling](https://coder.com/docs/user-guides/workspace-scheduling), [Coder Tasks](https://coder.com/docs/ai-coder/tasks), [Coder Agents](https://coder.com/docs/ai-coder/agents)
- Daytona: [the archived repository](https://github.com/daytonaio/daytona), [Nightona](https://github.com/nightona-co/nightona)
- Agents in Coolify and Dokploy: [Dokploy MCP](https://github.com/Dokploy/mcp), [Coolify vs Dokploy (Coolify's page)](https://coolify.io/compare/coolify-vs-dokploy), [Coolify's MCP server and Dokploy's](https://bex.co/blog/2026/07/09/coolify-mcp-server-read-only-dokploy-fleet-health)
- Agent sandboxes: [Docker Sandboxes](https://www.docker.com/products/docker-sandboxes/), [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), [OpenSandbox](https://github.com/alibaba/OpenSandbox), [Northflank: Daytona vs E2B](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes), [Upstash: 15 providers compared](https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026)
- Kata Containers: [limitations](https://github.com/kata-containers/kata-containers/blob/3.2.0/docs/Limitations.md), [Kata with Docker](https://oneuptime.com/blog/post/2026-02-08-how-to-use-kata-containers-with-docker-for-enhanced-isolation/markdown)
