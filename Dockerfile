# n8n 2.46.6 with the stock-market workflows (US stock picks, NGX/BRVM/BVMAC brief, Dangote watch, Telegram assistant).
# Same base image as the official one (n8nio/n8n: Alpine, Node 26, user "node", data in /home/node/.n8n).
#   docker build -t stock-market-n8n .
# Railway, Render or any Docker host can build this file directly. n8n itself cannot run on Vercel.
FROM n8nio/n8n:2.46.6

# The official image has no package manager and runs as "node": only copy files, no RUN step needed.
COPY --chown=node:node workflows /opt/stock-market/workflows
COPY --chown=node:node tools/first-run-setup.mjs tools/check-sources.mjs /opt/stock-market/tools/
COPY --chown=node:node docker/entrypoint.sh /opt/stock-market/entrypoint.sh

ENV SM_WORKFLOWS_DIR=/opt/stock-market/workflows \
    GENERIC_TIMEZONE=Africa/Lagos \
    TZ=Africa/Lagos \
    N8N_DIAGNOSTICS_ENABLED=false \
    EXECUTIONS_DATA_PRUNE=true \
    EXECUTIONS_DATA_MAX_AGE=336

EXPOSE 5678
# Runs the setup (credentials from env, import, publish), then hands over to n8n's own entrypoint.
ENTRYPOINT ["tini", "--", "/bin/sh", "/opt/stock-market/entrypoint.sh"]
