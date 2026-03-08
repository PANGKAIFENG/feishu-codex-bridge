#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ENV="$HOME/.config/feishu-codex-bridge/.env"
ENV_FILE="${FEISHU_CODEX_BRIDGE_ENV:-$DEFAULT_ENV}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Copy assets/feishu-codex-bridge.env.example to that path or set FEISHU_CODEX_BRIDGE_ENV." >&2
  exit 1
fi

export FEISHU_CODEX_BRIDGE_ENV="$ENV_FILE"
exec node "$SCRIPT_DIR/bridge-server.mjs"
