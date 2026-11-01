# The claude-code-minimal image with ECC (github.com/affaan-m/ECC, MIT) installed into Claude Code as the ecc@ecc
# plugin: agents, skills and hooks for a plan → test → review workflow. Its hooks run on Node.js and its session
# observer (continuous learning) on Python, so both are added.
# ECC is pinned to a release tag and its commit: a new one is taken on purpose, after trying it.
ARG BASE=ghcr.io/csakaszamok/p9m-claude-code-minimal:latest
FROM node:22-trixie-slim AS node

FROM ${BASE}
ARG ECC_REF=v2.2.3
ARG ECC_COMMIT=c05b2d6614
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && git clone -q --depth 1 --branch "$ECC_REF" https://github.com/affaan-m/ECC /opt/ecc \
 && [ "$(git -C /opt/ecc rev-parse HEAD | cut -c1-${#ECC_COMMIT})" = "$ECC_COMMIT" ] \
 && rm -rf /opt/ecc/.git
USER agent
RUN claude plugin marketplace add /opt/ecc \
 && claude plugin install ecc@ecc \
 && rm -rf /home/agent/.cache
