# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

# invoicegen: raise invoices from inside the pod.
#
# Built from valkyriweb/invoicegen, a fork of upstream github.com/raine/invoicegen
# pinned at v0.1.2. Upstream cannot render our invoices: it supports EUR/USD/GBP/JPY
# only (no ZAR) and hardcodes `paper: "us-letter"` in its embedded Typst template,
# neither of which is reachable from config. The fork adds ZAR and switches the
# template to A4; it carries no other divergence.
#
# Only a linux-amd64 asset is published, matching upstream and matching the pod.
# The paperclip pod runs linux/amd64 today, so we install the real binary there and,
# on arm64, install a stub that fails loudly instead of silently shipping a broken
# (or wrong-arch) binary. Revisit if the pod ever moves to arm64.
FROM base AS invoicegen
ARG TARGETARCH
ARG INVOICEGEN_REPO=valkyriweb/invoicegen
ARG INVOICEGEN_VERSION=v0.1.2-bermont.1
ARG INVOICEGEN_LINUX_AMD64_SHA256=2e5d32a4efcc8f2c0ffc48e07528fbf155e1a997a3955cd40076c57046685f36
WORKDIR /tmp/invoicegen
RUN set -eu; \
  if [ "$TARGETARCH" = "amd64" ]; then \
    curl -fsSL -o invoicegen.tar.gz "https://github.com/${INVOICEGEN_REPO}/releases/download/${INVOICEGEN_VERSION}/invoicegen-linux-amd64.tar.gz"; \
    echo "${INVOICEGEN_LINUX_AMD64_SHA256}  invoicegen.tar.gz" | sha256sum -c -; \
    tar -xzf invoicegen.tar.gz -C /usr/local/bin invoicegen; \
    chmod +x /usr/local/bin/invoicegen; \
  else \
    printf '#!/bin/sh\necho "invoicegen: no linux-%s release available (only linux-amd64 is published); this image was built for %s" >&2\nexit 127\n' "$TARGETARCH" "$TARGETARCH" > /usr/local/bin/invoicegen; \
    chmod +x /usr/local/bin/invoicegen; \
  fi

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
COPY --from=invoicegen /usr/local/bin/invoicegen /usr/local/bin/invoicegen
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && mkdir -p /opt/otel/preload \
  && npm install --prefix /opt/otel --omit=dev \
    @opentelemetry/api@^1.9.1 \
    @opentelemetry/auto-instrumentations-node@^0.75.0 \
    @traceloop/node-server-sdk@^0.26.0 \
  && chown -R node:node /opt/otel

COPY docker/otel/traceloop-init.js /opt/otel/preload/traceloop-init.js

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq gnupg \
  && curl -sS https://downloads.1password.com/linux/keys/1password.asc \
    | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
    > /etc/apt/sources.list.d/1password.list \
  && mkdir -p /etc/debsig/policies/AC2D62742012EA22/ \
  && curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol \
    > /etc/debsig/policies/AC2D62742012EA22/1password.pol \
  && mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 \
  && curl -sS https://downloads.1password.com/linux/keys/1password.asc \
    | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
  && apt-get update \
  && apt-get install -y --no-install-recommends 1password-cli \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

COPY scripts/docker-entrypoint.sh /usr/local/bin/
COPY scripts/invoicegen-config-bootstrap.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/invoicegen-config-bootstrap.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false \
  NODE_PATH=/opt/otel/node_modules

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
