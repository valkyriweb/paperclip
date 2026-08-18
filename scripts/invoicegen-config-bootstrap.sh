#!/bin/sh
# Hydrate invoicegen's config directory from 1Password at container start so
# agents can raise Bermont invoices from inside the pod.
#
# The sender block (registered name, VAT/tax numbers, banking details) and the
# logo are tenant data, not image data: baking them into a layer would publish
# them to anyone who pulls the public ghcr.io image. They are fetched at runtime
# instead, using the OP_SERVICE_ACCOUNT_TOKEN the pod already mounts.
#
# This is a no-op when that token is absent, so images built or run outside the
# Bermont pod (CI, local dev, other tenants) are unaffected.
set -eu

[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || exit 0
command -v op >/dev/null 2>&1 || exit 0

VAULT="${INVOICEGEN_OP_VAULT:-Bermont Digital}"
DEST="${INVOICEGEN_CONFIG_DIR:-/paperclip/.config/invoicegen}"
CONFIG_ITEM="${INVOICEGEN_OP_CONFIG_ITEM:-invoicegen config.yaml — Bermont Digital}"
LOGO_ITEM="${INVOICEGEN_OP_LOGO_ITEM:-invoicegen logo.svg — Bermont Digital}"

# A service account must always be told which vault to read from; unlike a user
# session, `op document get <item>` without --vault is rejected outright.
fetch() {
    op document get "$1" --vault "$VAULT" 2>/dev/null
}

tmp="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$tmp'" EXIT

if ! fetch "$CONFIG_ITEM" > "$tmp/config.yaml" || [ ! -s "$tmp/config.yaml" ]; then
    echo "invoicegen-config-bootstrap: no '$CONFIG_ITEM' readable in 1Password vault '$VAULT'; leaving invoicegen unconfigured" >&2
    exit 0
fi

if ! fetch "$LOGO_ITEM" > "$tmp/logo.svg" || [ ! -s "$tmp/logo.svg" ]; then
    rm -f "$tmp/logo.svg"
fi

# The stored config points at the logo via `~`, which resolves against HOME and
# would silently break for any process started with a different HOME. Pin it to
# the real path we just wrote instead.
if [ -f "$tmp/logo.svg" ]; then
    sed -i "s|^\([[:space:]]*logo:[[:space:]]*\).*$|\1$DEST/logo.svg|" "$tmp/config.yaml"
else
    sed -i "/^[[:space:]]*logo:[[:space:]]*/d" "$tmp/config.yaml"
fi

mkdir -p "$DEST"
cp "$tmp/config.yaml" "$DEST/config.yaml"
chmod 0600 "$DEST/config.yaml"
if [ -f "$tmp/logo.svg" ]; then
    cp "$tmp/logo.svg" "$DEST/logo.svg"
    chmod 0644 "$DEST/logo.svg"
fi

# Written as root before the entrypoint drops privileges, so hand it to the
# user that will actually run invoicegen.
if [ "$(id -u)" -eq 0 ]; then
    chown -R node:node "$DEST" 2>/dev/null || true
fi

echo "invoicegen-config-bootstrap: configured invoicegen from 1Password vault '$VAULT'"
