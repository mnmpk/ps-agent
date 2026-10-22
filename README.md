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
- *P8* — **capacity, growth & bottleneck intelligence** (Atlas + Ops Manager +
  offline FTDC): historical metrics store, growth/days-until-full, scale
  recommendations, and ranked resource/slow-query bottlenecks.
- *P9* — **offline mode**: import read-only diagnostics from isolated clusters —
  getMongoData, mdiag, FTDC, and **mongod.log** — individually or as one
  auto-detected bundle.
- *P10* — **expert risk register**: a mutable catalog assessed per cluster with
  deterministic + LLM-assisted matching.

Recent additions:

- **MongoDB agent skills** — the official MongoDB
  [agent skills](https://github.com/mongodb/agent-skills) are vendored and
  injected (relevance-based) into the LLM prompts, so narration, chat, and risk
  matching apply MongoDB expert guidance.
- **Cached reports** — capacity & risk-register reports are persisted and served
  from the last run (invalidated when a newer scan arrives), so the dashboard and
  chat don't recompute on every view.
- **mongod.log collector** — parses the structured JSON log (4.4+) into
  operational signals (errors, elections, restarts, storage warnings, assertions,
  slow queries) surfaced as `log.*` findings.
- **Deployment model** — every deployment is classified **Atlas** or **on-prem**;
  you add whatever inputs are available and each one just unlocks more
  scans/metrics. The detail page shows what's missing + the consequence and lets
  you supplement.

## Deployments & data availability

A deployment is classified by **how it's hosted**, and you attach whatever inputs
you have. The available inputs — not a single "type" — decide which scans,
metrics, and analyses can run.

| Input | Atlas | On-prem | Unlocks |
|---|:--:|:--:|---|
| Connection string | ✓ | ✓ | Live deep health checks (replication, tickets, cache, indexes) |
| MCP connection | ✓ | ✓ | Live scan via MCP (+ data-layer facts) |
| Atlas Admin API | ✓ | — | Metric trends, tier limits, alerts, Performance Advisor slow queries |
| Ops Manager Admin API | — | ✓ | Metric trends + slow-query logs (no tier limits) |
| FTDC | — | ✓ | Offline capacity trends (growth, days-until-full) |
| getMongoData | — | ✓ | Offline config/status/index/storage snapshot |
| mdiag | — | ✓ | OS/kernel risk checks (swappiness, THP, ulimits, SELinux, NUMA) |
| mongod.log | ✓ | ✓ | Log signals (errors/elections/restarts) + offline slow-query analysis |

All inputs are optional and additive — a deployment can start with just an import
and get a connection string later (or vice-versa). The **detail page → Data
availability** panel lists what's attached, what's missing, the consequence of each
gap (e.g. *"no mongod.log → no slow-query analysis"*), and a **supplement** action
(import a file, or add API credentials via `PATCH /api/sources/:id/connectivity`).

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

The report is **cached** (see [Cached reports](#cached-reports)) — the dashboard
auto-shows the last computed one instantly and offers a **Refresh** to recompute.

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

## Risk register

ps-agent ships an **expert MongoDB risk register** (81 risks with level /
probability / impact / recommendation) and assesses each cluster against it:

- **Deterministic evaluators** check auto-detectable risks against the scan facts
  (EOL version, unused indexes, storage capacity, encryption-at-rest, oplog
  window, TLS-not-enforced, log redaction, majority read concern, NUMA, file
  descriptors, THP, …) → *detected* / *clear* / *unknown* with evidence.
  Detected risks also appear in the main **findings / risk inbox** as
  `register.<id>` (level→severity).
- An **LLM-assisted matcher** cross-references the remaining risks against the
  facts → advisory *suggested* matches (evidence-required, conservative; skips
  org/process risks), shown in the Risk Register view.
- The rest are flagged for **manual review**.

View it in the dashboard (cluster detail → **Risk register**) or via
`GET /api/sources/:id/risks`. Works for any scanned source, including **offline**
getMongoData imports. Like the capacity report, it is **cached** and auto-displayed
(the risk matcher involves an LLM call, so reusing the last run matters) — see
[Cached reports](#cached-reports).

### Managing the catalog

The committed `src/risks/risks-catalog.json` is the **seed**. At runtime the
catalog is mutable and persisted (file `~/.ps-agent/risk-catalog.json`, or the
`risk_catalog` collection when a Mongo store is configured), seeded from the JSON
on first use. Manage it in the dashboard **Risk catalog** tab — enable/disable
per risk (disabled risks are **skipped**: no assessment, no finding), add / edit /
delete, and import / export — or via the API:

```bash
curl http://127.0.0.1:4000/api/catalog                      # list
curl -X POST http://127.0.0.1:4000/api/catalog \
  -H 'Content-Type: application/json' \
  -d '{"name":"Custom risk","level":"high","recommendation":"…"}'
curl -X PATCH http://127.0.0.1:4000/api/catalog/<id> \
  -H 'Content-Type: application/json' -d '{"enabled":false}'   # disable
curl -X DELETE http://127.0.0.1:4000/api/catalog/<id>
curl http://127.0.0.1:4000/api/catalog/export > risks-catalog.json
curl -X POST "http://127.0.0.1:4000/api/catalog/import?mode=merge" \
  --data-binary @risks-catalog.json        # mode=merge (upsert) | replace
```

To (re)generate the seed from the spreadsheet (the `.xlsx` is gitignored), then
import it:

```bash
npm run risks:convert "risk register.xlsx"
```

## Cached reports

The **capacity** and **risk-register** reports are expensive to produce (live
Atlas/Ops Manager API calls, metric aggregation, and — for risks — an LLM
round-trip), so the last computed report of each kind is **persisted per source**
and reused instead of recomputed on every view.

- **Freshness is tied to the latest scan.** A cached report is served only while it
  was computed from the current newest scan; importing/running a newer scan
  invalidates it and the next request recomputes.
- **The dashboard auto-displays** the cached report when you open a deployment
  (no click), with a *"Last computed …"* line and a **Refresh** button. If nothing
  is cached yet, it shows a **Compute now** button instead of silently running the
  expensive work.
- **API controls:**
  - `GET /api/sources/:id/{capacity,risks}` — cached if valid, else recompute.
  - `?refresh=1` — force a recompute and re-cache.
  - `?cachedOnly=1` — return the cached report, or **`204 No Content`** if none
    (never computes; used by the dashboard's auto-display).
- Responses include `cached` (boolean) and `cachedAt` (ISO) metadata.

Cached reports live in the `reports` collection (Mongo backend) or
`~/.ps-agent/reports/` (file backend), keyed by `(sourceId, kind)`, and are cleared
when the source is removed.

## Offline mode (isolated clusters)

Most production clusters are network-isolated, so the agent can't connect. Collect
read-only diagnostics on the nodes and import them — no connection needed. There
are four kinds (all optional, mix as you have them):

- **getMongoData.js** — cluster-level config/status/indexes/storage (one file).
- **mdiag.sh** — node-level OS/kernel tunings (one file per node).
- **FTDC** — node-level `diagnostic.data/metrics.*` for capacity trends (many files).
- **mongod.log** — node-level operational signals from the structured JSON log
  (one file per node): errors, elections, restarts, storage warnings, assertions,
  slow queries.

### Easiest: import everything at once (auto-detected)

Put whatever you collected into one folder (any mix, any number of nodes) and
import it in a single step — the agent detects each file's type and merges it all
into one deployment:

```bash
ps-agent import --dir ./diagnostics --name prod-cluster
#   or: dashboard → Add deployment → "Offline (import diagnostics)" → pick files
#       or a whole folder (there's a "select a whole folder" checkbox)
#   or: curl -X POST "http://127.0.0.1:4000/api/sources/import?name=prod" \
#          -F files=@getMongoData.log -F files=@mdiag-n1.json \
#          -F files=@n1/diagnostic.data/metrics.2024-03-08T22-58-41Z-00000 \
#          -F files=@n1/mongod.log
```

On an existing deployment, use **"Import files…"** or **"Import folder…"** in the
cluster detail view (or `POST /api/sources/:id/import`) to attach more diagnostics
later. "Import folder…" recurses into subfolders, so you can point it at a whole
`diagnostic.data` tree (or a multi-node collection) in one go. The individual
commands below still work if you prefer to import one type at a time.

Node identity is reconciled across the sources — getMongoData member names
(`host:port`), FTDC hostnames, mdiag bare hostnames, and mongod.log startup
hostnames are matched to the replica set's member list, so each physical node is
counted once (not several times).

### getMongoData (one type at a time)

```bash
# 1) On the isolated node:
mongosh HOST:PORT/admin -u <user> -p <pass> getMongoData.js > getMongoData.log

# 2) Bring the log to the agent, then import it:
ps-agent import --file getMongoData.log --name prod-cluster
#   or: curl -X POST "http://127.0.0.1:4000/api/sources/offline/import?name=prod" --data-binary @getMongoData.log
```

The import parses the export into facts and produces a full health/config/index/
storage report (`collectionMethod: offline`), with hardware limits from the
export's `hostInfo` (RAM/cores). It's a point-in-time snapshot — re-import a newer
log to update. (For growth/utilization **trends** offline, attach FTDC — below.)

### FTDC (offline capacity metrics)

getMongoData is a single snapshot, so it can't show CPU/memory/disk **trends**.
MongoDB continuously records those in **FTDC** (Full-Time Diagnostic Data Capture)
— binary files under each node's `diagnostic.data/` directory. Ship those files to
the agent to get real time-series for capacity analysis, with no connection:

```bash
# On the node, the files live in the dbPath (or systemLog dir):
#   <dbPath>/diagnostic.data/metrics.*        (archive files)
# Keep those files where they are and point the agent at the directory:

# Attach FTDC to an existing deployment (recommended: import getMongoData first):
ps-agent import --ftdc --file /path/to/diagnostic.data --source <sourceId>
#   single file also works:  --file /path/to/metrics.2024-03-08T22-58-41Z-00000
#   multiple nodes at once:  --file /node1/diagnostic.data,/node2/diagnostic.data
#   or standalone:           ps-agent import --ftdc --file diagnostic.data --name prod
#   or:  curl -X POST http://127.0.0.1:4000/api/sources/<id>/ftdc/import \
#          -H 'Content-Type: application/octet-stream' --data-binary @metrics.<ts>
#   or:  dashboard → open the cluster → "Attach FTDC" → upload a metrics.* file
```

**The raw FTDC files stay on disk — the agent does not copy them into its store.**
Raw FTDC is large (thousands of metrics at 1 sample/sec per node → GBs). FTDC files
are decoded **in parallel across worker threads** (one file per worker, results
streamed back as each completes so points are appended and memory freed
incrementally — a multi-GB, many-file import stays bounded and uses all cores).
Each file is decoded, a curated capacity set extracted, and each series
**downsampled to 5-minute buckets** before storing (~130 MB/cluster per 90 days for
6 nodes — ~300× sparser than raw 1 Hz, still fine-grained for charts). Gauges are
averaged per bucket; spiky rate series (CPU, IOPS, latency, opcounters) use the
per-bucket max so peaks survive for p95.

**Counter rates are computed over a ~20-second window, not per-second.** Several
Linux counters in FTDC (notably `systemMetrics.cpu.*_ms` and disk counters) are
jittery/non-monotonic at 1 Hz — naïve 1-second deltas produced nonsense (CPU pegged
at 100%, impossible IOPS). Following x-ray's approach (which samples at ~1/20),
rates are taken over a sliding ~20 s window **within each FTDC chunk** (never across
a chunk boundary, where the reconstructed first sample would otherwise spike), which
smooths the jitter and yields realistic values. Tune with:
`PS_AGENT_FTDC_BUCKET_SECONDS` (storage bucket, default `300`),
`PS_AGENT_FTDC_RATE_WINDOW_SEC` (rate window, default `20`), and
`PS_AGENT_FTDC_WORKERS` (parallel decoders, default min(4, cores−1)). All nodes of a
replica set import into a single cluster source, each keeping its own per-node
series; capacity rolls up across nodes automatically.

> A real 2.3 GB bundle (1 getMongoData, 6 mdiag, 12 × 200 MB mongod.log, 122 FTDC
> files across 6 nodes) imports end-to-end in a few minutes. mongod.log files are
> **streamed line-by-line** (constant memory), so hundreds-of-MB logs don't spike
> the heap.

The decoder reads the FTDC archive format directly (zlib + delta/varint
reconstruction; no external tool) and extracts the canonical capacity series:
WiredTiger cache used, normalized CPU (user/kernel), disk space used/free, total
IOPS, and opcounter rates. OS-level CPU/disk metrics are present only on **Linux**
hosts (`/proc`); the MongoDB serverStatus series (cache, connections, opcounters)
are always available. Points are appended idempotently, so re-importing overlapping
files — or importing a whole `diagnostic.data` directory spanning days — is safe and
builds the history the capacity engine needs for growth + days-until-full.

> The dashboard "Attach FTDC" button uploads a **single** `metrics.*` file (held in
> memory for that one request). For large multi-file / multi-node imports, prefer the
> CLI, which streams from disk and never loads everything at once.

Each import records **provenance** on the source (metadata only — no raw bytes):
which paths were ingested, how many files, which nodes, and the data **time range**
covered, plus a per-node coverage roll-up (`from → to`, earliest→latest across all
imports). See it in `GET /api/sources` (`ftdcProvenance`) or the dashboard cluster
detail view — handy for knowing what history you already have and which gaps to
re-import.

### mdiag (OS/kernel tunings)

getMongoData doesn't capture OS-level settings. For those, also run MongoDB's
[**mdiag.sh**](https://github.com/mongodb/support-tools/tree/master/mdiag)
(Linux) and attach its JSON to the same cluster — it unlocks the OS risk-register
checks (swappiness, THP, read-ahead, max_map_count, TCP keepalive, file
descriptors, SELinux, NUMA):

```bash
# On the node (Linux):
sudo bash mdiag.sh --json <ticket-ref>      # writes /tmp/mdiag-<host>.json

# Attach to an existing deployment:
ps-agent import --mdiag --file mdiag-host.json --source <sourceId>
#   or standalone:  ps-agent import --mdiag --file mdiag-host.json --name host
#   or:  curl -X POST http://127.0.0.1:4000/api/sources/<id>/mdiag/import --data-binary @mdiag-host.json
#   or:  dashboard → open the cluster → "Attach mdiag" → upload the file
```

### mongod.log (operational signals)

The point-in-time snapshots above don't capture what *happened over time* on a
node. A **mongod.log** (structured JSON, MongoDB 4.4+) does: ship it to the agent to
distil operational signals — error/fatal counts, replica-set elections & state
changes, process restarts / unclean shutdowns, WiredTiger/storage warnings,
assertions, connection churn, and slow queries:

```bash
# The log lives at the configured systemLog path (e.g. /var/log/mongodb/mongod.log):
ps-agent import --log --file mongod.log --source <sourceId>
#   or standalone:  ps-agent import --log --file mongod.log --name node1
#   or:  curl -X POST http://127.0.0.1:4000/api/sources/<id>/log/import --data-binary @mongod.log
#   (a mongod.log dropped into the unified folder/upload is auto-detected too)
```

The parser reads the newline-delimited JSON log lines (`{t,s,c,id,ctx,msg,attr}`),
rolls them into `LogFacts` on the scan, and surfaces findings via the `log.*` checks
(`log.fatal-errors`, `log.error-rate`, `log.frequent-elections`,
`log.unclean-shutdown`, `log.storage-warnings`). Slow-query lines are aggregated into
per-namespace signals and stored on the source (compact, redaction-safe — no query
values), so the **offline capacity report surfaces query bottlenecks** the same way
Atlas/Ops Manager sources do via the Performance Advisor. Only the structured JSON
format is supported (not the pre-4.4 plaintext log).

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

## MongoDB agent skills

ps-agent vendors the official MongoDB
[agent skills](https://github.com/mongodb/agent-skills) (Apache-2.0) under
`src/skills/catalog/` — `mongodb-schema-design`, `mongodb-query-optimizer`,
`mongodb-connection`, `mongodb-search-and-ai`, `mongodb-natural-language-querying`,
`mongodb-atlas-stream-processing`, `mongodb-qe-size-estimation`, and
`mongodb-mcp-setup`. Each is a `SKILL.md` (YAML frontmatter + expert-guidance body).

At runtime a lightweight loader (`src/skills/index.ts`) parses the frontmatter and,
for a given context, selects the most relevant skill(s) by token overlap and injects
their guidance into the LLM system prompt — **always after the grounding rules**, so
"don't invent facts/metrics" still wins. Three LLM touchpoints use it:

- **Scan narration** (`correlate_and_rank`) — skills chosen from the findings.
- **Chat agent** — skills chosen from the user's question.
- **Risk matcher** — skills chosen from the candidate risks.

Injection is best-effort and dependency-free (no YAML lib); if nothing is relevant,
nothing is injected. The vendored catalog is copied into `dist/` at build time, so
it works from both source (tsx) and a built binary with no network access.

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

Open the URL and click **Add deployment** — pick **Atlas** or **on-prem**, then
add whatever you have (connection string, MCP, Atlas/Ops Manager API, and/or
import diagnostic files), and it registers the source, runs a scan, and shows the
score. Tabs: **Fleet** (score per deployment) and **Risk inbox** (all findings,
worst-first). Click a card for cluster detail (topology, **data availability**,
capacity, **metrics charts**, risk register, findings, LLM analysis). The Data
availability panel shows what's missing + the consequence and lets you supplement
(import a file or add API keys) on the spot.

### Metrics charts (per node)

When FTDC (or Atlas/Ops Manager history) has been ingested, the detail page shows a
**Metrics** panel of per-node time-series charts — like an inline version of the
[x-ray](https://github.com/mongodb-ps/ce-mongo-x-ray) FTDC report. Pick a node
(defaults to the PRIMARY) and see, grouped **Workload / Ops & latencies /
Performance**: opcounters (query/insert/update/delete/getmore/command),
connections, disk IOPS + read/write ops & latency, CPU user/system/iowait, system
memory utilization, memory fragmentation, WiredTiger cache fill/dirty %, cache used,
and disk space. There's also a **replica-set member-state timeline** (per-member
PRIMARY/SECONDARY/… bands over the captured window). Each **node is tagged with its
role** (PRIMARY / SECONDARY / HIDDEN / ARBITER / DOWN) on the selector pills and
member rows; when a getMongoData export is imported, members also show their config
badges (`v<votes>`, `p<priority>`, hidden, arbiter) from the replica-set config.
Charts are **inline SVG** (no external JS/CDN — the dashboard stays a self-contained
HTML document); `%` metrics show their warn/critical threshold lines, and
**hovering** a chart shows the nearest point's value + timestamp with a guide line +
dot. Each row lists peak / average. Backed by `GET /api/sources/:id/metrics`.

> **"Scan now" vs re-import.** For a deployment with **no live connection**
> (import-only), the detail-page button reads **"Re-analyze"** — it re-runs the
> rule engine + risk register on the already-imported facts and persists a fresh
> scan (it does **not** re-read files). To pick up new files or improved parsing,
> import again. Deployments with a connection string / MCP / Atlas / OM API show
> **"Scan now"** and collect live.

Credentials are redacted in every API response (`admin:***`); the real string
is kept server-side only to run scans.

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/fleet` | Latest scan per source |
| `GET` | `/api/risks` | Cross-fleet findings (risk inbox) |
| `GET` | `/api/sources` | Registered sources (redacted) |
| `POST` | `/api/sources` | Register `{ name, deployment: "atlas"\|"on-prem", connectionString?, mcp?, atlas?, opsManager? }` (all connectivity optional) |
| `PATCH` | `/api/sources/:id/connectivity` | Attach/update connectionString / mcp / atlas / opsManager on an existing source |
| `GET` | `/api/sources/:id/capabilities` | Data availability: inputs present, missing + consequence, derived capabilities |
| `POST` | `/api/sources/import` | **Unified import**: multipart upload of any mix of getMongoData/mdiag/FTDC/mongod.log → one source |
| `POST` | `/api/sources/:id/import` | Same, enriching an existing source (multipart) |
| `POST` | `/api/sources/offline/import` | Import a getMongoData log (raw body) → offline source |
| `POST` | `/api/sources/:id/mdiag/import` | Attach an mdiag OS report to a source (raw body) |
| `POST` | `/api/sources/:id/ftdc/import` | Attach FTDC metrics (binary body) for offline capacity trends |
| `POST` | `/api/sources/:id/log/import` | Attach a mongod.log (raw body) → `log` signals + offline slow-query bottlenecks |
| `GET` | `/api/sources/:id/risks` | Risk-register assessment (cached; `?refresh=1` recomputes, `?cachedOnly=1` → cache or 204) |
| `GET` | `/api/catalog` | List the risk catalog |
| `POST` | `/api/catalog` | Add/upsert a risk (auto-ids new entries) |
| `PATCH` | `/api/catalog/:id` | Edit, or toggle `{ enabled }` |
| `DELETE` | `/api/catalog/:id` | Delete a risk |
| `GET` | `/api/catalog/export` | Download the catalog as JSON |
| `POST` | `/api/catalog/import?mode=merge\|replace` | Import catalog JSON (raw body) |
| `DELETE` | `/api/sources/:id` | Remove a source |
| `PATCH` | `/api/sources/:id/config` | Set `{ schedule, thresholdOverrides }` |
| `POST` | `/api/sources/:id/scan?summarize=1` | Run a scan |
| `GET` | `/api/sources/:id/capacity` | Capacity report (cached; `?refresh=1` recomputes, `?cachedOnly=1` → cache or 204) |
| `GET` | `/api/sources/:id/metrics` | Per-node metric time-series (`?processId=`, `?metrics=A,B`, `?days=N`) for the Metrics panel |
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

By default ps-agent persists its state (sources, scans, audit log, risk catalog,
metric series, cached reports) to local JSON files under `~/.ps-agent`. Point it at
**MongoDB** to store everything in a `ps_agent` database instead:

```bash
export PS_AGENT_MONGO_URI="mongodb+srv://user:pass@cluster.example.net/"
# optional: export PS_AGENT_MONGO_DB="ps_agent"   (default)
```

If `PS_AGENT_MONGO_URI` (or `MDB_MCP_CONNECTION_STRING`) is set, the backend
switches to MongoDB automatically — collections `sources`, `scans`, `audit`,
`risk_catalog`, `metric_series`, `reports` (cached capacity/risk reports), and the
chat-memory collections `chat_checkpoints` / `chat_checkpoint_writes` are created
with appropriate indexes. Secrets remain **encrypted at rest** in the database (the
`connectionString` / Atlas private key are stored as `enc:v1:…` envelopes, never
plaintext). The store uses a single pooled `MongoClient` (`maxPoolSize 10`, sized
for this low-concurrency control-plane workload).

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
| `PS_AGENT_FTDC_BUCKET_SECONDS` | `300` | FTDC downsample bucket width (storage resolution) |
| `PS_AGENT_FTDC_RATE_WINDOW_SEC` | `20` | Window for computing counter rates (CPU/IOPS/latency); smooths 1 Hz jitter |
| `PS_AGENT_FTDC_WORKERS` | `min(4, cores−1)` | Parallel FTDC decode worker threads |

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

Imported mongod.log (`log.*`, offline):
- **Fatal errors / assertions**, elevated **error rate**, frequent **elections**,
  **unclean shutdowns / restarts**, and **storage/WiredTiger warnings** — plus
  per-namespace slow-query bottlenecks fed into the capacity report.

## Structure

```
src/
├─ core/        shared types + zod source schema
├─ collectors/  Collector interface
│  ├─ direct/   DirectCollector (mongodb driver)
│  ├─ atlas/    AtlasCollector (Admin API) + DigestClient (HTTP Digest auth)
│  ├─ mcp/      McpCollector (MongoDB MCP server, stdio/http)
│  ├─ opsmanager/  OpsManagerCollector (OM Public API; reuses DigestClient)
│  ├─ getmongodata/  parse.ts — offline import of getMongoData.js exports
│  ├─ mdiag/        parse.ts — OS/kernel facts from mdiag.sh --json exports
│  ├─ mongodlog/    parse.ts — operational signals from mongod.log (JSON, 4.4+)
│  ├─ ftdc/         decode/parse/downsample — offline capacity metrics
│  └─ detect.ts     content sniffer for the unified diagnostics import
├─ risks/      expert risk register: catalog (json) + evaluators + LLM matcher
├─ skills/     vendored MongoDB agent skills (catalog/) + loader/selector
├─ checks/      rule-engine registry, checks (incl. atlas.ts, log.ts), scoring
├─ agent/       LangGraph layer
│  ├─ llm.ts            provider-agnostic chat-model factory
│  ├─ schema.ts         Zod structured-output schema
│  ├─ correlate.ts      correlate_and_rank node + deterministic fallback (+ skills)
│  ├─ state.ts          graph state annotation
│  ├─ checkpointer.ts   chat-memory saver (MongoDBSaver OR MemorySaver)
│  ├─ tools/            read-only chat tools (fleet, findings, metrics, …)
│  └─ graphs/           healthScanGraph.ts, chatGraph.ts (+ skills injection)
├─ capacity/    capacity engine: growth/utilization/scale + bottleneck + slow-query
│  ├─ engine.ts stats.ts types.ts   deterministic report
│  ├─ tierTable.ts historyBudget.ts  Atlas tiers + backfill budgeting
│  ├─ slowQuery.ts                   PA / mongod.log slow-query parser
│  └─ findings.ts                    report → Finding[]
├─ events/      EventBus (scan/schedule lifecycle events)
├─ scheduler/   in-process per-source scan scheduler
├─ store/       stores + factory (file OR mongodb, selected by env)
│  ├─ file*.ts / sourceStore.ts   file-backed stores (default)
│  ├─ crypto.ts / auditLog.ts     AES-256-GCM at rest + audit log
│  ├─ metricStore.ts + fileMetricStore          time-series (capacity)
│  ├─ catalogStore.ts + fileCatalogStore        mutable risk catalog
│  ├─ fileReportStore.ts                         cached capacity/risk reports
│  └─ mongo/    Mongo{Source,Scan,Metric,Catalog,Report}Store + MongoAuditLog + pooled client
├─ service/     HealthService (registry, scan, fleet, risks, capacity, chat, config)
├─ server/      HTTP API (api.ts) + self-contained dashboard SPA (dashboard.ts)
├─ scan/        legacy direct runScan (superseded by the graph)
└─ cli/         CLI entrypoint (scan + serve + chat + import) + formatters
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

### TODO/Bugs
1. ~~Cannot recognize mdiag output~~ — fixed (section-vocabulary classifier)
2. Disable "add deployment" button after click to avoid multiple add, show upload progress or make it background
3. monogd.log can be obtained via atlas admin API if upload is missing.
4. topology graph
5. ~~metrics charts like x-ray~~ — done (per-node FTDC Metrics panel, inline SVG)
6. host/cluster info from FTDC?
7. ~~check sub-folder recursively for import~~ — done (dashboard "Import folder…"
   recurses via `webkitdirectory`; CLI `--dir` already walks subfolders)
8. review the risk catalog, there should be more risk that can be match after adding more logs collectors