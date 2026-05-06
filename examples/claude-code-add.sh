#!/usr/bin/env bash
# Add synology-office-mcp to Claude Code as an MCP server.
# Usage: bash examples/claude-code-add.sh
#
# Prerequisites:
#   - Claude Code CLI installed (claude)
#   - Server built: pnpm build (or npm install -g synology-office-mcp)
#   - Env vars set below (or export them before running this script)

set -euo pipefail

: "${SYNO_HOST:?Set SYNO_HOST to your NAS IP or hostname}"
: "${SYNO_USERNAME:?Set SYNO_USERNAME to your DSM username}"
: "${SYNO_PASSWORD:?Set SYNO_PASSWORD to your DSM password}"

# Path to the compiled entry point.
# If installed globally via npm/pnpm, use: $(which synology-mcp)
SERVER_PATH="${SERVER_PATH:-$(pwd)/dist/index.js}"

claude mcp add synology-office \
  --env "SYNO_HOST=${SYNO_HOST}" \
  --env "SYNO_PORT=${SYNO_PORT}" \
  --env "SYNO_HTTPS=${SYNO_HTTPS:-true}" \
  --env "SYNO_IGNORE_CERT=${SYNO_IGNORE_CERT:-false}" \
  --env "SYNO_USERNAME=${SYNO_USERNAME}" \
  --env "SYNO_PASSWORD=${SYNO_PASSWORD}" \
  --env "SYNO_SS_HOST=${SYNO_HOST}" \
  --env "SYNO_SS_PORT=${SYNO_SS_PORT}" \
  --env "SYNO_SS_HTTPS=${SYNO_SS_HTTPS:-false}" \
  --env "SYNO_SS_DSM_HOST=${SYNO_SS_DSM_HOST}" \
  --env "SYNO_SS_DSM_PORT=${SYNO_SS_DSM_PORT}" \
  --env "SYNO_SS_DSM_HTTPS=${SYNO_SS_DSM_HTTPS:-false}" \
  --env "LOG_LEVEL=${LOG_LEVEL:-info}" \
  -- node "${SERVER_PATH}"

echo "synology-office MCP server registered. Run 'claude mcp list' to verify."
