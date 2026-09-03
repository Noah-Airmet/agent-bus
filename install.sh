#!/bin/sh
# agent-bus installer. Idempotent — safe to re-run.
# Usage:  ./install.sh            (set up bus dirs, link commands, detect workers)
#         ./install.sh --smoke-test   (also run one tiny task end-to-end)
set -eu

BUS_DIR="$HOME/.agent-bus"
BIN_DIR="$HOME/.local/bin"
REPO_BIN="$(cd "$(dirname "$0")/bin" && pwd)"

mkdir -p "$BUS_DIR"/inbox "$BUS_DIR"/running "$BUS_DIR"/done \
         "$BUS_DIR"/failed "$BUS_DIR"/logs "$BUS_DIR"/worktrees
mkdir -p "$BIN_DIR"

for f in "$REPO_BIN"/*; do
  name="$(basename "$f")"
  chmod +x "$f"
  ln -sf "$f" "$BIN_DIR/$name"
done

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "NOTE: $BIN_DIR is not on your PATH."
     echo "Add this line to ~/.zshrc (or ~/.bashrc), then restart your terminal:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"";;
esac

# Detect installed worker CLIs and record them. Never overwrites an
# existing config — delete ~/.agent-bus/config.json to re-detect.
if [ ! -f "$BUS_DIR/config.json" ]; then
  detected=""
  for cli in cursor-agent agy codex claude grok copilot opencode; do
    if command -v "$cli" >/dev/null 2>&1; then
      detected="$detected $cli"
    fi
  done
  # shellcheck disable=SC2086
  printf '{\n  "detected_clis": "%s",\n  "default_models": {},\n  "disabled": []\n}\n' \
    "$(echo $detected | tr ' ' ',')" > "$BUS_DIR/config.json"
  echo "Wrote $BUS_DIR/config.json"
fi

echo ""
echo "Worker status:"
"$BIN_DIR/agent-dispatch" workers
echo ""
echo "Bus ready. Queues live in $BUS_DIR"

if [ "${1:-}" = "--smoke-test" ]; then
  echo ""
  echo "Running smoke test (one tiny task, first available worker)..."
  "$BIN_DIR/agent-dispatch" submit --to auto --mode read-only \
    --id smoke-test --cwd "$HOME" \
    "Reply with exactly this word and nothing else: hello" --run
  echo ""
  echo "--- result file ---"
  cat "$BUS_DIR"/done/smoke-test.md
  echo "--- end ---"
fi
