#!/usr/bin/env bash
# Sobe front-end + tunel publico e regenera docs/ (copia do GitHub Pages) com a URL atual do tunel.
set -euo pipefail
cd "$(dirname "$0")/.."

pkill -f "url http://127.0.0.1:8787" 2>/dev/null || true
PID=$(ss -ltn 2>/dev/null | grep -q ':8787' && pgrep -f "node server.mjs" | head -1 || true)
[ -n "${PID:-}" ] || (nohup node server.mjs > /tmp/opencode/server-pub.log 2>&1 &)
sleep 2

nohup cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate > /tmp/opencode/tunnel.log 2>&1 &
U=""
for _ in $(seq 1 40); do
  U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/opencode/tunnel.log 2>/dev/null | head -1 || true)
  [ -n "$U" ] && break
  sleep 1
done
[ -n "$U" ] || { echo "tunel nao subiu"; exit 1; }

echo "API (tunel)   : $U"
API_BASE="$U" node ops/build-docs.mjs
echo "pagina publica: https://jessr1934-ui.github.io/permit2-checker/"
echo "para publicar a nova URL da API: git add docs && git commit -m 'api url' && git push"
