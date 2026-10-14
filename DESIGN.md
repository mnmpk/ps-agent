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

A deployment is registered as a **Source**. One interface, three backends.

```ts
type SourceKind = "direct" | "atlas" | "mcp";

interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  // direct
  connectionString?: string;        // stored encrypted at rest
  // atlas
  atlas?: { projectId: string; publicKey: string; privateKey: string; clusterName?: string };
  // mcp
  mcp?: { transport: "stdio" | "http"; command?: string; url?: string };
  tags?: string[];
  createdAt: Date;
}

interface Collector {
  topology(): Promise<Topology>;            // RS/sharded members, versions, roles
  serverStatus(): Promise<ServerStatus>;    // per node
  replSetStatus(): Promise<ReplSetStatus>;  // lag, health, elections
  hostMetrics(window): Promise<MetricSeries[]>; // CPU, mem, disk, conns, opcounters
  indexStats(opts): Promise<IndexUsage[]>;  // unused/duplicate indexes
  alerts?(): Promise<ExternalAlert[]>;      // Atlas-only
  advisor?(): Promise<AdvisorSuggestion[]>; // Atlas Performance Advisor
}
```

- **DirectCollector** — `mongodb` Node driver. Uses `admin` db commands. Needs a user with `clusterMonitor` role (read-only monitoring). For metrics trends it samples `serverStatus` on an interval and diffs counters.
- **AtlasCollector** — `@mongodb-js/atlas` / `atlas-sdk`. Pulls `/processes`, `/processes/{id}/measurements`, `/alerts`, Performance Advisor suggestions. Respects rate limits (Monitoring scope: 300 capacity, refill 100/60s → batch + cache).
- **MCPCollector** — wraps the MongoDB MCP server as LangChain tools; useful when the agent needs flexible, model-driven exploration rather than fixed queries.

> **Credential handling:** connection strings / Atlas keys stored encrypted (e.g. libsodium sealed box, key from env/KMS). Never logged. Redact in all tool outputs passed to the LLM.

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

```
sources            // registered deployments (creds encrypted)
scans              // { sourceId, startedAt, status, score, summary }
findings           // { scanId, sourceId, checkId, severity, evidence, rank }
metric_samples     // short-term series for sparklines / trend (TTL index)
chat_threads       // LangGraph checkpoints
audit_log          // who connected what, which tools ran
```

- `metric_samples` gets a **TTL index** (e.g. 14 days) to bound growth.
- `findings.evidence` stores the exact numbers so the UI/LLM cite real data.

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
- Self-managed metric *trends* require sampling (no built-in TSDB) → interval collector + TTL store, or integrate Prometheus if present.
- Health-score weighting needs tuning with real deployments.
- Multi-tenant credential isolation if this becomes a hosted product.
