#!/usr/bin/env bash
set -euo pipefail

# Resolve paths relative to this script so it works from any directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Pre-flight check for gh CLI
if ! command -v gh &> /dev/null; then
  echo "Error: GitHub CLI (gh) is required but not installed."
  echo "Install it from https://cli.github.com/ or via your package manager."
  exit 1
fi

PLUGIN_DIR="${SCRIPT_DIR}/_data/paper/plugins"
PLUGIN_FILE="${PLUGIN_DIR}/TakaroMinecraft.jar"

if [ -f "$PLUGIN_FILE" ]; then
  echo "Plugin already exists at ${PLUGIN_FILE}, skipping download."
  exit 0
fi

mkdir -p "$PLUGIN_DIR"

echo "Downloading takaro-paper-0.0.5.jar..."
gh release download 0.0.5 \
  --repo gettakaro/takaro-minecraft \
  --pattern "takaro-paper-0.0.5.jar" \
  --output "$PLUGIN_FILE"

echo "Plugin downloaded to ${PLUGIN_FILE}"
