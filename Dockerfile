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
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
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
RUN test -f cli/src/index.ts || (echo "ERROR: cli source missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
ARG SURF_CLI_VERSION=2.7.2
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai surf-cli@${SURF_CLI_VERSION} \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq unzip ca-certificates python3-venv \
  && python3 -m venv /opt/google-ads-python \
  && /opt/google-ads-python/bin/pip install --no-cache-dir google-ads \
  && /opt/google-ads-python/bin/python -c "from google.ads.googleads.client import GoogleAdsClient" \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown -R node:node /paperclip /opt/google-ads-python

ARG OTEL_AUTO_VERSION=0.75.0
ARG OTEL_API_VERSION=1.9.1
ARG TRACELOOP_SDK_VERSION=0.26.0
ARG OP_VERSION=2.30.3
ARG PINCHTAB_VERSION=0.8.6

RUN mkdir -p /opt/otel \
  && cd /opt/otel \
  && npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund --loglevel=error \
    @opentelemetry/api@${OTEL_API_VERSION} \
    @opentelemetry/auto-instrumentations-node@${OTEL_AUTO_VERSION} \
    @traceloop/node-server-sdk@${TRACELOOP_SDK_VERSION} \
  && chown -R node:node /opt/otel \
  && rm -rf /root/.npm

COPY docker/traceloop-init.js /opt/otel/preload/traceloop-init.js
COPY docker/agent-skills/browser-toolkit/ /opt/agent-skills/canonical/browser-toolkit/
COPY docker/agent-skills/sbsa-online-banking/ /opt/agent-skills/canonical/sbsa-online-banking/
RUN chown -R node:node /opt/otel/preload /opt/agent-skills

RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${ARCH}_v${OP_VERSION}.zip" -o /tmp/op.zip \
  && unzip /tmp/op.zip -d /usr/local/bin \
  && rm /tmp/op.zip \
  && chmod +x /usr/local/bin/op

RUN HOME=/opt/pinchtab-home npm install -g pinchtab@${PINCHTAB_VERSION} --loglevel=error \
  && BIN=$(find /opt/pinchtab-home -name 'pinchtab-linux-amd64' -print -quit) \
  && [ -n "$BIN" ] || (echo "pinchtab postinstall did not write a binary" >&2; exit 1) \
  && mkdir -p /usr/local/share/pinchtab \
  && cp "$BIN" /usr/local/share/pinchtab/pinchtab-linux-amd64 \
  && chmod +x /usr/local/share/pinchtab/pinchtab-linux-amd64 \
  && rm -rf /opt/pinchtab-home /paperclip/.npm /root/.npm

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && printf '#!/bin/sh\nexec node --import /app/server/node_modules/tsx/dist/loader.mjs /app/cli/src/index.ts "$@"\n' > /usr/local/bin/paperclipai \
  && chmod +x /usr/local/bin/paperclipai

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
  PATH=/opt/google-ads-python/bin:$PATH \
  NODE_PATH=/opt/otel/node_modules \
  NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register --require /opt/otel/preload/traceloop-init.js" \
  OTEL_NODE_RESOURCE_DETECTORS=env,host,os,container \
  OTEL_TRACES_SAMPLER=parentbased_traceidratio \
  OTEL_TRACES_SAMPLER_ARG=1.0 \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental \
  PINCHTAB_BINARY_PATH=/usr/local/share/pinchtab/pinchtab-linux-amd64

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
