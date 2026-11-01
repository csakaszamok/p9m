# Claude Code with the Docker CLI, for a sandbox's own Docker: the claude-code-minimal template.
# A slim cousin of Docker Sandboxes' docker/sandbox-templates:claude-code (same user, home and sudo), without
# the toolchains: the agent builds and runs apps in containers, so it needs little more than claude, docker and git.
FROM docker:29-cli AS docker

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git sudo less procps openssh-client jq \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 docker \
 && useradd -m -u 1000 -s /bin/bash -G sudo,docker agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
USER agent
WORKDIR /home/agent/workspace
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && rm -rf /home/agent/.cache
ENV PATH=/home/agent/.local/bin:$PATH
CMD ["sleep", "infinity"]
