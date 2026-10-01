#!/bin/sh
set -eu
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
uv tool install --python 3.12 --editable "$package_dir"
echo 'Agent Bus MCP installed. Local transport: agent-bus-mcp'
echo 'Private HTTP transport: agent-bus-mcp --transport streamable-http'
