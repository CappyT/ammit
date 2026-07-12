# Build context is the REPO ROOT (not deploy/):
#   docker build -f deploy/Dockerfile -t ammit-report-api:local .
#
# Zero-dependency service: single file using the built-in node:sqlite module
# (stable since Node 22). No npm install. Target node:26-alpine.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy only what the service needs, preserving the relative paths the runtime
# defaults expect: SEED_PATH=extension/data/blocklist.json and
# HEURISTICS_PATH=extension/src/heuristics.js (both resolved from /app).
COPY server/ ./server/
COPY extension/src/heuristics.js ./extension/src/heuristics.js
COPY extension/data/blocklist.json ./extension/data/blocklist.json

# DB lives on a writable volume (PVC in k8s). Create + own it for the non-root
# `node` user (uid 1000). The k8s volume mount overlays this at runtime.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
ENV PORT=8080 \
    DB_PATH=/data/ammit.db
EXPOSE 8080

# Optional (k8s uses its own probes against /healthz).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
