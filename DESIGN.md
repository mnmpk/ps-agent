# MongoDB Deployment Health Agent — Design

An AI-assisted application (think "Compass / Relational Migrator for health")
that connects to one or many MongoDB deployments — Atlas or self-managed — runs
scheduled health scans, surfaces risks on a dashboard, and lets you chat with an
agent to drill into findings. Built with **TypeScript + LangChain + LangGraph**.

---

## 1. Goals & Non-Goals

### Goals
- Connect to **multiple** deployments concurrently (Atlas + self-managed).
- Two data planes:
  - **Self-managed / direct**: connection string → driver commands (`serverStatus`, `replSetGetStatus`, `dbStats`, `$indexStats`, etc.).
  - **Atlas**: Atlas Admin API (processes, measurements, alerts, Performance Advisor) and/or the **MongoDB MCP server**.
- **Hybrid operation**: background scheduled scans populate a dashboard **plus** an interactive chat agent for ad-hoc investigation.
- Produce **explainable, deterministic findings** (rule engine) that the LLM narrates/prioritizes — never invents raw metrics.
- Provider-agnostic LLM via LangChain's `BaseChatModel` interface.

### Non-Goals (v1)
- No automated remediation / writes to clusters (read-only). Remediation = suggested commands only, gated behind human approval.
- Not a full APM/metrics TSDB replacement; we snapshot + short-term trend, not long retention.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js/React)                   │
│  Dashboard  │  Cluster detail  │  Risk list  │  Chat panel         │
└───────────────▲───────────────────────────────▲───────────────────┘
                │ REST (snapshots, findings)     │ WebSocket (chat stream,
                │                                 │ live scan progress)
┌───────────────┴─────────────────────────────────┴─────────────────┐
│                      Backend (Node + TypeScript)                   │
│                                                                    │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────────┐    │
│  │ API layer  │   │  Scheduler   │   │   LangGraph Agent       │    │
│  │ (Fastify/  │   │ (cron / BullMQ) │ │   (health + chat graph)│    │
│  │  Express)  │   └──────┬───────┘   └───────────┬────────────┘    │
│  └─────┬──────┘          │                        │                 │
│        │        ┌────────▼────────────────────────▼──────────┐      │
│        │        │           Collector Layer (Tools)          │      │
│        │        │  DirectCollector  │  AtlasCollector  │ MCP  │      │
│        │        └────────┬──────────────────┬─────────┬──────┘      │
│        │                 │                  │         │             │
│  ┌─────▼─────┐   ┌────────▼──────┐  ┌────────▼───┐ ┌──▼─────────┐    │
│  │ App store │   │ mongodb driver│  │ Atlas Admin│ │ MCP client │    │
│  │ (metadata,│   │ (self-managed)│  │ API (SDK)  │ │ (stdio/http)│   │
│  │ snapshots,│   └───────────────┘  └────────────┘ └────────────┘   │
│  │ findings) │                                                      │
│  └───────────┘                                                      │
└────────────────────────────────────────────────────────────────────┘
        │
   ┌────▼───────────────────────────┐
   │ Target MongoDB deployments      │
   │  • Atlas projects/clusters      │
   │  • Self-managed replica sets /  │
   │    sharded clusters             │
   └─────────────────────────────────┘
```

**Key principle — separation of "measure" vs "reason":**
1. **Collectors** gather raw facts (pure, typed, no LLM).
2. **Rule engine** turns facts → deterministic `Finding[]` with severity.
3. **LangGraph agent** prioritizes, correlates, explains, and answers chat — grounded *only* on collected facts + findings. This keeps results reproducible and auditable, and prevents the LLM from hallucinating metrics.

---

## 3. Connection / Source Abstraction

A deployment is registered as a **Source**. The only hard classification is how
it's **hosted** (`atlas | on-prem`); everything else — which scans, metrics, and
analyses can run — is **derived from the available inputs**, not from a single
collection-method enum. (Implemented schema: `src/core/source.ts`; capability
model: `src/core/capabilities.ts`.)

```ts
type Deployment = "atlas" | "on-prem";

interface Source {
  id: string;
  name: string;
  deployment: Deployment;           // hosting classification (the only hard type)
  // --- live connectivity (either deployment) ---
  connectionString?: string;        // stored encrypted at rest
  mcp?: { transport: "stdio" | "http"; command?: string; url?: string };
  // --- admin APIs (one per deployment type) ---
  atlas?: { projectId: string; publicKey: string; privateKey: string; clusterName?: string }; // atlas only
  opsManager?: { baseUrl: string; projectId: string; publicKey: string; privateKey: string };  // on-prem only
  tags?: string[];
  // --- import provenance / derived data (no raw bytes) ---
  ftdcProvenance?: {...};            // FTDC ingest events + per-node coverage
  logQuerySignals?: QuerySignal[];   // aggregated slow queries from mongod.log
  attachments?: { getMongoData?: {at}; mdiag?: {at}; mongodLog?: {at} }; // import markers
  schedule?: { intervalSeconds?: number; enabled: boolean };
  thresholdOverrides?: Record<string, number>;
}
```

**Allowed inputs per deployment** (enforced in the form + API):
- **Atlas:** connection string, MCP, Atlas Admin API, mongod.log.
- **On-prem:** connection string, MCP, Ops Manager Admin API, FTDC, getMongoData,
  mdiag, mongod.log.

All inputs are **optional and additive**. A source with no live input
(connection string / MCP / Atlas / Ops Manager API) is *import-only*: it can't be
collected live, so a scan re-scores its last import instead.

**Capability model** (`availabilityOf` in `src/core/capabilities.ts`) is the single
source of truth for what a source can do. From the present inputs (+ the latest
scan's facts + whether metric series exist) it derives `Capabilities`
(`liveScan`, `deepHealthChecks`, `capacityTrends`, `utilizationLimits`,
`slowQueryAnalysis`, `riskRegister`, `osRiskChecks`, `logSignals`) and, for the
detail page, the list of **available** inputs and **missing** inputs each paired
with its *consequence*. Both runtime gating and the dashboard "Data availability"
panel read from this, so they always agree. Supplementing an existing source
(adding a connection string / API key) goes through
`attachConnectivity` (`PATCH /api/sources/:id/connectivity`); importing a file goes
through the unified importer.

**Online** sources implement a small `Collector` interface that returns a single
typed facts bundle (`src/collectors/collector.ts`):

```ts
interface Collector {
  collect(): Promise<CollectedFacts>;   // measure only — no health judgements
  close(): Promise<void>;
}
```

`CollectedFacts` aggregates everything a scan gathered: topology, `serverStatus`,
`replSetStatus`, index usage, Atlas facts, storage, host info, server parameters,
and the optional offline-only `os` (mdiag) and `log` (mongod.log) fact blocks.

**Offline** inputs are NOT collectors — they are pure parse functions
(`parseGetMongoData` / `parseMdiag` / `parseFtdc` / `parseMongodLog`) invoked by the
import flow (§15), which merge their output into `CollectedFacts` and score it.

**Collector selection** (`collectorFor`, `healthScanGraph.ts`) picks from the
*available* inputs, favoring the deepest check: MCP (optionally with a connection
string → deep driver + data-layer) → connection string (Direct) → Atlas API →
Ops Manager API. A source with none is import-only.

- **DirectCollector** — `mongodb` Node driver, `admin` db commands. Needs a user with `clusterMonitor`. Also runs `hostInfo`/`dbStats`/`buildInfo` for RAM/cores/limits.
- **AtlasCollector** — Atlas Admin API (HTTP Digest). Pulls `/processes`, `/processes/{id}/measurements`, `/alerts`, Performance Advisor suggestions, cluster spec, and N-day history. Respects rate limits (batch + cache).
- **OpsManagerCollector** — the self-managed mirror of Atlas via the OM Public API (`/hosts` + history + slow queries; reuses `DigestClient`; no cluster-tier spec).
- **McpCollector** — scans through a MongoDB MCP server (stdio/http). With a connection string it also runs the full driver check (`mcp+direct`); without one, data-layer facts only (`mcp`).

> **Credential handling:** connection strings / Atlas & OM keys are **AES-256-GCM
> encrypted at rest** (`enc:v1:…` envelopes; key from `PS_AGENT_SECRET_KEY` or a
> generated `secret.key`). Never logged. Redacted in all API responses and in
> anything passed to the LLM.

---

## 4. Health-Check Catalog (the Rule Engine)

Each check is a pure function `(facts) => Finding | null`. Grouped by category.
Severity: `ok | info | warning | critical`.

### 4.1 Availability & Replication
| Check | Signal | Risk |
|---|---|---|
| Member unhealthy | `replSetGetStatus.members[].health == 0` or state not `PRIMARY/SECONDARY` | critical |
| Replication lag | `optimeDate` delta secondary vs primary > threshold | warning/critical |
| No primary | no member in state 1 | critical |
| Majority at risk | healthy voting members < majority | critical |
| Election churn | frequent term changes / `electionMetrics` | warning |
| PV / oplog window | oplog window (hours) below threshold | warning |

### 4.2 Resource Saturation
| Check | Signal | Risk |
|---|---|---|
| CPU saturation | `SYSTEM_CPU_USER+KERNEL` sustained high | warning/critical |
| Memory / cache pressure | WiredTiger cache dirty/evicted, page faults | warning |
| Disk space | partition free % low; growth trend → projected full date | warning/critical |
| Disk IOPS/latency | `DISK_LATENCY`, IOPS near provisioned | warning |
| Connections | `CONNECTIONS` near `maxIncomingConnections` | warning/critical |
| Tickets exhausted | `TICKETS_AVAILABLE_READS/WRITES` → 0 | critical |
| Global lock queue | `GLOBAL_LOCK_CURRENT_QUEUE_*` rising | warning |

### 4.3 Query & Index Health
| Check | Signal | Risk |
|---|---|---|
| Query targeting | `QUERY_TARGETING_SCANNED_*_PER_RETURNED` high → missing index | warning |
| Unused indexes | `$indexStats.accesses.ops == 0` over window | info/warning |
| Duplicate/redundant indexes | prefix-overlapping keys | info |
| Collection scans | profiler / slow query sampling | warning |
| Missing index suggestions | Atlas Performance Advisor | warning |

### 4.4 Configuration & Best Practices
| Check | Signal | Risk |
|---|---|---|
| Server version EOL | version vs support matrix | warning/critical |
| Unencrypted / no auth | `getCmdLineOpts` security flags | critical |
| Read/write concern defaults | weak defaults (`w:1`, no majority) | info/warning |
| Journaling / FCV mismatch | `featureCompatibilityVersion` vs binary | warning |
| Odd voting-member count | even voters → tie risk | warning |
| Backups | Atlas: backup policy present; direct: last snapshot age | warning |

Checks are declared in a **registry** so new ones are data-driven:

```ts
interface HealthCheck {
  id: string; category: Category; title: string;
  evaluate(ctx: CheckContext): Finding[] | null;
  thresholds?: Record<string, number>;   // configurable per-source
  docs?: string;                          // link for remediation guidance
}
```

---

## 5. LangGraph Agent Design

Two graphs sharing the same tools and state store.

### 5.1 Health-Scan Graph (scheduled / on-demand)
Deterministic-first, LLM-last.

```
 register_scan
      │
      ▼
 collect_facts (parallel fan-out per node/source)  ──┐
      │                                               │ tool nodes:
      ▼                                               │  collector.*
 run_rule_engine  (pure, no LLM)                      │
      │                                               │
      ▼                                               ▼
 correlate_and_rank (LLM)  ── groups related findings, de-dupes,
      │                        assigns a cluster "health score",
      │                        writes an executive summary
      ▼
 persist_snapshot  →  emit WS "scan.completed"
```

`correlate_and_rank` is the *only* LLM node here. It receives structured
`Finding[]` + key metrics and returns: overall score (0–100), top risks, and a
human summary. It cannot fabricate findings — schema-constrained output
(`withStructuredOutput(zodSchema)`).

### 5.2 Chat Graph (ReAct-style, interactive)
```
 user_msg → agent (LLM w/ tools) ⇄ tools → respond (stream)
                     │
     tools: queryFindings, getMetricSeries, runCheck(id),
            explainFinding(id), compareSnapshots, mcp.* (optional),
            suggestRemediation(id)  [read-only, returns commands + caveats]
```
- Uses LangGraph `createReactAgent` or a custom graph with a `ToolNode`.
- **Guardrails**: tools are read-only; any "action" tool only *drafts* commands and requires explicit UI confirmation (human-in-the-loop interrupt via LangGraph `interrupt()`).
- **Memory**: thread-scoped via LangGraph checkpointer (e.g. `MongoDBSaver` or Postgres) so conversations persist and can resume.

### 5.3 Shared State
```ts
interface AgentState {
  sourceIds: string[];
  facts: Record<string, CollectedFacts>;   // keyed by sourceId
  findings: Finding[];
  score?: HealthScore;
  summary?: string;
  messages: BaseMessage[];                  // chat
}
```

---

## 6. Data Model (App Store)

Store app metadata/snapshots in its own MongoDB (dogfooding) or Postgres.

Implemented collections (Mongo backend; the file backend mirrors each as JSON
under `~/.ps-agent`). Selected automatically by `createStores()` when a Mongo
store URI is configured.

```
sources            // registered deployments (creds encrypted at rest)
scans              // full ScanResult (facts + findings + score), flattened keys for listing
metric_series      // capacity time-series {sourceId, processId, metric, ts, value}; TTL index
risk_catalog       // mutable expert risk register (seeded from risks-catalog.json)
reports            // cached capacity/risk reports, keyed by (sourceId, kind)
audit              // append-only: source.register/remove/config, scan.run
chat_checkpoints   // LangGraph MongoDBSaver (chat memory)
chat_checkpoint_writes
```

- `metric_series` has a **TTL index** (`PS_AGENT_METRIC_TTL_DAYS`, default 95d) to
  bound growth, plus a `{sourceId, metric, processId, ts}` index.
- `scans` embed each finding's `evidence` (exact numbers) so the UI/LLM cite real data.
- `reports` retains only the latest report per `(sourceId, kind)`; it is invalidated
  when a newer scan arrives and cleared on source removal (see §17).

---

## 7. Dashboard UX

- **Fleet overview**: card per deployment → health score, severity counts, trend sparkline, last-scan time. Color-coded (green/amber/red).
- **Cluster detail**: topology diagram (members, roles, lag), resource gauges, findings grouped by category, each expandable with evidence + remediation.
- **Risk inbox**: cross-fleet sorted list of findings (filter by severity/category/source).
- **Chat panel** (right drawer): ask "why is cluster X amber?", "show me the worst query-targeting offenders", "project when disk fills". Streams tokens + shows which tools ran.
- **Scan controls**: "Scan now", schedule config, threshold overrides per source.

---

## 8. Scheduling & Live Updates
- **Scheduler**: BullMQ (Redis) or a lightweight cron; one repeatable job per source at its configured cadence. Jitter to avoid thundering herd; respect Atlas rate limits.
- **Live updates**: WebSocket channel pushes `scan.started/progress/completed` and chat token streams. Frontend subscribes per source.

---

## 9. Security
- Read-only DB role (`clusterMonitor`) enforced/validated at connect time; warn if over-privileged.
- Credentials encrypted at rest; decrypted only in collector process; redacted before reaching the LLM.
- LLM never receives raw connection strings or keys — only derived facts.
- All agent tool calls written to `audit_log`.
- Human-in-the-loop interrupt for any suggested command execution (if you later add an opt-in exec feature).

---

## 10. Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) |
| Agent framework | LangGraph (`@langchain/langgraph`) + LangChain |
| LLM abstraction | `BaseChatModel` (Anthropic/OpenAI/Bedrock/Ollama swappable) |
| Structured output | Zod + `withStructuredOutput` |
| MongoDB access | `mongodb` driver (direct), `atlas-sdk` (Atlas), MCP client (optional) |
| Backend | Fastify + ws |
| Scheduler/queue | BullMQ + Redis |
| Checkpointer | LangGraph MongoDB/Postgres saver |
| Frontend | Next.js + React + Tailwind + Recharts/visx |
| Validation | Zod everywhere at boundaries |

---

## 11. Proposed Repo Structure

> **As built**, the project is a single flat `src/` package (not a packages/apps
> monorepo). See the **Structure** section in [README.md](./README.md) for the
> actual tree, which includes `collectors/{getmongodata,mdiag,mongodlog,ftdc}`,
> `skills/`, `capacity/`, `risks/`, and `store/` (file + mongo backends incl. the
> `reports` cache). The original proposal below is kept for historical context.

```
ps-agent/
├─ packages/
│  ├─ core/                 # shared types, zod schemas
│  ├─ collectors/
│  │  ├─ direct/            # driver-based collector
│  │  ├─ atlas/             # Atlas Admin API collector
│  │  └─ mcp/               # MCP-backed collector/tools
│  ├─ checks/               # health-check registry (pure functions)
│  ├─ agent/
│  │  ├─ graphs/            # healthScanGraph.ts, chatGraph.ts
│  │  ├─ tools/             # LangChain tools wrapping collectors/checks
│  │  ├─ llm.ts             # provider-agnostic model factory
│  │  └─ state.ts
│  ├─ scheduler/            # BullMQ jobs
│  └─ store/                # app DB repositories
├─ apps/
│  ├─ server/               # Fastify API + WS
│  └─ web/                  # Next.js dashboard
└─ DESIGN.md
```

---

## 12. Build Phases (suggested)

1. ✅ **Foundations**: core types, `DirectCollector` (serverStatus/replSetGetStatus/indexStats), 6–8 core checks, CLI to print findings for one source.
2. ✅ **Scan graph + store**: LangGraph health-scan graph, persist snapshots, health score + LLM summary (Anthropic/OpenAI/Ollama).
3. ✅ **API + minimal dashboard**: fleet overview + cluster detail + risk inbox.
4. ✅ **Atlas collector**: processes/measurements/alerts/advisor (HTTP Digest auth); fleet of mixed sources.
5. ✅ **Chat graph**: tool-calling agent + read-only tools + SSE streaming + checkpointer memory (custom model⇄tools loop with loop-guard + grounded-answer for small local models).
6. ✅ **Scheduler + live updates**: in-process per-source cadence (jitter + overlap guard), SSE event stream, per-source threshold config, live dashboard. (BullMQ/Redis + WebSocket are drop-in alternatives behind the same interfaces.)
7. ✅ **MCP collector + hardening**: MCP-backed collector (stdio/http), credential encryption at rest (AES-256-GCM), append-only audit log. Remediation remains advisory-only (drafted by the `suggest_remediation` chat tool, never executed).
8. ✅ **Capacity, bottleneck & cost intelligence** (8a–8d + Ops Manager collector all done) — see §14.
9. ✅ **Offline mode** (getMongoData + FTDC + mdiag + **mongod.log** import, unified auto-detect) — see §15.
10. ✅ **Risk register engine** (expert catalog + deterministic + LLM matching) — see §16.
11. ✅ **MongoDB agent skills** (vendored official skills, relevance-injected into LLM prompts) — see §17.
12. ✅ **Cached reports** (persist last capacity/risk report; scan-tied freshness; dashboard auto-display) — see §18.
13. ✅ **Deployment + capability model** (classify atlas/on-prem; additive inputs; derived capabilities; data-availability panel; supplement via `attachConnectivity`) — see §19.
14. ✅ **Per-node metrics charts** (inline-SVG FTDC time-series on the detail page, node selector, x-ray-parity metric extraction) — see §20.

> Note on the stack: the implementation uses Node's built-in `http` server (not
> Fastify), SSE (not raw WebSockets), a self-contained dashboard SPA served as a
> single HTML string (not Next.js), and an in-process scheduler (not BullMQ/Redis).
> The original choices below remain drop-in alternatives behind the same interfaces.

---

## 16. Phase 10 — Expert risk register engine

An expert-authored risk register (`risk register.xlsx`, 81 MongoDB risks with
level / probability / impact / description / recommendation) becomes a
cluster-analysis engine.

### 16.1 Pipeline
- **Convert** `scripts/convertRiskRegister.ts` → committed `src/risks/risks-catalog.json`
  (`npm run risks:convert "<file>"`). Reads xlsx directly (zip+XML, no deps);
  normalizes levels (0-High→high …). The .xlsx itself is gitignored.
- **Deterministic evaluators** (`src/risks/evaluators.ts`) match catalog risks by
  keyword and check them against `CollectedFacts` → detected / clear / unknown
  with evidence (EOL version, unused indexes, storage capacity, EAR, oplog window, …).
- **LLM-assisted matcher** (`src/risks/llmMatcher.ts`) cross-references the
  remaining "manual" risks against the facts → advisory "suggested" matches,
  schema-constrained, evidence-required, conservative (skips org/process risks).
- **Report** `HealthService.getRiskReport(sourceId)` → `RiskReport` with per-risk
  status (detected/clear/manual/suggested/unknown) + counts, sorted worst-first.

### 16.2 UX
- `GET /api/sources/:id/risks`; dashboard **Risk register** button → panel showing
  detected & suggested up front, with collapsible manual-review and clear/unknown.
- Works for any source with a scan — including **offline** (getMongoData) imports,
  so isolated clusters get the full expert risk assessment.

### 16.4 OS-level risks via mdiag
getMongoData can't see OS/kernel tunings, so `src/collectors/mdiag/parse.ts`
imports an **mdiag.sh --json** export → `OsFacts` (swappiness, max_map_count, TCP
keepalive, THP + defrag, read-ahead, ulimits, SELinux, NUMA, I/O scheduler).
`HealthService.importMdiag(raw, {sourceId})` **enriches an existing source's latest
scan** (or creates a standalone offline source) and re-scores, so the OS-tuning
register evaluators fire. Channels: dashboard **"Attach mdiag"** button,
`POST /api/sources/:id/mdiag/import`, `ps-agent import --mdiag --file … --source`.
Verified with a realistic mdiag fixture: attaching it moved 7 OS risks from
unknown→detected (SELinux enforcing, low fd, low max_map_count, swappiness 60,
keepalive 7200, readahead 4096, THP always), total detected 3→10.

### 16.3 Status — ✅ Done (catalog now mutable; see 16.5)
Verified against a real getMongoData export: 81 risks assessed. Deterministic
evaluators cover EOL version, unused indexes, storage capacity, EAR, oplog window,
**TLS-not-enforced** (`tlsMode`), **log redaction** (`redactClientLogData`),
majority read concern, NUMA, file descriptors, THP (the OS tunings fire when the
data is present; some need mdiag/Linux). Collectors now also capture
`serverParameters` (getParameter '*') and host `extra`.

**Register findings are unified into the normal findings/risk-inbox**: every
deterministically-*detected* register risk becomes a `register.<id>` Finding
(level→severity: high→critical, medium→warning, low→info) with the register's
recommendation. LLM-*suggested* matches stay exclusive to the on-demand Risk
Register view (no LLM on every scan). Example run: detected #62 TLS-not-enforced
(critical), #8 log-redaction-off (warning), #51 storage (info).

### 16.5 Mutable catalog store + management UI
The committed `risks-catalog.json` is now only the **seed**. A `CatalogStore`
(`src/store/catalogStore.ts`) holds the runtime-editable catalog:
- `FileCatalogStore` (`~/.ps-agent/risk-catalog.json`, atomic serialized writes) or
  `MongoCatalogStore` (collection `risk_catalog`), auto-selected by `createStores()`.
  Both **seed from the committed JSON on first use** (empty store), then own edits.
- `RiskCatalogEntry.enabled` gates assessment: `getRiskReport` and the active
  catalog (`setActiveCatalog`/`getActiveCatalog`, refreshed by the service) only
  include `enabled !== false`, so **disabled risks are skipped entirely** — no
  assessment, no finding.
- `HealthService` CRUD: `listCatalog`, `upsertCatalogEntry` (auto-ids new entries),
  `deleteCatalogEntry`, `setCatalogEntryEnabled`, `exportCatalog`,
  `importCatalog(data, "merge"|"replace")` (accepts `{risks:[…]}` or a bare array,
  drops entries missing id/name). Every mutation refreshes the active catalog + audits.
- API: `GET/POST /api/catalog`, `PATCH/DELETE /api/catalog/:id`,
  `GET /api/catalog/export` (JSON download), `POST /api/catalog/import?mode=merge|replace`.
- Dashboard **Risk catalog** tab: table with per-row enable/disable toggle,
  add/edit (modal)/delete, Export JSON, and Import. xlsx is converted offline via
  `npm run risks:convert` then imported as JSON.

---

## 15. Phase 9 — Offline mode via getMongoData

> **Model note:** this section describes offline mode as originally built (when a
> dedicated `kind: "offline"` existed). Per §19, there is no longer an "offline"
> kind — imports now attach to an **on-prem** deployment and are tracked via
> `attachments` markers; a source with no live connection is simply *import-only*.
> The import mechanics below are otherwise current.

Most production clusters are network-isolated; the agent can't dial them. The
MongoDB support script **getMongoData.js** is the canonical read-only diagnostic:
an operator runs it on one node and ships the resulting JSON log out. We import
that log to produce a full health + config + capacity snapshot — no connection.

### 15.1 What getMongoData provides
A JSON array of `{ section, subsection, output, host, ts }` entries, including:
- `server_info/server_status_info` → full `serverStatus()`
- `server_info/host_info` → **RAM, cores, OS** (hardware limits for utilization)
- `server_info/command_line_info` → auth/TLS/security
- `server_info/server_build_info`, `server_parameters`
- `shard_or_replicaset_info`, `replicaset_info/replica_status` → topology + repl
- `data_info/database_stats_(mb)`, `collection_stats_(mb)` → storage
- `data_info/index_stats`, `indexes` → index usage (unused/redundant)

### 15.2 Shared parser (reuse)
`src/collectors/getmongodata/parse.ts` turns a getMongoData array into
`CollectedFacts` (+ a `StorageFacts` + a host-limits object). Used by BOTH:
- the **offline importer** (kind: `offline`), and
- an **enhanced DirectCollector** (optionally runs the same admin commands —
  `hostInfo`, `dbStats`, `buildInfo` — to fill RAM/cores/limits for live sources).

### 15.3 Offline source + import
- New source `kind: "offline"` holding the imported snapshot id / metadata (no
  credentials). Importing a file creates/updates the source and persists a scan.
- Import channels: **dashboard upload**, `POST /api/sources/offline/import`
  (raw body = the log), and `ps-agent import --file getMongoData.log`.
- Capacity for offline = **point-in-time utilization** vs hostInfo RAM/cores +
  disk from dbStats/host; config/schema/index findings. No growth/days-until-full
  from a single export (would need multiple dated imports — future).

### 15.4 Notes
- getMongoData runs on one node → topology/repl come from that node's view.
- Parser is defensive: versions vary, sections may be missing/partial; degrade to
  warnings, never throw on a malformed entry.
- Offline snapshots never expire from scheduling (no scans run against them).

### 15.5 Offline capacity metrics via FTDC
getMongoData is a single point-in-time snapshot, so offline clusters had no
**time-series** for growth/utilization trends (that came only from the
Atlas/OpsManager metrics APIs). MongoDB's **FTDC** (Full-Time Diagnostic Data
Capture) fills this gap: mongod samples serverStatus + OS metrics ~once per second
into binary `diagnostic.data/metrics.*` files on the host. Shipping those files
out gives real CPU/memory/disk/IOPS history with no network access — the offline
equivalent of the metrics API.

**Decoder** (`src/collectors/ftdc/decode.ts`): pure, dependency-light reader of the
FTDC archive format (ref: mongo `db/ftdc/README.md`). A file is a stream of BSON
docs; type-0 = metadata (serverStatus/hostInfo reference), type-1 = a compressed
metric chunk. Each chunk's `data` = `uint32 uncompressedSize` + zlib payload, which
inflates to `referenceDoc | uint32 metricCount | uint32 deltaCount | varint block`.
The reference doc is sample 0; the block holds, metric-major, `deltaCount` deltas
per numeric leaf (plain unsigned varints over wrapping uint64 — **not** zig-zag —
with zero-runs RLE-encoded as `0, additionalCount`). We reconstruct an
`n × (1+deltaCount)` value matrix and per-sample wall-clock timestamps (the `start`
metric is itself a tracked Date). Uses `BSON` from the `mongodb` dep + `node:zlib`;
no new dependency. Validated against a real mongod 8.2 file and a synthetic
Linux-shaped chunk (CPU normalization, disk space, IOPS all exact).

**Parser** (`src/collectors/ftdc/parse.ts`): maps decoded chunks to
- `CollectedFacts` (version/hostInfo/serverStatus from the newest reference +
  latest sample) → a scan + health score, like getMongoData; and
- `MetricSeries[]` using the **canonical capacity keys** the engine understands:
  `CACHE_USED_BYTES` (WT cache, gauge), `SYSTEM_NORMALIZED_CPU_USER/_KERNEL`
  (cumulative `systemMetrics.cpu.*_ms` → %/core via windowed delta ÷ window ÷
  cores), `DISK_PARTITION_SPACE_USED/_FREE` (from `systemMetrics.mounts.<mount>`),
  `DISK_PARTITION_IOPS_TOTAL` (Σ `systemMetrics.disks.<dev>.{reads,writes}` rate),
  plus opcounter rates. OS-level CPU/disk only exist in FTDC on **Linux** (`/proc`);
  the serverStatus gauges (cache, connections, opcounters) are always present.

- **Rate windowing (important).** Several Linux FTDC counters — notably
  `systemMetrics.cpu.*_ms` and the per-disk counters — are jittery/non-monotonic at
  1 Hz, so naïve 1-second deltas produced garbage (CPU pegged at 100%, ~33 M ops/s
  IOPS). Two fixes (`windowedSeries` in `parse.ts`): (1) **never form a delta across
  an FTDC chunk boundary** — a new chunk's reconstructed first sample doesn't make a
  valid delta against the previous chunk's last sample and spikes; (2) compute rates
  over a sliding **~20 s window** (`PS_AGENT_FTDC_RATE_WINDOW_SEC`, default 20)
  **within** each chunk, mirroring x-ray's ~1/20 sampling, which averages the jitter
  out. After this, CPU reads ~2% median / tens-of-% peaks and IOPS/latency are
  realistic. Applies to `pushCpuNormalized`, `pushRate` (opcounters), `pushIopsTotal`,
  and `buildDiskOpsLatency`.

**Import — raw files stay local; only downsampled series are stored.** Raw FTDC is
large (~3,200 metrics × 1 sample/s × N nodes → GBs). We deliberately do **not** copy
it into the agent store; we decode it, extract a curated set of ~22 capacity series,
and **downsample each series to 5-minute buckets** (`src/collectors/ftdc/downsample.ts`)
before it reaches the metric store.

- **Why downsample:** FTDC samples ~1 Hz — far finer than needed. Full per-second
  import would store ~85 M points **per node** per 90 days; 5-minute buckets bring it
  to ~26 K/series (~130 MB/cluster for 6 nodes), with no analytical loss. (Earlier
  the default was hourly; 5-minute was chosen for more readable charts — still ~300×
  sparser than raw and far sparser than x-ray's ~1/20 read sample.)
- **Aggregation per series type** (`aggForMetric`): gauges (cache fill/dirty %,
  memory, disk-used/free, connections) → **mean** per bucket; spiky rate series (CPU,
  IOPS, disk ops/latency, opcounters) → **max** per bucket, so the engine's p95 still
  reflects real peaks; member-state → **last** (categorical). Bucket timestamps are
  floored, so re-importing overlapping files stays idempotent (same bucket ts →
  merge-by-ts). Bucket width defaults to **5 minutes**, overridable via
  `PS_AGENT_FTDC_BUCKET_SECONDS` (e.g. `3600` to minimize storage).

Two entry points:

- `HealthService.importFtdcFiles(filePaths, {name, sourceId})` — the scalable path
  (CLI + bundle). Files are **decoded in parallel across worker threads**
  (`src/collectors/ftdc/ftdcPool.ts` + `worker.ts`), mirroring x-ray's multi-core
  FTDC reader: each worker runs the single-threaded `parseFtdc` on one file and
  posts back only the **compact** result (facts + the ~11 curated series, never the
  raw per-sample matrices). Results are handled as each file completes, so
  `appendPoints` runs and buffers are freed incrementally — a multi-GB, many-file
  import is bounded by CPU across cores instead of one, and stays within bounded
  memory. Worker count = `PS_AGENT_FTDC_WORKERS` (default min(4, cores−1)); falls
  back to in-process sequential decode if worker threads are unavailable. The
  worker entry resolves as `.ts` under tsx (dev, with the tsx loader passed via
  `execArgv`) or `.js` in dist. All nodes map to a **single** offline source; each
  node keeps its own `processId` (host:port) series, and capacity rolls up across
  nodes via the store's busiest-node max aggregation.
- `HealthService.importFtdc(buffer, {name, sourceId})` — single in-memory buffer,
  used by the HTTP upload route (bounded by one uploaded file).

Both are idempotent (points merged by timestamp), so re-importing overlapping
files — or a whole `diagnostic.data` directory spanning days — is safe. With a
`sourceId` the import **enriches** that source (keeps a getMongoData scan's richer
topology/storage, layers in FTDC hostInfo + metrics) — so the recommended flow is
import getMongoData first (topology/config/risks), then attach FTDC (capacity
trends).

**Provenance (metadata only, no bytes).** Each import appends an event to
`source.ftdcProvenance` — `{ at, input, filesProcessed, nodes[],
metricPointsAdded, coveredFrom/To }` — and rolls up per-node coverage
(`nodes[host:port] = { from, to, lastImportedAt }`, earliest→latest across
imports; events capped to the most recent 50). This lets operators see *what*
history has been ingested per node and spot gaps to re-import, without the agent
ever storing the raw FTDC. It rides through `redactSource`, so `GET /api/sources`
exposes it; the dashboard detail view shows a per-node `from→to` summary.

Channels: dashboard **"Attach FTDC"** (single-file binary upload),
`POST /api/sources/:id/ftdc/import` (+ standalone `/api/sources/ftdc/import`),
and `ps-agent import --ftdc --file <diagnostic.data dir | metrics.* | dir1,dir2>`
(a directory, a single file, or comma-separated paths — one per node).
This unlocks **growth + days-until-full + utilization trends offline**, whereas
getMongoData alone gives only point-in-time utilization (§15.3).

### 15.5 Status — ✅ Done
- `parse.ts` handles canonical EJSON (`$numberInt/$numberLong/$numberDouble/$oid/$date`)
  and the `ERROR:` footer; verified against a **real 551 KB getMongoData export**
  (MongoDB 8.2): serverStatus, hostInfo (cores/RAM/OS), replSet, dbStats→storage,
  index_stats→index usage. Findings fired: auth/TLS/EOL, unused + redundant indexes,
  index-bloat.
- `HealthService.importGetMongoData(raw)` → offline source + persisted scan;
  `scanSource` re-scores the last import for offline sources.
- Channels: dashboard **file upload** (Offline option), `POST /api/sources/offline/import`
  (raw body), `ps-agent import --file <log>`.
- DirectCollector enhanced with `hostInfo` (RAM/cores) too → live self-managed sources
  get real capacity limits (verified: 12 cores / 24 GB).

### 15.6 Unified diagnostics import (any mix, auto-detected)
The three offline inputs have different scopes — getMongoData is **cluster-level**
(one file), mdiag and FTDC are **node-level** (one file per node, and FTDC often
many files per node). Attaching them one-by-one via separate typed buttons was
painful for a real multi-node bundle. The unified importer removes that friction:
the user drops a **whole folder** (or multi-selects any mix of files) and the
agent figures out the rest.

- **Content sniffer** (`src/collectors/detect.ts`): classifies each file by its
  bytes — `getMongoData` / `mdiag` / `ftdc` / `mongodLog` / `unknown`. FTDC is
  identified by its precise binary signature (first BSON doc begins with an `_id`
  UTC-datetime element — `09 5f 69 64 00`), which cleanly excludes WiredTiger `.wt`
  and other binaries; the JSON-array kinds (getMongoData/mdiag) are told apart by
  their **section vocabulary** (getMongoData: `server_status_info`/`data_info`/…;
  mdiag: `sysctl`/`transparent_hugepage`/`read_ahead_kb`/…) with mdiag's
  `script: "mdiag.sh"`/`rc` structural marker as the tiebreaker — NOT by a `host`
  field, which real-world files of both kinds carry (an earlier `host`-based
  heuristic misclassified production mdiag v2.x as getMongoData); a **mongod.log**
  is recognized as NDJSON whose first lines are log-entry objects (`{t,s,c,msg}`).
  A 4 KiB prefix may be inconclusive for the JSON kinds, so `importBundle`
  re-classifies them from the full file (they're small; FTDC is never fully read
  to classify).
- **`HealthService.importBundle(files[], {name, sourceId})`**: classifies every
  file, then ingests in dependency order — **getMongoData first** (sets the
  cluster source + topology/config), then **mdiag** (per-node OS facts merged onto
  the cluster scan; bootstraps one if needed), then **mongod.log** (per-node
  operational signals merged onto the scan), then **FTDC** (per-node metric series,
  streamed from disk via `importFtdcFiles`). Everything lands in **one cluster
  source**; nodes stay distinct via per-node `processId` series and per-node
  provenance. Returns a per-file classification + roll-up (counts, nodes, points).
- **Node-identity reconciliation** (`src/core/nodeIdentity.ts`): the sources
  name the same box differently — getMongoData member names (`host:port`, usually
  FQDN), FTDC (`host:port` or bare host), mdiag + mongod.log (bare hostname). A reconciler seeded
  with the authoritative `replSetStatus.members[].name` roster collapses each
  observed id onto its canonical member name (exact → host-match → FQDN/short-host,
  case-insensitive; confident matches only, else the id stays its own node). So the
  import roll-up lists each physical node **once** instead of 2–3 times. (Stored
  FTDC series keep their raw `processId`; reconciliation is for the node roster /
  display and capacity already rolls up across processes.) The dashboard's per-node
  FTDC provenance panel applies the same matcher client-side (seeded from the
  current scan's replica-set members), collapsing raw `host:port` provenance keys
  onto canonical names and merging their coverage ranges.
- **Channels:**
  - Dashboard: a single **"Import diagnostics…"** action (and the "Offline
    (import diagnostics)" add-deployment option) — multi-file or whole-folder
    (`webkitdirectory`) upload, one `multipart/form-data` request.
  - HTTP: `POST /api/sources/import` (new source) and
    `POST /api/sources/:id/import` (enrich) — multipart. A tiny dependency-free
    streaming multipart parser (`src/server/multipart.ts`) writes each part to a
    **temp file**, so even a multi-GB upload stays bounded and FTDC is streamed by
    path (temp files removed after).
  - CLI: `ps-agent import --dir <folder>` (recurses, skips dbpath noise like
    `*.wt`/journal/lock) — the easiest path for large on-disk bundles. A directory
    passed to `--file` without a type flag is treated the same way.
- The old typed endpoints/flags (`--mdiag`, `--ftdc`, `--log`,
  `/api/sources/*/{mdiag,ftdc,log}/import`) remain for scripted/single-file use; the
  unified path is the default UX.

### 15.7 mongod.log operational signals
getMongoData/FTDC are point-in-time or metric-only; neither captures *events* that
happened on a node. A **mongod.log** (structured JSON, 4.4+) does. `parseMongodLog`
(`src/collectors/mongodlog/parse.ts`) reads the newline-delimited JSON lines
(`{t,s,c,id,ctx,msg,attr}`) and distils two outputs:

- **`LogFacts`** (on `CollectedFacts.log`): error/fatal/warning counts, process
  startups & unclean shutdowns, replica-set elections (de-duplicated to the "start"
  line) & state changes, WiredTiger/storage warnings, assertions, connection churn,
  slow-query count, covered time window, hostname & version from the startup banner,
  and the top-N most frequent error messages.
- **Slow-query lines** → aggregated (reusing `aggregateSlowQueries`, §14.3) into
  per-namespace `QuerySignal[]` stored on `source.logQuerySignals` (compact,
  redaction-safe — no query values).

The per-line logic lives in a shared `MongodLogAccumulator` so both entry points
reuse it: `parseMongodLog(raw)` (in-memory string) and `parseMongodLogFile(path)`,
which **streams the file line-by-line** via `readline` over a read stream (constant
memory). The bundle importer uses the streaming path (`importMongodLogFile`) — real
production logs are hundreds of MB each, so reading them fully into a string would
spike the heap.

`HealthService.importMongodLog(raw, {sourceId})` enriches the latest scan (or
bootstraps a standalone offline source) and re-scores. New **`log.*` checks**
(`src/checks/log.ts`) turn the facts into findings: `log.fatal-errors` (critical),
`log.error-rate`, `log.frequent-elections`, `log.unclean-shutdown`,
`log.storage-warnings`. For capacity, `getCapacityReport` falls back to
`source.logQuerySignals` when a source has no Atlas/OM Performance-Advisor feed, so
offline clusters get query-bottleneck analysis too. Only the structured JSON format
is supported (not pre-4.4 plaintext). Channels: dashboard import, CLI
`ps-agent import --log --file mongod.log [--source <id>]`, `POST
/api/sources/:id/log/import`, and the unified bundle (auto-detected).

---

## 17. Phase 11 — MongoDB agent skills

The official MongoDB [agent skills](https://github.com/mongodb/agent-skills)
(Apache-2.0) are **vendored** under `src/skills/catalog/` (copied into `dist/` at
build) so the deployment-health agent applies the same MongoDB expertise that
coding agents get.

- **Loader/selector** (`src/skills/index.ts`): a dependency-free parser reads each
  `SKILL.md`'s YAML frontmatter (`name`, `description`) and body, builds a registry,
  and for a given context selects the most relevant skill(s) by token overlap
  (`selectSkills`), then renders their guidance into a system-prompt fragment
  (`renderSkillsPrompt`). Best-effort: returns "" when nothing is relevant.
- **Injection points** (all place skills **after** the grounding rules so
  "don't invent facts" wins):
  - **Scan narration** (`correlate.ts`) — context = the findings.
  - **Chat agent** (`chatGraph.ts`) — context = the user's latest question.
  - **Risk matcher** (`llmMatcher.ts`) — context = the candidate risks.
- No MCP server or network is required; the catalog is read from disk. If the
  catalog is missing, injection is simply skipped.

---

## 18. Phase 12 — Cached capacity/risk reports

Capacity and risk-register reports are expensive (live Atlas/OM API calls, metric
aggregation, and — for risks — an LLM round-trip), so the last report of each kind
is persisted and reused.

- **Store** (`ReportStore`, `src/store/store.ts`): `FileReportStore`
  (`~/.ps-agent/reports/<sourceId>_<kind>.json`, atomic writes) or
  `MongoReportStore` (collection `reports`, `_id = sourceId|kind`, upsert), selected
  by `createStores()`. A `CachedReport` records `computedAt`, `basedOnScanAt`, and
  the report payload.
- **Freshness is tied to the latest scan.** `getCapacityReport`/`getRiskReport`
  gained options: default (serve cache if its `basedOnScanAt` equals the current
  latest scan, else recompute + re-cache), `{refresh:true}` (force recompute), and
  `{cachedOnly:true}` (return the cached report or `null`, never compute). Responses
  carry `cached` + `cachedAt` metadata. The cache is cleared on source removal.
- **API:** `GET /api/sources/:id/{capacity,risks}` supports `?refresh=1` and
  `?cachedOnly=1` (→ `204` when nothing is cached).
- **Dashboard:** opening a deployment auto-loads the cached report (`?cachedOnly=1`);
  if present it renders instantly with a *"Last computed …"* line + **Refresh**
  button, otherwise a **Compute now** button (so expensive work is never triggered
  silently on open).

---

## 19. Phase 13 — Deployment classification + capability model

Previously a single `kind` enum (`direct|atlas|mcp|opsmanager|offline`) conflated
*hosting*, *collection method*, and *liveness*, forcing a mutually-exclusive form
and a `switch`-based collector dispatch. This phase replaces it with a hosting
classification plus a derived capability model.

- **`deployment: "atlas" | "on-prem"`** is the only hard type. Allowed inputs per
  type (`ALLOWED_INPUTS`): Atlas → connection string, MCP, Atlas Admin API,
  mongod.log; on-prem → those (OM instead of Atlas) plus FTDC, getMongoData, mdiag.
  All optional and additive.
- **`src/core/capabilities.ts`** (`availabilityOf`) is the single source of truth:
  from the present inputs + latest-scan facts + whether metric series exist, it
  derives `Capabilities` and the available/missing input lists (each missing one
  paired with its consequence). Runtime gating and the UI both read it.
- **Collector dispatch** (`collectorFor`) now selects from available inputs
  (MCP → Direct → Atlas → Ops Manager); `canScanLive(source)` replaces the
  `kind === "offline"` test. Import-only sources re-score their last import.
- **Registration & imports** set `deployment` (imports default to on-prem and record
  an `attachments` marker). `registerSource` keeps all provided inputs; no kind
  precedence collapse.
- **Supplement path:** `attachConnectivity(id, {...})` →
  `PATCH /api/sources/:id/connectivity` attaches/updates connectivity on an existing
  source (Atlas-only / OM-only inputs rejected for the wrong type; secrets
  re-encrypted; a history backfill kicks off if new API creds unlock it).
- **Form:** one additive form — pick Atlas/on-prem, then fill any of connection
  string, MCP, the matching admin API, and/or import files. At least one input is
  required.
- **Detail page:** a **Data availability** panel (`GET /api/sources/:id/capabilities`)
  lists attached inputs, missing inputs + consequence, and a supplement action
  (import a file, or add credentials).

---

## 20. Phase 14 — Per-node metrics charts (x-ray-style)

The capacity panel reduces series to scalars; this phase surfaces the **raw
per-node FTDC time-series** as charts on the detail page, inspired by the x-ray
FTDC report. Two parts:

**A — serve + chart what's stored.**
- **Store:** `MetricSeriesStore.listSeries(sourceId)` → distinct `(processId,
  metric)` pairs (file + Mongo), so the UI knows which nodes have which metrics.
- **Service:** `getNodeMetrics(sourceId, {processId?, metrics?, since?})` →
  `{ nodes, metrics, series[processId][metric] = [[tsMs,value],…] }`. Reads series
  **per processId** (the capacity path uses the busiest-node collapse; this one
  does not).
- **API:** `GET /api/sources/:id/metrics` (`?processId=`, `?metrics=A,B`, `?days=N`).
- **Dashboard:** a `#metrics-panel` between capacity and risk. `loadMetrics` fetches
  the bundle; a **node selector** (defaults to the PRIMARY via `replSetStatus`
  state + `reconcileNodeName`) switches nodes. Charts are **inline SVG**
  (`sparkline()` builds `<path>` area+line, with warn/critical dashed guide lines
  for `%` metrics) — no external JS/CDN, preserving the self-contained-HTML design.
  Metrics are grouped **Workload / Ops & latencies / Performance**, each row showing
  peak / average.

**B — extend FTDC extraction for x-ray parity.** `buildSeries` (`ftdc/parse.ts`)
now also emits (the raw paths already decode): cache **fill %** / **dirty %**
(`pushRatioPct`), **system memory utilization** (1 − MemAvailable/MemTotal),
**memory fragmentation** (tcmalloc heap vs allocated, `pushFragmentationPct`), **CPU
iowait**, **disk read/write ops** (rate) and **read/write latency** (Δtime/Δops,
`buildDiskOpsLatency`), and the **getmore/command** opcounters — taking FTDC from
~11 to ~22 per-node series. `aggForMetric` buckets the new spiky rate/latency series
as **max** (peaks survive) and the `%`/byte gauges as **mean**. Re-importing FTDC
populates the new charts; already-imported data shows the original ~11.

**C — timeline + tooltips.**
- **Member-state timeline:** `buildMemberStateSeries` emits one `MEMBER_STATE_<idx>`
  step series per replica-set member (value = state code; `units` carries the member
  NAME from the reference doc so the UI can label rows). It buckets with a new
  `"last"` aggregation (state codes aren't averageable). The dashboard renders a
  per-member band timeline (PRIMARY/SECONDARY/… colored over time) under the charts.
- **Hover tooltips:** each `sparkline` wraps its SVG in a positioned container; a
  `mousemove` handler maps the cursor x → nearest point by time and shows a vertical
  guide line, a dot, and a tooltip with the formatted value + timestamp. Chart data
  is kept in a per-render registry (`_sparkData`) rather than re-serialized into the
  DOM. Still dependency-free.
- **Node role/config tags:** each node-selector pill and member-state row is tagged
  with the member's **role** (PRIMARY/SECONDARY/HIDDEN/ARBITER/DOWN) — matched from
  the scan's `replSetStatus.members` via `reconcileNodeName` (FTDC uses short
  `host:port`, the roster FQDN). When a **getMongoData** export is present, members
  also show config badges (`v<votes>`, `p<priority>`, hidden, arbiter). Role/state is
  always available (FTDC member docs); votes/priority/hidden/arbiterOnly come only
  from `replSetGetConfig`, so the getMongoData parser (`parseReplSetStatus`) was
  extended to **merge `replica_set_config`** into each member (keyed by host/`_id`) —
  previously votes/priority defaulted to 1, masking e.g. hidden/zero-vote members.
  This also feeds the existing replication risk checks with true values.

**Scan-now semantics (clarified).** For a source with no live input, `scanSource`
**re-analyzes**: it re-runs `scoreFactsToScan` on the last import's stored facts and
**persists** the fresh scan (it does not re-read raw files — those aren't stored;
dashboard uploads are temp files removed after import). The detail-page button
relabels to **"Re-analyze"** when `capabilities.liveScan` is false. Re-reading files
(e.g. after a parser improvement) is a deliberate re-import, not a routine scan — so
raw file paths are intentionally not stored on the source.

---

## 14. Phase 8 — Capacity, Bottleneck & Cost Intelligence

Answer the three questions operators ask most:
1. **Where/what is the performance bottleneck?**
2. **How fast is data growing? When must I scale (up/out), and by what factor?**
3. **What's current utilization? Is there room for cost optimization (scale down)?**

### 14.0 Design principles (unchanged)
- **Measure vs reason.** Collectors gather facts; a deterministic **capacity/bottleneck
  engine** computes signals, growth rates, projections, and utilization; the LLM only
  narrates. No LLM-invented numbers.
- **Priority: Atlas + Ops Manager** (historical metrics API + known tier/disk limits).
  Direct/MCP sources get a lighter version built from our own accumulated scan history.
- **Incremental sub-phases** (8a–8d), each shippable and verified.

### 14.1 New data we collect (richer collectors)
**Atlas / Ops Manager (primary):**
- **Historical measurements** — pull `granularity=PT1H, period=P30D` (configurable) for:
  CPU (system/normalized), memory/resident, cache dirty/used, connections, tickets,
  query targeting, opcounters, **disk space free/used**, **disk IOPS & latency**,
  global-lock queue, oplog window, replication lag.
- **Cluster spec** — `GET /clusters/{name}`: `instanceSize` (M30…), `diskSizeGB`,
  `diskIOPS`, `nodeCount`, RAM-per-tier (from a static tier table), auto-scaling config
  (min/max, enabled). This gives the **limits** for utilization %.
- **Targeted log/profiler signals** — slow queries, COLLSCANs, lock/wait, elections
  (from Performance Advisor slow-query shapes + optional log scan). Extract signals,
  don't store raw logs.

**Direct / MCP (secondary):** no retroactive history, but each scheduled scan appends
key metrics to our time-series store, so trends build up over time. Tier/disk limits
are unknown → utilization shown as "unbounded" with caveats.

### 14.2 Time-series store (new)
- New collection/file store `metric_series`: `{ sourceId, ts, metric, value }` with a
  compound index `{ sourceId, metric, ts }` and a TTL (configurable, default 90d).
- Backfill from the Atlas/OM API on first scan; append our own samples every scan.
- Shared `MetricSeriesStore` interface → file + MongoDB implementations (like the others).

### 14.3 Capacity & bottleneck engine (deterministic, new)
Pure functions over the series + cluster spec:
- **Growth analysis** — linear + EWMA regression on disk-used and data-size; report
  bytes/day, %/week, R² (confidence). Project **days-until-full** vs `diskSizeGB`.
- **Working-set / memory pressure** — cache-used vs RAM, page-fault/eviction trend →
  signals the working set is outgrowing RAM (scale-up driver).
- **Scale signals & factor** —
  - *Scale UP* (bigger tier) when CPU/memory/cache/ticket saturation is sustained;
    factor = headroom needed to bring peak utilization under target (e.g. 70%).
  - *Scale OUT* (shard/add nodes) when single-node write throughput / lock queue is the
    ceiling, or disk/throughput can't grow further on the tier.
  - *Scale DOWN* (cost) when p95 utilization of CPU/mem/disk/IOPS is well under target
    with low growth → recommend the next-smaller tier + projected headroom.
- **Bottleneck ranking** — score each resource (CPU, memory/cache, disk space, disk
  IOPS/latency, connections/tickets, lock queue, query targeting) by how close to its
  limit and its trend; the top one(s) = the bottleneck, with evidence (metric, peak,
  limit, when).
- **Utilization snapshot** — current + p95 per resource as % of limit.

Output: typed `CapacityReport` (growth, projections, scale recommendation + factor,
utilization, ranked bottlenecks) stored on the scan, with `evidence` on every claim.

### 14.4 Agent & UX
- **Chat tools** (read-only): `getCapacityReport(sourceId)`, `getMetricTrend(sourceId, metric, window)`,
  `getBottlenecks(sourceId)`, `getUtilization(sourceId)`. Prompt updated so the three
  FAQ questions route to these.
- **Dashboard**: a **Capacity** tab on cluster detail — utilization gauges vs limits,
  disk-growth sparkline with projected-full date, ranked bottlenecks, and a scale
  recommendation card (up/out/down + factor + rationale).
- **New checks** surface as findings too: `capacity.disk-projected-full`,
  `capacity.scale-up-recommended`, `capacity.underutilized` (cost), `bottleneck.<resource>`.

### 14.5 Dashboard form change (you requested)
The Add-deployment form **encourages the API key**: for direct/MCP sources, show an
optional "Atlas/Ops Manager API (for trends & capacity)" expander (project ID + public/
private key, or OM base URL + key). When provided, the source is enriched with the
historical-metrics path and the Capacity tab unlocks. A hint explains trends/capacity
need the admin API.

### 14.6 Sub-phases
- **8a — Historical metrics + time-series store.** ✅ Done. AtlasCollector pulls
  cluster spec (`GET /clusters/{name}`, enriched via the tier table) + N-day host/disk
  history (budgeted via `planHistory`). `MetricSeriesStore` (file + Mongo, idempotent
  upsert, TTL, cross-process max aggregation). History collected out-of-band on each
  scan and appended. Verified live: M10 spec + 63 series + 22d of DISK_PARTITION_SPACE_USED.
- **8b — Capacity/growth + utilization engine.** ✅ Done. Deterministic engine
  (`src/capacity/`): OLS linear trend + EWMA + percentile stats; disk-growth analysis
  (bytes/week, %/week, **days-until-full** + projected date, R² confidence); utilization
  vs tier limits (CPU/memory/disk/IOPS, current + p95); scale recommendation
  (up/out/down + **factor** + target tier + drivers + confidence) including scale-down
  (cost); basic bottleneck ranking; `capacityFindings()` → Finding[]. Exposed via
  `HealthService.getCapacityReport(sourceId)`. Verified on synthetic data (20-day
  days-until-full, scale-up→M40, scale-down→M40) and live Atlas (M10, healthy band → no
  action; smallest-tier floor respected).
- **8c — Bottleneck diagnosis.** ✅ Done. Pulls Performance Advisor slow-query logs
  (`AtlasCollector.collectSlowQueryLines`), parses log lines into per-namespace
  `QuerySignal`s (`slowQuery.ts`: COLLSCAN count, scanned-per-returned ratio, max
  duration; excludes internal/automation-agent noise), and merges query signals with
  resource signals in the engine's ranked `bottlenecks` (`kind: "resource" | "query"`).
  Adds a `bottleneck.slow-queries` finding. Verified live: top bottleneck correctly
  identified as `test.ttlTrigger_delete_hist` (6 COLLSCANs, 145× scanned-per-returned).
- **8d — UX.** ✅ Done. `GET /api/sources/:id/capacity`; chat tools `get_capacity`,
  `get_bottlenecks`, `get_metric_trend` with a keyword→tool routing prompt AND a
  deterministic **intent-prefetch** node (small local models under-call tools, so when a
  question clearly maps to capacity/bottleneck and a sourceId resolves, the tool runs
  up-front and the grounded answer uses it); dashboard **Capacity** panel (scale card,
  disk-growth, utilization gauges, ranked bottlenecks); form **"Add Atlas API for trends
  & capacity"** expander on direct/MCP sources. Verified live: all three FAQ questions
  answered correctly (bottleneck → `test.ttlTrigger_delete_hist`; growth/scale; utilization/cost).
- ✅ **Ops Manager collector** — mirrors Atlas using OM's Public API
  (`/api/public/v1.0`, `application/json`, `/hosts` instead of `/processes`,
  same HTTP Digest auth → reuses `DigestClient`). Pulls hosts, host+disk history,
  and slow-query logs; normalizes OM metric names (`NORMALIZED_SYSTEM_CPU_*` →
  canonical) so the **same capacity/bottleneck engine** works unchanged. No
  cluster-tier spec for self-managed hosts → utilization shown "unbounded".
  Registered via `opsManager { baseUrl, projectId, publicKey, privateKey }`
  (dashboard form + API); secret encrypted at rest. Verified end-to-end against
  a mock OM server (digest handshake, 14 history series, days-until-full=10,
  slow-query COLLSCAN signal, full service registration→scan→capacity path).

### 14.6b Confirmed decisions
- **Atlas-first**, Ops Manager as a fast-follow (mirrors the Atlas path).
- **History window default = 90 days** at `PT1H`, but **bounded**: a `maxDataPoints`
  budget per metric (default ~2200 ≈ 90d×24h) and a cost/size estimate computed *before*
  backfill. If the requested window × granularity × metrics would exceed the budget, the
  collector **auto-coarsens the granularity** (PT1H→PT6H→P1D) and/or shortens the window,
  and records a `warnings[]` entry telling the user what was reduced and why. Env/source
  overrides: `PS_AGENT_HISTORY_DAYS`, `PS_AGENT_HISTORY_GRANULARITY`, `PS_AGENT_HISTORY_MAX_POINTS`.
- **Tier table hardcoded** for now (instanceSize → RAM/default IOPS), updatable in code.

### 14.7 Risks / notes
- **RAM-per-tier** isn't in the measurements API → maintain a small static Atlas tier
  table (instanceSize → RAM, default IOPS). Keep it updatable; mark unknowns.
- **Atlas rate limits** (Monitoring scope ~300/refill 100/60s) → batch metric requests,
  cache spec, backoff; history pulls are the heaviest call.
- **Projections are estimates** — always show confidence (R²) and a caveat; never a
  guarantee.
- **Direct/MCP** utilization is limited without tier info; be explicit about that.

---

## 13. Risks / Open Questions
- Atlas API rate limits for large fleets → cache + batch + backoff.
- Self-managed metric *trends*: addressed via **FTDC import** (offline, §15.5) and
  the **Ops Manager** collector (§14); live direct/MCP sources still accumulate
  trends from each scheduled scan into `metric_series`.
- Health-score weighting needs tuning with real deployments.
- Multi-tenant credential isolation if this becomes a hosted product.
- mongod.log parsing supports the structured JSON format only; pre-4.4 plaintext
  logs would need a separate line parser (future).
