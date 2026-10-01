#!/bin/bash
# Connects Claude Code to your Gen Studio, so Claude can generate images, video and voiceovers for you.
# Usage: bash connect-claude-mcp.sh https://your-site.vercel.app
set -u

URL_BASE="${1:-}"
if [ -z "$URL_BASE" ]; then
  echo "Usage: bash connect-claude-mcp.sh https://your-site.vercel.app"
  exit 1
fi
URL="${URL_BASE%/}/api/mcp"
CONFIG="$(pwd)/.mcp.json"

printf 'Create an API key first: your site → Team & API → API keys.\n'
printf 'Paste it here (starts with mgs_), then press Return.\n'
printf 'It will not be shown as you type or paste: '
read -r -s KEY
printf '\n\n'

case "$KEY" in
  mgs_*) ;;
  "") echo "Nothing pasted. Run the script again."; exit 1 ;;
  *) echo "That doesn't look like a Gen Studio key (it should start with mgs_)."; exit 1 ;;
esac

echo "Checking the key against $URL …"
RESPONSE=$(curl -s -m 30 -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -H "Authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}')

case "$RESPONSE" in
  *serverInfo*) echo "Key works." ;;
  *) echo "The server didn't accept that key. Check the address and the key, then try again."; echo "Server said: ${RESPONSE:0:200}"; exit 1 ;;
esac

KEY="$KEY" URL="$URL" CONFIG="$CONFIG" node -e '
const fs = require("fs");
const path = process.env.CONFIG;
let config = { mcpServers: {} };
if (fs.existsSync(path)) {
  try { config = JSON.parse(fs.readFileSync(path, "utf8")); } catch { console.error("Existing .mcp.json is not valid JSON — move it aside and rerun."); process.exit(1); }
  config.mcpServers = config.mcpServers ?? {};
}
config.mcpServers["gen-studio"] = { type: "http", url: process.env.URL, headers: { Authorization: `Bearer ${process.env.KEY}` } };
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
' || exit 1

chmod 600 "$CONFIG"
echo
echo "Saved to $CONFIG (readable only by you)."
echo "Start a NEW Claude Code session in this folder and approve \"gen-studio\" when asked."
echo "Then try: \"use gen-studio to list the models\"."
