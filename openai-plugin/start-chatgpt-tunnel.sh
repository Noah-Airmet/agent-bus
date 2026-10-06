#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Credentials: a private .env beside this script, else the 1Password Agents
# item `agent-bus-openai-plugin` (the Mini; nothing on disk).
if [ -f "$PLUGIN_DIR/.env" ]; then
  set -a
  . "$PLUGIN_DIR/.env"
  set +a
elif command -v op-env >/dev/null 2>&1; then
  eval "$(op-env agent-bus-openai-plugin)"
else
  echo "Missing runtime credential: $PLUGIN_DIR/.env or op-env" >&2
  exit 1
fi
export CONTROL_PLANE_API_KEY="$OPENAI_API_KEY"
: "${CONTROL_PLANE_ORGANIZATION_ID:?Set CONTROL_PLANE_ORGANIZATION_ID in .env}"
: "${AGENT_BUS_TUNNEL_ID:?Set AGENT_BUS_TUNNEL_ID in .env}"
TUNNEL_BIN=${TUNNEL_CLIENT_BIN:-"$PLUGIN_DIR/.runtime/tunnel-client-v0.0.15/tunnel-client"}
exec "$TUNNEL_BIN" runtimes connect --alias agent-bus --profile agent-bus \
  --tunnel-id "$AGENT_BUS_TUNNEL_ID" \
  --organization-id "$CONTROL_PLANE_ORGANIZATION_ID" \
  --mcp-command "$HOME/.local/bin/agent-bus-mcp" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY --json
