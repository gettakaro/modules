#!/usr/bin/env bash
# Compute port env vars from INSTANCE_ID.
# Usage:
#   INSTANCE_ID=2 source dev/minecraft/instance-env.sh   # export into current shell
#   dev/minecraft/instance-env.sh 3                       # print .env lines to stdout

set -euo pipefail

ID="${1:-${INSTANCE_ID:-0}}"

if ! [[ "$ID" =~ ^[0-9]$ ]]; then
  echo "Error: INSTANCE_ID must be 0-9, got '$ID'" >&2
  exit 1
fi

MC_PORT=$((25665 + ID))
RCON_PORT=$((25675 + ID))
BOT_PORT=$((3101 + ID))

# If sourced, export the vars. If executed, print .env lines.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  export INSTANCE_ID="$ID"
  export MC_PORT RCON_PORT BOT_PORT
  echo "Instance $ID: MC=$MC_PORT RCON=$RCON_PORT Bot=$BOT_PORT"
else
  cat <<EOF
INSTANCE_ID=$ID
MC_PORT=$MC_PORT
RCON_PORT=$RCON_PORT
BOT_PORT=$BOT_PORT
EOF
fi
