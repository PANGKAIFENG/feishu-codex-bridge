#!/bin/zsh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/PANGKAIFENG/feishu-codex-bridge.git}"
SKILL_NAME="feishu-codex-bridge"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TARGET_ROOT="${TARGET_ROOT:-$CODEX_HOME_DIR/skills}"
TARGET_DIR="$TARGET_ROOT/$SKILL_NAME"
MODE="${MODE:-copy}"
FORCE="${FORCE:-false}"
TMP_DIR=""

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Install $SKILL_NAME into $TARGET_DIR

Usage:
  ./scripts/install-skill.sh [--copy|--symlink] [--force]

Environment:
  REPO_URL    Override the source repository
  TARGET_ROOT Override the skill install root
  CODEX_HOME  Override Codex home
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy)
      MODE="copy"
      shift
      ;;
    --symlink)
      MODE="symlink"
      shift
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$TARGET_ROOT"

SOURCE_DIR=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$REPO_ROOT/SKILL.md" ]]; then
  SOURCE_DIR="$REPO_ROOT"
fi

if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required for remote installation." >&2
    exit 1
  fi
  TMP_DIR="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$TMP_DIR/$SKILL_NAME" >/dev/null
  SOURCE_DIR="$TMP_DIR/$SKILL_NAME"
  if [[ "$MODE" == "symlink" ]]; then
    MODE="copy"
  fi
fi

if [[ -e "$TARGET_DIR" || -L "$TARGET_DIR" ]]; then
  if [[ -L "$TARGET_DIR" ]]; then
    CURRENT_TARGET="$(readlink "$TARGET_DIR")"
    if [[ "$CURRENT_TARGET" == "$SOURCE_DIR" ]]; then
      echo "Skill already installed at $TARGET_DIR"
      exit 0
    fi
  fi

  if [[ "$FORCE" != "true" ]]; then
    echo "Target already exists: $TARGET_DIR" >&2
    echo "Re-run with --force to replace it." >&2
    exit 1
  fi

  rm -rf "$TARGET_DIR"
fi

if [[ "$MODE" == "symlink" ]]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
  rm -rf "$TARGET_DIR/.git"
fi

echo "Installed $SKILL_NAME to $TARGET_DIR"
echo "Next steps:"
echo "  1. Run codex and mention \$feishu-codex-bridge when you want to use the skill."
echo "  2. If deploying the bridge, run 'cd $TARGET_DIR && npm install'"
echo "  3. Then read $TARGET_DIR/README.md"
