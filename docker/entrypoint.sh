#!/bin/sh
# Container start: run the stock-market setup, then start n8n exactly like the official image does.
# The setup never blocks n8n: if it fails (for example the database is not reachable yet), n8n still starts
# and the setup runs again on the next start. Set SM_SKIP_SETUP=true to skip it.

# Railway: once the service has a public domain (Settings → Networking → Generate Domain), Railway passes it in
# RAILWAY_PUBLIC_DOMAIN. n8n then uses https://<that domain>/ for its webhooks (the Telegram assistant needs https)
# and its editor, and trusts Railway's proxy (one hop). A value set by hand in the service variables always wins.
if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  if [ -z "${N8N_WEBHOOK_URL:-}${WEBHOOK_URL:-}" ]; then export N8N_WEBHOOK_URL="https://${RAILWAY_PUBLIC_DOMAIN}/"; fi
  if [ -z "${N8N_EDITOR_BASE_URL:-}" ]; then export N8N_EDITOR_BASE_URL="https://${RAILWAY_PUBLIC_DOMAIN}/"; fi
  if [ -z "${N8N_PROXY_HOPS:-}" ]; then export N8N_PROXY_HOPS=1; fi
  echo "[stock-market setup] Railway: webhooks at ${N8N_WEBHOOK_URL:-$WEBHOOK_URL}, editor at ${N8N_EDITOR_BASE_URL}, proxy hops ${N8N_PROXY_HOPS}"
fi

if [ "${SM_SKIP_SETUP:-false}" != "true" ]; then
  node /opt/stock-market/tools/first-run-setup.mjs || echo "[stock-market setup] failed, starting n8n anyway (it runs again on the next start)"
fi
exec /docker-entrypoint.sh "$@"
