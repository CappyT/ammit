# ammit-report-api — deploy

Report-ingestion API for the crowdsourced AI-artist blocklist. Single-file
zero-dependency Node service (`server/server.mjs`) using the built-in
`node:sqlite` module (needs Node >= 22, image targets `node:26-alpine`). It
seeds from and re-reads two repo files at runtime: `extension/src/heuristics.js`
and `extension/data/blocklist.json`.

Endpoints: `POST /v1/reports` (ingest), `GET /v1/blocklist.json` (promoted
list), `GET /healthz` (`200 ok`), `GET /metrics` (Prometheus text),
`/admin/*` (bearer `ADMIN_TOKEN`).

Ingress is exclusively via **Cloudflare Tunnel** (cloudflared) — there are no
Ingress or LoadBalancer objects.

## Build locally

Build context is the repo root; the Dockerfile is `deploy/Dockerfile`:

```bash
docker build -f deploy/Dockerfile -t ammit-report-api:local .
docker run --rm -p 8080:8080 -v ammit-data:/data \
  -e ADMIN_TOKEN=dev -e HMAC_SALT=dev ammit-report-api:local
curl -fsS localhost:8080/healthz   # -> ok
```

CI builds and pushes the same image to `ghcr.io/cappyt/ammit` on version tags
(`v*`) — see `.github/workflows/ci.yml` at the repo root. The same workflow
packages the extension zip and attaches it to the GitHub release.

## Deploy to k8s

Plain kustomize base in `k8s/`:

```bash
kubectl apply -k deploy/k8s
```

Placeholders to change before applying (grep for `CHANGE ME`):

- `deployment.yaml`: image tag (`ghcr.io/cappyt/ammit`), pin a version.
- `pvc.yaml`: `storageClassName` (or leave commented for the cluster default).
- `externalsecret.yaml` / `cloudflared.yaml`: `secretStoreRef.name` and the
  Infisical `remoteRef.key`s.
- `configmap.yaml`: the `GIT_*` publishing target (or delete that block).

Secrets come from **External Secrets Operator** (Infisical backend):
`ADMIN_TOKEN`, `HMAC_SALT`, `GIT_TOKEN` land in the `ammit-report-api` Secret;
`TUNNEL_TOKEN` in `cloudflared-tunnel`. If you disable git publishing, remove
`GIT_TOKEN` from both the ExternalSecret and the Deployment env (otherwise the
key must still exist in the store).

The `ServiceMonitor` carries **no `release:` label** — this Prometheus selects
all ServiceMonitors. The pod runs non-root with a read-only root filesystem;
only `/data` (PVC) and `/tmp` (emptyDir) are writable.

## Environment variables

Secrets (`ExternalSecret`): **ADMIN_TOKEN**, **HMAC_SALT**, **GIT_TOKEN**.
Everything else is plain env in the ConfigMap.

| Var | Default | Secret | Purpose |
|-----|---------|:---:|---------|
| `PORT` | `8080` | | Listen port |
| `DB_PATH` | `/data/ammit.db` | | SQLite DB file (on the PVC) |
| `ADMIN_TOKEN` | — | yes | Bearer token for `/admin/*` |
| `HMAC_SALT` | — | yes | Salt for IP-bucket hashing |
| `CAP_INSTALL_DAY` | `30` | | Max reports per install per day |
| `CAP_IP_DAY` | `60` | | Max reports per IP bucket per day |
| `MIN_INSTALLS` | `3` | | Distinct installs to promote an entry |
| `MIN_IP_BUCKETS` | `3` | | Distinct IP buckets to promote |
| `MIN_AGE_HOURS` | `48` | | Min age before an entry can promote |
| `NOT_AI_RATIO` | `0.34` | | Max "not-AI" dispute ratio tolerated |
| `AGGREGATE_INTERVAL_MIN` | `60` | | Aggregation/promotion cadence (min) |
| `SEED_PATH` | `extension/data/blocklist.json` | | Seed list inside the image |
| `HEURISTICS_PATH` | `extension/src/heuristics.js` | | Heuristics module inside the image |
| `IP_HEADER` | `cf-connecting-ip` | | Header holding the real client IP |
| `GIT_API_BASE` | — | | Gitea/GitHub API base for publishing |
| `GIT_REPO` | — | | `owner/name` of the publish repo |
| `GIT_BRANCH` | `main` | | Branch to publish to |
| `GIT_FILEPATH` | `blocklist.json` | | Path of the published file |
| `GIT_TOKEN` | — | yes | Token for git publishing |

## Cloudflare (free tier) setup

1. **Tunnel.** Zero Trust → Networks → Tunnels → create a tunnel. Put its
   token in Infisical as `CLOUDFLARED_TUNNEL_TOKEN` (consumed by the
   `cloudflared` Deployment, 2 replicas). Add a **Public Hostname**:
   `ammit.example.com` → `http://ammit-report-api.ammit.svc.cluster.local:8080`.
   This also creates the DNS route (proxied CNAME) automatically.
2. **Bot Fight Mode.** Security → Bots → enable **Bot Fight Mode** (free).
3. **Rate limiting.** Security → create the one free rate-limiting rule:
   match `http.request.method eq "POST" and http.request.uri.path eq
   "/v1/reports"`, **10 req/min per IP**, action Block. This is the write path
   that needs protection.
4. **Cache rule.** Caching → Cache Rules: for `GET` on
   `/v1/blocklist.json` (or the raw git URL below), set **Eligible for cache**
   with **Edge TTL = 1h**. The read path is static and cacheable.
5. **Turnstile is intentionally absent.** Turnstile cannot be solved from
   `chrome-extension://` origins, so the extension can't attach a token — the
   rate-limit rule + Bot Fight Mode carry the write-path protection instead.

## Reads: prefer the published git raw URL

`GET /v1/blocklist.json` exists, but clients should preferably fetch the
**published git raw URL** (the file written by the `GIT_*` publishing flow,
e.g. `https://gitea.example.com/user/ammit-blocklist/raw/branch/main/blocklist.json`),
optionally fronted by the Cloudflare cache rule. That keeps the read load off
the API pod and off the SQLite DB entirely.
