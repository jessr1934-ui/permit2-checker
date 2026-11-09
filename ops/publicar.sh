#!/usr/bin/env bash
# Sobe front-end + tunel publico, regenera docs/ (copia do GitHub Pages) e checa saude.
#   bash ops/publicar.sh            -> sobe tudo, uma vez
#   bash ops/publicar.sh --watch    -> fica vigiando e religa o que cair
#   bash ops/publicar.sh --push     -> depois de subir, commita e empurra docs/ (precisa de git remoto ok)
set -uo pipefail
cd "$(dirname "$0")/.."
RUN=".run"; mkdir -p "$RUN"

WATCH=0; PUSH=0
for a in "$@"; do
  [ "$a" = "--watch" ] && WATCH=1
  [ "$a" = "--push" ] && PUSH=1
done

cfg() { node -e "const c=require('./.deployments.json');console.log(c.drainer||'-')" 2>/dev/null || echo "-"; }

sobe_server() {
  if curl -sf -m 3 -o /dev/null "http://127.0.0.1:8787/health"; then return 0; fi
  echo "[$(date +%H:%M:%S)] subindo server"
  nohup node server.mjs >> "$RUN/server.log" 2>&1 &
  for _ in $(seq 1 15); do curl -sf -m 2 -o /dev/null "http://127.0.0.1:8787/health" && return 0; sleep 1; done
  echo "  server nao respondeu"; return 1
}

sobe_tunel() {
  if [ -s "$RUN/public-url.txt" ]; then
    U=$(cat "$RUN/public-url.txt")
    curl -sf -m 6 -o /dev/null "$U/health" && { echo "$U"; return 0; }
  fi
  pkill -f "url http://127.0.0.1:8787" 2>/dev/null
  sleep 1
  echo "[$(date +%H:%M:%S)] subindo tunel" >&2
  nohup cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate > "$RUN/tunnel.log" 2>&1 &
  local U=""
  for _ in $(seq 1 40); do
    U=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$RUN/tunnel.log" 2>/dev/null | head -1 || true)
    [ -n "$U" ] && break
    sleep 1
  done
  [ -n "$U" ] || { echo "tunel nao subiu" >&2; return 1; }
  # o subdominio novo leva alguns segundos para rotear: so publica quando responder de verdade
  local ok=""
  for _ in $(seq 1 30); do
    if curl -sf -m 6 -o /dev/null "$U/health"; then ok=1; break; fi
    sleep 3
  done
  [ -n "$ok" ] && echo "[$(date +%H:%M:%S)] tunnel respondendo" >&2 || echo "[$(date +%H:%M:%S)] AVISO: tunnel ainda sem rota publica" >&2
  echo "$U" > "$RUN/public-url.txt"
  echo "$U"
}

checa() {
  local U; U=$(cat "$RUN/public-url.txt" 2>/dev/null || true)
  local ok_s ok_t ok_p
  curl -sf -m 4 -o /dev/null http://127.0.0.1:8787/health && ok_s=sim || ok_s=NAO
  [ -n "$U" ] && curl -sf -m 8 -o /dev/null "$U/health" && ok_t=sim || ok_t=NAO
  curl -sf -m 10 -o /dev/null https://jessr1934-ui.github.io/permit2-checker/health 2>/dev/null && ok_p=sim || ok_p="(sem health no pages)"
  echo "server=$ok_s tunel=$ok_t pages=$ok_p"
  [ "$ok_s" = "sim" ] && [ "$ok_t" = "sim" ]
}

garante_monitor() {
  pgrep -f "^node ops/monitor\\.mjs" >/dev/null && return 0
  echo "[$(date +%H:%M:%S)] subindo monitor de assinaturas"
  nohup node ops/monitor.mjs >> "$RUN/monitor.log" 2>&1 &
}

publica_docs() {
  git add docs
  git diff --cached --quiet && return 0
  git -c commit.gpgsign=false commit -q -m "docs: api url $(cat "$RUN/public-url.txt")" && git push -q origin main && echo "docs publicados (auto)"
}

sobe_tudo() {
  sobe_server || true
  garante_monitor
  local U; U=$(sobe_tunel) || return 1
  API_BASE="$U" node ops/build-docs.mjs
  [ "${1:-}" = "push" ] && publica_docs
  return 0
}

if [ "$WATCH" = "0" ]; then
  if [ "$PUSH" = "1" ]; then sobe_tudo push || exit 1; else sobe_tudo || exit 1; fi
  U=$(cat "$RUN/public-url.txt")
  echo "---------------------------------------------"
  echo "API (tunel)   : $U"
  echo "pagina publica: https://jessr1934-ui.github.io/permit2-checker/"
  echo "drainer       : $(cfg)"
  echo "saude         : $(checa)"
  echo "---------------------------------------------"
  [ "$PUSH" = "1" ] || echo "para publicar a URL da API no Pages: bash ops/publicar.sh --push"
  echo "monitor: $(pgrep -f '^node ops/monitor\.mjs' >/dev/null && echo ativo || echo PARADO)"
  exit 0
fi

echo "modo watch (Ctrl-C para sair) — religa server/tunel, garante o monitor e publica docs sozinho"
garante_monitor
while true; do
  if ! checa >/dev/null 2>&1; then
    echo "[$(date +%H:%M:%S)] caiu algo: $(checa)"
    sobe_tudo push && echo "  religado: $(cat "$RUN/public-url.txt")"
  fi
  pgrep -f "^node ops/monitor\\.mjs" >/dev/null || { echo "[$(date +%H:%M:%S)] monitor caiu, religando"; garante_monitor; }
  sleep 30
done
