#!/bin/sh
# Container start: run the stock-market setup, then start n8n exactly like the official image does.
# The setup never blocks n8n: if it fails (for example the database is not reachable yet), n8n still starts
# and the setup runs again on the next start. Set SM_SKIP_SETUP=true to skip it.
if [ "${SM_SKIP_SETUP:-false}" != "true" ]; then
  node /opt/stock-market/tools/first-run-setup.mjs || echo "[stock-market setup] failed, starting n8n anyway (it runs again on the next start)"
fi
exec /docker-entrypoint.sh "$@"
