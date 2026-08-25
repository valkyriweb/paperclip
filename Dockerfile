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
# neither of which is reachable from config. The fork adds ZAR, switches the
# template to A4, supports invoice-number prefixes, and makes `draft: true`
# visibly render `DRAFT — NOT ISSUED` on every page.
#
# Only a linux-amd64 asset is published, matching upstream and matching the pod.
# The paperclip pod runs linux/amd64 today, so we install the real binary there and,
# on arm64, install a stub that fails loudly instead of silently shipping a broken
# (or wrong-arch) binary. Revisit if the pod ever moves to arm64.
FROM base AS invoicegen
ARG TARGETARCH
ARG INVOICEGEN_REPO=valkyriweb/invoicegen
ARG INVOICEGEN_VERSION=v0.1.2-bermont.3
ARG INVOICEGEN_LINUX_AMD64_SHA256=dd18719fc46c0bf26c0934445187942c591ceda5d714a020dc0effbbaeda0bee
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
COPY packages/google-sheets-mcp-server/package.json packages/google-sheets-mcp-server/
COPY packages/kv-demo-mcp-server/package.json packages/kv-demo-mcp-server/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
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
# Real version for this build, computed from `git describe` on the CI runner
# (the image has no .git, so the server cannot derive it at runtime). Empty for
# local `docker build`, which just leaves the server on its normal fallbacks.
ARG PAPERCLIP_BUILD_VERSION=""
# The exact commit this image was built from, for the same reason: server-info
# falls back to PAPERCLIP_BUILD_COMMIT when git is unavailable, which feeds the
# /api/health `commit` field that deploy tooling verifies. Empty locally.
ARG PAPERCLIP_BUILD_COMMIT=""
# Refreshes the tool layer below when it changes (CI stamps an ISO week, so
# the @latest CLI tools advance weekly). Without it the cached layer would
# freeze the tools until an unrelated cache bust.
ARG CLI_TOOLS_CACHE_EPOCH=""
WORKDIR /app
# Tool and OS layer BEFORE the app copy: it references nothing from /app, and
# the app copy changes on every commit — ordered the other way around, this
# (the single most expensive layer: four CLI toolchains + apt, per arch) can
# never hit the layer cache and rebuilds on every build.
RUN echo "cli-tools-epoch: ${CLI_TOOLS_CACHE_EPOCH}" \
  && npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && mkdir -p /opt/otel/preload \
  && npm install --prefix /opt/otel --omit=dev \
    @opentelemetry/api@^1.9.1 \
    @opentelemetry/sdk-node@latest \
    @opentelemetry/auto-instrumentations-node@^0.75.0 \
    @traceloop/node-server-sdk@^0.26.0 \
  && chown -R node:node /opt/otel

COPY docker/otel/traceloop-init.js /opt/otel/preload/traceloop-init.js
COPY --from=invoicegen /usr/local/bin/invoicegen /usr/local/bin/invoicegen

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

COPY --chown=node:node --from=build /app /app

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_BUILD_VERSION=${PAPERCLIP_BUILD_VERSION} \
  PAPERCLIP_BUILD_COMMIT=${PAPERCLIP_BUILD_COMMIT} \
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

# Cloud image variant (build with `--target cloud`): the production image
# plus built bundled sandbox-provider plugins. Managed instances receive a
# `plugins.autoInstall` key list through PAPERCLIP_MANAGED_CONFIG and
# install those plugins from the bundled catalog at boot
# (server/src/services/bundled-plugins.ts), which requires each plugin's
# dist/ to exist in the image — the default image ships only their source,
# so auto-install logs "bundle not present" and skips. The plugins are
# built in this separate target so the default (self-hosted) image stays
# lean; CI pins the default build to `--target production`, which is
# byte-identical to before this stage existed.
#
# The sandbox providers are intentionally excluded from the pnpm workspace
# (see pnpm-workspace.yaml), so each installs standalone exactly as its
# README prescribes. Installing in a `build`-based stage (not `production`)
# keeps devDependencies available for tsc: `production` sets
# NODE_ENV=production, which would make pnpm skip them.
#
# CLOUD_BUNDLED_PLUGINS is the space-separated list of sandbox-provider
# directory names to build into the variant. Only what managed deployments
# actually auto-install belongs here — every entry adds its node_modules
# to the image. Growing the list is a one-line workflow change.
FROM build AS cloud-plugins
ARG CLOUD_BUNDLED_PLUGINS="daytona"
RUN set -eu; \
  for name in $CLOUD_BUNDLED_PLUGINS; do \
    dir="packages/plugins/sandbox-providers/$name"; \
    test -d "$dir" || { echo "ERROR: unknown sandbox provider '$name'" >&2; exit 1; }; \
    pnpm -C "$dir" install --ignore-workspace --no-lockfile; \
    pnpm -C "$dir" build; \
    test -f "$dir/dist/manifest.js" || { echo "ERROR: $dir is missing dist/manifest.js after build" >&2; exit 1; }; \
  done

FROM production AS cloud
COPY --chown=node:node --from=cloud-plugins /app/packages/plugins/sandbox-providers /app/packages/plugins/sandbox-providers
