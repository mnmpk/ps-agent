# ps-agent

AI-assisted MongoDB deployment health check and monitoring agent.
See [DESIGN.md](./DESIGN.md) for the full architecture.

**Phase 1–7 — all phases complete:**

- *P1* — deterministic health-scan pipeline: connect via connection string,
  collect facts, run the rule engine, score, print findings.
- *P2* — a **LangGraph** health-scan graph (`collect_facts → run_rule_engine →
  correlate_and_rank`), a provider-agnostic LLM layer (Anthropic/OpenAI/Ollama),
  Zod structured-output narration grounded on the findings, and snapshot
  persistence.
- *P3* — HTTP API + **web dashboard**: a source registry (multiple
  deployments), fleet overview, cluster detail, and a cross-fleet risk inbox.
- *P4* — **Atlas collector**: pulls processes, metric measurements, open
  alerts, and Performance Advisor index suggestions via the Atlas Admin API
  (HTTP Digest auth), with Atlas-specific metric-trend checks.
- *P5* — **chat agent**: a LangGraph tool-calling agent over read-only tools
  (fleet, findings, metrics, scan-now, remediation drafts) with per-thread
  memory, SSE streaming, a dashboard chat drawer, and a CLI REPL.
- *P6* — **scheduler + live updates**: per-source auto-scan cadence (with
  jitter + overlap guard), per-source threshold overrides, a live SSE event
  stream (`scan.started/completed/failed`), and a live dashboard (auto-scan
  dropdown per card, pulsing status bar).
- *P7* — **MCP collector + hardening**: scan via a MongoDB MCP server
  (stdio/http); **credential encryption at rest** (AES-256-GCM); an append-only
  **audit log** of registrations, config changes, and scans.

## Security (P7)

- **Encryption at rest.** Connection strings and Atlas private keys are
  AES-256-GCM encrypted before being written to `sources.json` (envelope
  `enc:v1:…`). The key comes from `PS_AGENT_SECRET_KEY` (passphrase) or a
  generated `secret.key` file (0600) in the data dir. Legacy plaintext is read
  transparently and re-encrypted on next write.
- **Redaction.** Secrets are masked in every API response and never sent to the
  LLM or written to the audit log.
- **Audit log.** `~/.ps-agent/audit.log` (JSON Lines) records `source.register`,
  `source.remove`, `source.config`, and `scan.run`. Read via `GET /api/audit`.

## Capacity, growth & bottleneck analysis

For **Atlas** and **Ops Manager** sources (and direct/MCP sources that attach an
Atlas API key), ps-agent builds a **capacity report** from historical metrics +
the cluster spec, answering the three questions operators ask most:

- **Where's the bottleneck?** — ranked resource + slow-query signals (CPU, memory,
  disk, IOPS, plus per-namespace COLLSCANs / scanned-per-returned from the
  Performance Advisor).
- **How fast is data growing? When/how to scale?** — disk-growth regression →
  bytes/week, **days-until-full** + projected date (with R² confidence), and a
  scale recommendation (up / out / down + **factor** + target tier).
- **Current utilization? Cost optimization?** — per-resource current + p95 vs tier
  limits; flags underutilized clusters with a scale-down suggestion.

View it in the dashboard (cluster detail → **Capacity**), via
`GET /api/sources/:id/capacity`, or just ask the chatbot (e.g. "what's the
bottleneck of demo?", "when will I need to scale?", "is there room to scale down?").

To unlock trends/capacity on a **direct or MCP** source, tick
*"Add Atlas API key for trends & capacity"* in the Add-deployment form (or include
an `atlas` block alongside `connectionString`/`mcp` when registering via the API).

**Ops Manager (self-managed).** Register with the OM Public API — pick
*Ops Manager* in the form, or via API:

```bash
curl -X POST http://127.0.0.1:4000/api/sources -H 'Content-Type: application/json' \\
  -d '{"name":"on-prem","opsManager":{"baseUrl":"https://opsmgr.example.com:8080","projectId":"<GROUP_ID>","publicKey":"<PUB>","privateKey":"<PRIV>"}}'
```

OM sources get the same metrics/history/capacity/bottleneck analysis as Atlas.
Self-managed hosts have no cluster tier, so utilization is shown without
hardware limits (growth, days-until-full, and slow-query bottlenecks still work).

## MCP sources

Scan a deployment through a MongoDB **MCP server**. The collector always aims
for the **deepest check possible**:

- **With a connection string** (recommended): runs the full driver-based deep
  check (replication, serverStatus, tickets, cache, index usage) **and** enriches
  it with data-layer facts from the MCP server (`db-stats` → disk usage, storage,
  per-database roll-up). `collectionMethod = "mcp+direct"`.
- **Without a connection string**: MCP data-layer facts only (disk/storage via
  `db-stats` + `list-databases`). Node-level checks are unavailable and a warning
  explains why. `collectionMethod = "mcp"`.

```bash
# Deep check + MCP enrichment (preferred)
curl -X POST http://127.0.0.1:4000/api/sources -H 'Content-Type: application/json' \\
  -d '{
    "name": "prod-via-mcp",
    "connectionString": "mongodb+srv://user:pass@cluster.example.net/",
    "mcp": { "transport": "stdio", "command": "npx -y mongodb-mcp-server" }
  }'

# Data-layer only (no connection string)
curl -X POST http://127.0.0.1:4000/api/sources -H 'Content-Type: application/json' \\
  -d '{"name":"via-mcp","mcp":{"transport":"http","url":"http://localhost:3000/mcp"}}'
```

Requires `@modelcontextprotocol/sdk` (an optional dependency). The collector uses
the MongoDB MCP server's `connect` + `db-stats` + `list-databases` tools (it
passes a `connectionId`, as the server requires) and reads results from the
tool's `structuredContent`. Enrichment failures degrade to warnings, never a
failed scan.

> The stock `mongodb-mcp-server` exposes **data** tools (find, aggregate,
> db-stats, …) but no node-level admin command, which is why node-level checks
> need the connection string. That's the "mcp+direct" path.

## Scheduling & live updates

`ps-agent serve` starts an in-process scheduler. Give a deployment an auto-scan
cadence from the dashboard (the **Auto-scan** dropdown on each card) or via API:

```bash
# Scan every 5 minutes
curl -X PATCH http://127.0.0.1:4000/api/sources/<id>/config \\
  -H 'Content-Type: application/json' \\
  -d '{"schedule":{"intervalSeconds":300,"enabled":true}}'

# Per-source threshold overrides (merged onto defaults)
curl -X PATCH http://127.0.0.1:4000/api/sources/<id>/config \\
  -H 'Content-Type: application/json' \\
  -d '{"thresholdOverrides":{"replicationLagWarningSec":10}}'
```

Subscribe to live scan events (SSE):

```bash
curl -N http://127.0.0.1:4000/api/events
# → scan.started / scan.completed / scan.failed / schedule.changed
```

The scheduler is a lightweight in-process timer (jitter + overlap guard, no
Redis). It shares the `HealthService` interface, so a BullMQ/Redis backend can
replace it without changing callers.

## Chat

Ask questions about your fleet in natural language. Requires an LLM provider
(same config as `--summarize`).

```bash
# Terminal REPL
PS_AGENT_LLM_PROVIDER=ollama PS_AGENT_LLM_MODEL=gemma4:latest ps-agent chat

# Or use the 💬 drawer in the dashboard (ps-agent serve)
```

The agent has **read-only** tools: `list_fleet`, `query_findings`,
`get_latest_scan`, `get_metrics`, `run_scan_now`, and `suggest_remediation`
(advisory only — it never modifies a cluster). Every answer is grounded in tool
results; the agent is instructed not to invent names, scores, or metrics.

> **Local-model note:** with small local models (e.g. gemma4 via Ollama) the
> chat graph inlines tool results as plain text for the final answer and guards
> against tool-call loops — small models follow this far more reliably than the
> raw ReAct tool-message protocol. Larger hosted models work without these
> crutches.

## Atlas sources

Register an Atlas project with a programmatic **API key** (Project Read Only is
enough). Via the API:

```bash
curl -X POST http://127.0.0.1:4000/api/sources \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"Cluster0","atlas":{"projectId":"<GROUP_ID>","publicKey":"<PUB>","privateKey":"<PRIV>","clusterName":"Cluster0"}}'
```

The Atlas collector gathers, per project:
- **Processes** (nodes, roles, versions) → topology
- **Measurements** (CPU, connections, query targeting, tickets, lock queue)
- **Open alerts**
- **Performance Advisor** suggested indexes

All calls are read-only and authenticated with HTTP Digest. Set `ATLAS_BASE_URL`
to point at a non-default endpoint (e.g. a gov/region cloud).

Scan an Atlas project directly from the CLI:

```bash
ps-agent scan --atlas \\
  --group <PROJECT_ID> --public <PUBLIC_KEY> --private <PRIVATE_KEY> \\
  [--cluster Cluster0] [--summarize] [--save]

# or via env vars
GROUPID=... PUBLICKEY=... PRIVATEKEY=... ps-agent scan --atlas
```

> The API key needs **Project Read Only** on the target project, and this
> machine's IP must be on the key's **API Access List** (Atlas → Access Manager
> → API Keys). A `401 "not authorized for this resource"` means the digest auth
> succeeded but the key lacks access or your IP is blocked.

## Dashboard

```bash
ps-agent serve            # http://127.0.0.1:4000
ps-agent serve --port 8080
```

Open the URL, paste a connection string, and click **Add deployment** — it
registers the source, runs a scan, and shows the score. Tabs: **Fleet**
(score per deployment) and **Risk inbox** (all findings, worst-first). Click a
card for cluster detail (topology, findings, LLM analysis).

Credentials are redacted in every API response (`admin:***`); the real string
is kept server-side only to run scans.

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/fleet` | Latest scan per source |
| `GET` | `/api/risks` | Cross-fleet findings (risk inbox) |
| `GET` | `/api/sources` | Registered sources (redacted) |
| `POST` | `/api/sources` | Register `{ name, connectionString \| atlas \| mcp \| opsManager }` |
| `DELETE` | `/api/sources/:id` | Remove a source |
| `PATCH` | `/api/sources/:id/config` | Set `{ schedule, thresholdOverrides }` |
| `POST` | `/api/sources/:id/scan?summarize=1` | Run a scan |
| `GET` | `/api/sources/:id/capacity` | Capacity report (growth, utilization, scale rec, bottlenecks) |
| `GET` | `/api/scans?sourceId=:id` | List snapshots |
| `GET` | `/api/scans/:scanId` | Full scan result |
| `GET` | `/api/events` | Live event stream (SSE) |
| `GET` | `/api/chat/available` | Whether an LLM provider is configured |
| `POST` | `/api/chat` | Chat turn (SSE stream): `{ threadId, message }` |
| `GET` | `/api/audit?limit=100` | Recent audit-log entries |

## Install

```bash
npm install
```

## Configuration (`.env`)

ps-agent loads a `.env` file from the current directory at startup (shell
environment variables always take precedence). Copy the template and edit:

```bash
cp .env.example .env
```

All settings can equally be passed as real environment variables.

## Storage backend

By default ps-agent persists its state (sources, scans, audit log) to local JSON
files under `~/.ps-agent`. Point it at **MongoDB** to store everything in a
`ps_agent` database instead:

```bash
export PS_AGENT_MONGO_URI="mongodb+srv://user:pass@cluster.example.net/"
# optional: export PS_AGENT_MONGO_DB="ps_agent"   (default)
```

If `PS_AGENT_MONGO_URI` (or `MDB_MCP_CONNECTION_STRING`) is set, the backend
switches to MongoDB automatically — collections `sources`, `scans`, `audit`, and
the chat-memory collections `chat_checkpoints` / `chat_checkpoint_writes` are
created with appropriate indexes. Secrets remain **encrypted at rest** in the
database (the `connectionString` / Atlas private key are stored as `enc:v1:…`
envelopes, never plaintext). The store uses a single pooled `MongoClient`
(`maxPoolSize 10`, sized for this low-concurrency control-plane workload).

**Chat memory persistence.** With the MongoDB backend, chat threads are
checkpointed via LangGraph's `MongoDBSaver`, so conversations survive restarts
(a follow-up question in the same thread works even in a brand-new process).
On the file backend, chat memory is in-process only (`MemorySaver`).

**Historical metrics (capacity/trends).** For Atlas sources, each scan pulls
historical measurements (CPU, memory, cache, connections, disk space/IOPS/latency,
…) and the cluster spec, storing time series in `metric_series` (Mongo) or
`metrics/<sourceId>.json` (file). This feeds capacity/growth/bottleneck analysis.
Configure the backfill window/budget:

| Env var | Default | Purpose |
|---|---|---|
| `PS_AGENT_HISTORY_DAYS` | `90` | History window to backfill |
| `PS_AGENT_HISTORY_GRANULARITY` | `PT1H` | Point interval (`PT5M`/`PT1H`/`PT6H`/`P1D`) |
| `PS_AGENT_HISTORY_MAX_POINTS` | `2400` | Per-metric budget; if exceeded, granularity auto-coarsens (then window shortens) with a warning |
| `PS_AGENT_METRIC_TTL_DAYS` | `95` | Retention for stored points |

## Usage

```bash
# Scan a deployment
npm run scan -- --uri "mongodb://localhost:27017" --name "my-cluster"

# Or via env var
PS_AGENT_URI="mongodb+srv://user:pass@cluster.example.net/" npm run scan

# Machine-readable output
npm run scan -- --uri "mongodb://localhost:27017" --json

# CI gate: exit non-zero on critical findings
npm run scan -- --uri "..." --fail-on critical

# Run the LangGraph graph with LLM narration + persist a snapshot
ANTHROPIC_API_KEY=... npm run scan -- --uri "..." --summarize --save

# Use a local model via Ollama (no API key, fully offline)
PS_AGENT_LLM_PROVIDER=ollama PS_AGENT_LLM_MODEL=gemma4:latest \
  npm run scan -- --uri "..." --summarize
```

### LLM configuration (for `--summarize`)

The agent is provider-agnostic (depends only on LangChain's `BaseChatModel`).
It auto-detects a provider from env:

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Enables that provider (auto-detected) |
| `PS_AGENT_LLM_PROVIDER` | Force `anthropic`, `openai`, or `ollama` |
| `PS_AGENT_LLM_MODEL` | Model name (required for `ollama`) |
| `PS_AGENT_LLM_TEMPERATURE` | Default `0` |
| `OLLAMA_BASE_URL` | Ollama endpoint (default `http://localhost:11434`) |

**Ollama (local).** Set `PS_AGENT_LLM_PROVIDER=ollama` and a chat-capable model
(e.g. `gemma4:latest`). Structured output is produced via Ollama's native
JSON-schema-constrained decoding, which local models follow far more reliably
than tool-calling. Cloud providers use LangChain's `withStructuredOutput`.

Whatever the provider, the LLM output is re-validated against the Zod schema and
is grounded on the rule-engine findings — it can only reference existing
`checkId`s, never invent metrics. Without any provider configured, `--summarize`
degrades gracefully to a deterministic rule-engine summary; the scan never fails
due to the LLM.

Build a standalone binary:

```bash
npm run build
node dist/cli/index.js scan --uri "mongodb://localhost:27017"
```

### Options

| Flag | Description |
|---|---|
| `--uri <str>` | Connection string (or `PS_AGENT_URI`) |
| `--name <str>` | Friendly deployment name |
| `--json` | JSON output |
| `--no-color` | Disable ANSI colors |
| `--fail-on <warning\|critical>` | Exit code 3 if findings reach this level |
| `--summarize` | Run the LLM `correlate_and_rank` node (needs an API key) |
| `--save` | Persist the scan snapshot (default `~/.ps-agent/scans`) |

### Required privileges

The connecting user needs the built-in **`clusterMonitor`** role for
`serverStatus` / `replSetGetStatus` / `$indexStats`. Missing privileges degrade
gracefully to collection warnings rather than failing the scan.

## What it checks

Direct (driver) sources:
- **Availability/Replication:** no primary, unhealthy members, write-majority at
  risk, replication lag, even voter count.
- **Resource:** connection saturation, concurrency tickets, WiredTiger cache
  pressure, global lock queue, disk usage (from `dbStats`).
- **Configuration:** EOL server version, auth disabled, TLS disabled.
- **Query/Index:** unused indexes, redundant (prefix) indexes, index-vs-data size.
- **Storage:** disk usage %, data/index sizes, per-database roll-up (shown in
  the dashboard cluster-detail view).

Atlas sources (metric-trend based):
- **Open Atlas alerts**, **Performance Advisor** index suggestions.
- **Resource:** CPU saturation, connection growth.
- **Query:** poor query targeting (scanned-per-returned).
- Shared config checks (EOL version) apply to both source types.

## Structure

```
src/
├─ core/        shared types + zod source schema
├─ collectors/  Collector interface
│  ├─ direct/   DirectCollector (mongodb driver)
│  ├─ atlas/    AtlasCollector (Admin API) + DigestClient (HTTP Digest auth)
│  ├─ mcp/      McpCollector (MongoDB MCP server, stdio/http)
│  └─ opsmanager/  OpsManagerCollector (OM Public API; reuses DigestClient)
├─ checks/      rule-engine registry, checks (incl. atlas.ts), scoring
├─ agent/       LangGraph layer
│  ├─ llm.ts            provider-agnostic chat-model factory
│  ├─ schema.ts         Zod structured-output schema
│  ├─ correlate.ts      correlate_and_rank node + deterministic fallback
│  ├─ state.ts          graph state annotation
│  ├─ checkpointer.ts   chat-memory saver (MongoDBSaver OR MemorySaver)
│  ├─ tools/            read-only chat tools (fleet, findings, metrics, …)
│  └─ graphs/           healthScanGraph.ts, chatGraph.ts
├─ capacity/    capacity engine: growth/utilization/scale + bottleneck + slow-query
│  ├─ engine.ts stats.ts types.ts   deterministic report
│  ├─ tierTable.ts historyBudget.ts  Atlas tiers + backfill budgeting
│  ├─ slowQuery.ts                   PA slow-query log parser
│  └─ findings.ts                    report → Finding[]
├─ events/      EventBus (scan/schedule lifecycle events)
├─ scheduler/   in-process per-source scan scheduler
├─ store/       stores + factory (file OR mongodb, selected by env)
│  ├─ file*.ts / sourceStore.ts   file-backed stores (default)
│  ├─ crypto.ts / auditLog.ts     AES-256-GCM at rest + audit log
│  ├─ metricStore.ts + mongo/ + fileMetricStore  time-series (capacity)
│  └─ mongo/    Mongo{Source,Scan,Metric}Store + MongoAuditLog + pooled client
├─ service/     HealthService (registry, scan, fleet, risks, chat, config)
├─ server/      HTTP API (api.ts) + self-contained dashboard SPA (dashboard.ts)
├─ scan/        legacy direct runScan (superseded by the graph)
└─ cli/         CLI entrypoint (scan + serve + chat) + formatters
```

### Health-scan graph

```
START → collect_facts → run_rule_engine → correlate_and_rank → END
         (driver)        (pure, no LLM)    (LLM, grounded;
                                            fallback if no key)
```

Only `correlate_and_rank` touches the LLM, and it's constrained by a Zod schema
and may only reference existing findings by `checkId` — it cannot invent metrics.

Add a new check: create a function and call `register({...})` in a file under
`src/checks/`, then import it from `src/checks/index.ts`.
