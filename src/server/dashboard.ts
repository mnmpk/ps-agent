/**
 * Returns the single-page dashboard. Intentionally a self-contained HTML
 * document (no bundler/build step) for this minimal phase — the design's
 * Next.js/React app replaces this later. All data comes from the JSON API.
 */
export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ps-agent · MongoDB Health</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --panel2: #1e222e; --border: #2a2f3c;
    --text: #e6e8ee; --muted: #9aa3b2; --green: #3fb950; --amber: #d29922;
    --red: #f85149; --cyan: #39c5cf; --accent: #5b8cff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { padding: 16px 24px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: var(--muted); font-size: 12px; }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; }
  .tab { padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel); color: var(--muted); cursor: pointer; }
  .tab.active { color: var(--text); border-color: var(--accent); background: var(--panel2); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; cursor: pointer; transition: border-color .15s; position: relative; }
  .card:hover { border-color: var(--accent); }
  .card .card-x { position: absolute; top: 10px; right: 12px; color: var(--muted);
    font-size: 13px; line-height: 1; opacity: 0; transition: opacity .15s; }
  .card:hover .card-x { opacity: 1; }
  .card .card-x:hover { color: var(--red); }
  .card h3 { margin: 0 0 4px; font-size: 15px; padding-right: 16px; }
  .card .host { color: var(--muted); font-size: 12px; margin-bottom: 12px; word-break: break-all; }
  .score { display: flex; align-items: baseline; gap: 8px; }
  .score .val { font-size: 32px; font-weight: 700; }
  .score .max { color: var(--muted); font-size: 13px; }
  .pills { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); }
  .pill.crit { color: var(--red); border-color: var(--red); }
  .pill.warn { color: var(--amber); border-color: var(--amber); }
  .pill.info { color: var(--cyan); border-color: var(--cyan); }
  .sev-crit { color: var(--red); } .sev-warn { color: var(--amber); }
  .sev-info { color: var(--cyan); } .sev-ok { color: var(--green); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
  .badge.crit { background: rgba(248,81,73,.15); color: var(--red); }
  .badge.warn { background: rgba(210,153,34,.15); color: var(--amber); }
  .badge.info { background: rgba(57,197,207,.15); color: var(--cyan); }
  .badge.ok { background: rgba(63,185,80,.15); color: var(--green); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
  button.action { background: var(--accent); color: #fff; border: 0; border-radius: 6px;
    padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button.action:disabled { opacity: .5; cursor: default; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 14px; cursor: pointer; }
  input, select { background: var(--panel2); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  .form { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .form input.uri { flex: 1; min-width: 320px; }
  .addbox { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px; margin-bottom: 20px; }
  .addrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .addfields { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .addfields input.uri { flex: 1; min-width: 300px; }
  .addsection { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 10px; }
  .addsection-t { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .addsection-t .muted { font-weight: 400; }
  .finding { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .finding .ftitle { font-weight: 600; display: flex; gap: 8px; align-items: center; }
  .finding .fdetail { color: var(--muted); margin-top: 4px; }
  .evidence { margin-top: 8px; }
  .evidence summary { cursor: pointer; color: var(--accent); font-size: 12px; }
  .evbody { margin-top: 8px; padding: 10px 12px; background: var(--panel2); border-radius: 6px; font-size: 12px; }
  .evk { color: var(--muted); font-weight: 600; }
  .evrow { margin: 2px 0; }
  .evlist { margin: 4px 0 8px; padding-left: 18px; }
  .evlist li { margin: 2px 0; word-break: break-all; }
  /* capacity */
  .scalecard { border-radius: 8px; padding: 12px 14px; border: 1px solid var(--border); background: var(--panel2); }
  .scalecard.up { border-left: 3px solid var(--amber); }
  .scalecard.down { border-left: 3px solid var(--green); }
  .scalecard.none { border-left: 3px solid var(--border); }
  .grow { display: grid; grid-template-columns: 180px 1fr 160px; gap: 10px; align-items: center; margin: 5px 0; font-size: 13px; }
  .grow .glabel { color: var(--muted); }
  .grow .gval { color: var(--muted); font-size: 12px; text-align: right; }
  .gbar { background: var(--panel2); border-radius: 5px; height: 10px; overflow: hidden; }
  .gbar > div { height: 100%; }
  .bnrow { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 13px; }
  .mtable { width: 100%; border-collapse: collapse; }
  .mtable td { padding: 4px 8px; border-top: 1px solid var(--border); vertical-align: middle; }
  .mtable .mlabel { width: 200px; font-size: 13px; }
  .mtable .mstat { width: 140px; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .mtable .mthr { width: 70px; font-size: 11px; text-align: center; }
  .mtable .mchart { min-width: 300px; }
  .spark { display: block; background: var(--panel2); border-radius: 4px; }
  .sparkwrap { position: relative; }
  .hov-tip { position: absolute; top: -4px; transform: translateY(-100%); background: var(--panel);
    border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font-size: 11px;
    white-space: nowrap; pointer-events: none; z-index: 5; }
  button.ghost.active-node { color: var(--text); border-color: var(--accent); background: var(--panel2); }
  .rolebadge { font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; color: #0b0d12; margin-left: 4px; vertical-align: middle; }
  .bnscore { color: #fff; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 1px 6px; min-width: 24px; text-align: center; }
  .analysis { background: var(--panel2); border-left: 3px solid var(--accent); padding: 14px 16px;
    border-radius: 6px; margin-bottom: 20px; }
  .back { cursor: pointer; color: var(--accent); margin-bottom: 14px; display: inline-block; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  /* catalog table + modal */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  .linkbtn { background: none; border: 0; color: var(--cyan); cursor: pointer; font-size: 12px; padding: 2px 6px; }
  .linkbtn.danger { color: var(--red); }
  .switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 24px; width: 520px; max-width: 92vw; max-height: 88vh; overflow:auto; }
  .modal label { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted); margin: 12px 0 4px; }
  .modal input, .modal select, .modal textarea { width: 100%; box-sizing: border-box; background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: inherit; }
  /* chat */
  .chat-fab { position: fixed; right: 24px; bottom: 24px; background: var(--accent); color: #fff;
    border: 0; border-radius: 28px; padding: 14px 20px; font-size: 14px; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.4); z-index: 20; }
  .drawer { position: fixed; top: 0; right: 0; width: 420px; max-width: 100vw; height: 100vh;
    background: var(--panel); border-left: 1px solid var(--border); display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform .2s; z-index: 30; }
  .drawer.open { transform: translateX(0); }
  .drawer .dhead { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex;
    justify-content: space-between; align-items: center; }
  .drawer .dhead .x { cursor: pointer; color: var(--muted); font-size: 18px; }
  .msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 90%; padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; font-size: 13px; }
  .msg.user { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg.bot { align-self: flex-start; background: var(--panel2); border: 1px solid var(--border); }
  .msg .tools { margin-top: 6px; font-size: 11px; color: var(--muted); }
  .chat-input { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); }
  .chat-input input { flex: 1; }
  .chat-unavail { padding: 16px; color: var(--muted); font-size: 13px; }
  .livebar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted);
    margin-bottom: 14px; min-height: 18px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--green); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  .card .sched { margin-top: 10px; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .card .sched select { padding: 4px 6px; font-size: 12px; }
  .scanbtn { padding: 4px 10px; font-size: 12px; }
  .scanbtn:disabled { opacity: .6; cursor: default; }
  .scanning { outline: 2px solid var(--accent); }
</style>
</head>
<body>
<header>
  <h1>ps-agent</h1>
  <span class="sub">MongoDB deployment health &amp; risk dashboard</span>
</header>
<main>
  <div class="tabs">
    <div class="tab active" data-view="fleet">Fleet</div>
    <div class="tab" data-view="risks">Risk inbox</div>
    <div class="tab" data-view="catalog">Risk catalog</div>
  </div>
  <div class="livebar"><span class="dot" id="livedot"></span><span id="livetext">connecting to live updates…</span></div>
  <div id="content"><div class="empty">Loading…</div></div>
</main>

<button class="chat-fab" onclick="toggleChat()">💬 Ask</button>
<div class="drawer" id="drawer">
  <div class="dhead">
    <strong>Ask ps-agent</strong>
    <span class="x" onclick="toggleChat()">✕</span>
  </div>
  <div class="msgs" id="msgs"></div>
  <div class="chat-input" id="chatInput">
    <input id="chatText" placeholder="e.g. which deployment is least healthy?" onkeydown="if(event.key==='Enter')sendChat()" />
    <button class="action" onclick="sendChat()">Send</button>
  </div>
</div>

<script>
const el = document.getElementById('content');
const sevClass = s => ({critical:'crit',warning:'warn',info:'info',ok:'ok'}[s] || 'info');
const scoreColor = v => v >= 85 ? 'var(--green)' : v >= 60 ? 'var(--amber)' : 'var(--red)';
const fmtDate = d => d ? new Date(d).toLocaleString() : '—';
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
  return r.json();
}

let view = 'fleet';
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  view = t.dataset.view;
  render();
});

async function render() {
  if (view === 'fleet') return renderFleet();
  if (view === 'risks') return renderRisks();
  if (view === 'catalog') return renderCatalog();
}

async function renderFleet() {
  el.innerHTML = '<div class="empty">Loading fleet…</div>';
  const [fleet] = await Promise.all([api('/api/fleet')]);
  const form = \`
    <div class="addbox">
      <div class="addrow">
        <input id="name" placeholder="Deployment name" style="width:180px" />
        <select id="deployment" onchange="onDeploymentChange()">
          <option value="atlas">Atlas (cloud)</option>
          <option value="on-prem">On-prem (self-managed)</option>
        </select>
        <button class="action" onclick="addSource()">Add deployment</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:2px">Add whatever is available — each input just enables more scans/metrics. You can supplement later from the deployment's detail page.</div>

      <div class="addsection">
        <div class="addsection-t">Live connection <span class="muted">(optional)</span></div>
        <div class="addfields">
          <input class="uri" id="uri" placeholder="Connection string — mongodb://user:pass@host:27017/" />
        </div>
        <div class="addfields" style="margin-top:6px">
          <select id="mcpTransport" onchange="onMcpTransportChange()">
            <option value="">MCP: none</option>
            <option value="stdio">MCP: stdio (spawn command)</option>
            <option value="http">MCP: http (url)</option>
          </select>
          <input id="mcpCommand" placeholder="npx -y mongodb-mcp-server" style="flex:1;min-width:240px;display:none" />
          <input id="mcpUrl" placeholder="http://localhost:3000/mcp" style="flex:1;min-width:240px;display:none" />
        </div>
      </div>

      <div class="addsection" id="sec-atlas">
        <div class="addsection-t">Atlas Admin API <span class="muted">(optional — unlocks metric trends, tier limits, alerts, Performance Advisor)</span></div>
        <div class="addfields">
          <input id="atlasGroup" placeholder="Project (group) ID" style="width:200px" />
          <input id="atlasPub" placeholder="Public key" style="width:160px" />
          <input id="atlasPriv" placeholder="Private key" style="width:220px" />
          <input id="atlasCluster" placeholder="Cluster name (optional)" style="width:180px" />
        </div>
      </div>

      <div class="addsection" id="sec-opsmanager" style="display:none">
        <div class="addsection-t">Ops Manager Admin API <span class="muted">(optional — unlocks metric trends & slow-query logs)</span></div>
        <div class="addfields">
          <input id="omUrl" placeholder="https://opsmgr.example.com:8080" style="width:260px" />
          <input id="omGroup" placeholder="Project (group) ID" style="width:200px" />
          <input id="omPub" placeholder="Public key" style="width:160px" />
          <input id="omPriv" placeholder="Private key" style="width:220px" />
        </div>
      </div>

      <div class="addsection">
        <div class="addsection-t">Import diagnostics <span class="muted" id="diag-hint"></span></div>
        <div class="addfields" style="flex-direction:column;align-items:flex-start;gap:6px">
          <input type="file" id="offlineFile" multiple />
          <label class="muted" style="font-size:12px;cursor:pointer"><input type="checkbox" id="offlineDir" onchange="onOfflineDir()" /> select a whole folder instead</label>
        </div>
      </div>

      <div class="muted" id="addhint" style="font-size:12px;margin-top:4px"></div>
    </div>\`;
  if (fleet.length === 0) {
    el.innerHTML = form + '<div class="empty">No deployments registered yet. Add one above.</div>';
    onDeploymentChange();
    return;
  }
  const cards = fleet.map(f => {
    const c = f.score ? f.score.counts : null;
    const scoreHtml = f.score
      ? \`<div class="score"><span class="val" style="color:\${scoreColor(f.score.value)}">\${f.score.value}</span><span class="max">/100</span></div>\`
      : '<div class="muted">Not scanned</div>';
    const pills = c ? \`<div class="pills">
        <span class="pill crit">\${c.critical} crit</span>
        <span class="pill warn">\${c.warning} warn</span>
        <span class="pill info">\${c.info} info</span></div>\` : '';
    const iv = (f.source.schedule && f.source.schedule.enabled !== false && f.source.schedule.intervalSeconds) || 0;
    const opts = [0,60,300,900,3600].map(s =>
      \`<option value="\${s}" \${s===iv?'selected':''}>\${s===0?'Manual':s<3600?(s/60)+'m':'1h'}</option>\`).join('');
    return \`<div class="card" id="card-\${f.source.id}" onclick="openDetail('\${f.source.id}','\${f.latestScanId||''}')">
      <span class="card-x" title="Deregister" onclick="event.stopPropagation();removeSource('\${f.source.id}','\${esc(f.source.name)}')">✕</span>
      <h3>\${esc(f.source.name)}</h3>
      <div class="host">\${esc(f.source.connectionString || (f.source.deployment === 'atlas' ? 'Atlas' : 'On-prem'))}</div>
      \${scoreHtml}\${pills}
      <div class="muted" style="margin-top:10px;font-size:12px">Last scan: <span id="last-\${f.source.id}">\${fmtDate(f.lastScannedAt)}</span></div>
      <div class="sched" onclick="event.stopPropagation()">
        <button class="ghost scanbtn" data-sid="\${f.source.id}" onclick="scanNow('\${f.source.id}')">Scan now</button>
        <span class="muted">Auto-scan:</span>
        <select onchange="setSchedule('\${f.source.id}', this.value)">\${opts}</select>
      </div>
    </div>\`;
  }).join('');
  el.innerHTML = form + '<div class="cards">' + cards + '</div>';
  onDeploymentChange();
}

async function setSchedule(sourceId, seconds) {
  const intervalSeconds = Number(seconds);
  try {
    await api('/api/sources/' + sourceId + '/config', {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ schedule: { intervalSeconds: intervalSeconds || undefined, enabled: intervalSeconds > 0 } }),
    });
  } catch (e) { alert('Failed to set schedule: ' + e.message); }
}

// Trigger a manual scan. The SSE event stream (startLiveUpdates) shows progress
// and refreshes the fleet on scan.completed; here we just disable the button and
// kick it off. event may be undefined when called from the detail view.
async function scanNow(sourceId, summarize) {
  if (typeof event !== 'undefined' && event) event.stopPropagation();
  const btns = Array.from(document.querySelectorAll('.scanbtn')).filter(b => b.dataset.sid === sourceId);
  // Preserve each button's label (it may say "Re-analyze" for import-only sources).
  const labels = btns.map(b => b.textContent);
  btns.forEach((b, i) => { b.disabled = true; b.textContent = (labels[i] === 'Re-analyze' ? 'Re-analyzing…' : 'Scanning…'); });
  try {
    await api('/api/sources/' + sourceId + '/scan' + (summarize ? '?summarize=1' : ''), { method: 'POST' });
    // Refresh current view (live-updates also triggers this on scan.completed).
    render();
  } catch (e) {
    alert('Scan failed: ' + e.message);
    btns.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] || 'Scan now'; });
  }
}

// Show/hide the type-specific sections + set the import hint for the chosen
// deployment. Atlas has the Atlas Admin API + mongod.log only; on-prem has Ops
// Manager + the full file-diagnostics set.
function onDeploymentChange() {
  const dep = document.getElementById('deployment').value;
  const atlas = dep === 'atlas';
  document.getElementById('sec-atlas').style.display = atlas ? 'block' : 'none';
  document.getElementById('sec-opsmanager').style.display = atlas ? 'none' : 'block';
  document.getElementById('diag-hint').textContent = atlas
    ? '(mongod.log only for Atlas)'
    : '(any mix of getMongoData, mdiag, FTDC, mongod.log — across nodes)';
  document.getElementById('addhint').textContent = atlas
    ? 'Atlas deployment. Add a connection string / MCP for live health checks, an Atlas API key for trends & capacity, and/or a mongod.log for log signals & slow queries.'
    : 'On-prem deployment. Add a connection string / MCP for live checks, Ops Manager API for trends, and/or import getMongoData / FTDC / mdiag / mongod.log diagnostics.';
}
function onMcpTransportChange() {
  const t = document.getElementById('mcpTransport').value;
  document.getElementById('mcpCommand').style.display = (t === 'stdio') ? '' : 'none';
  document.getElementById('mcpUrl').style.display = (t === 'http') ? '' : 'none';
}

function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

// Assemble whatever connectivity blocks the user filled in (all optional).
function collectConnectivityBody(deployment) {
  const body = {};
  if (val('uri')) body.connectionString = val('uri');
  const transport = document.getElementById('mcpTransport').value;
  if (transport) {
    const mcp = { transport };
    if (transport === 'stdio' && val('mcpCommand')) mcp.command = val('mcpCommand');
    if (transport === 'http' && val('mcpUrl')) mcp.url = val('mcpUrl');
    if (mcp.command || mcp.url) body.mcp = mcp;
  }
  if (deployment === 'atlas' && val('atlasGroup') && val('atlasPub') && val('atlasPriv')) {
    body.atlas = {
      projectId: val('atlasGroup'), publicKey: val('atlasPub'), privateKey: val('atlasPriv'),
      clusterName: val('atlasCluster') || undefined,
    };
  }
  if (deployment === 'on-prem' && val('omUrl') && val('omGroup') && val('omPub') && val('omPriv')) {
    body.opsManager = {
      baseUrl: val('omUrl'), projectId: val('omGroup'),
      publicKey: val('omPub'), privateKey: val('omPriv'),
    };
  }
  return body;
}

async function addSource() {
  const name = val('name') || 'deployment';
  const deployment = document.getElementById('deployment').value;
  const conn = collectConnectivityBody(deployment);
  const fileEl = document.getElementById('offlineFile');
  const files = fileEl && fileEl.files && fileEl.files.length ? [...fileEl.files] : [];

  // At least one input is required (connectivity or a diagnostic file).
  if (Object.keys(conn).length === 0 && files.length === 0) {
    return alert('Add at least one input: a connection string / MCP / Atlas or Ops Manager API, or import a diagnostic file.');
  }

  try {
    // 1) Register the deployment (name + type + any connectivity).
    const src = await api('/api/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, deployment, ...conn }),
    });
    // 2) Import any diagnostic files into it.
    if (files.length) await importDiagnostics(files, undefined, src.id, true);
    // 3) Scan if we have a live connection; otherwise the import already produced a scan.
    const hasLive = conn.connectionString || conn.mcp || conn.atlas || conn.opsManager;
    if (hasLive) await api('/api/sources/' + src.id + '/scan?summarize=1', { method: 'POST' });
    renderFleet();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function openDetail(sourceId, scanId) {
  el.innerHTML = '<div class="empty">Loading…</div>';
  if (!scanId) {
    try { const r = await api('/api/sources/'+sourceId+'/scan?summarize=1', {method:'POST'});
      return renderDetail(r); } catch(e){ el.innerHTML='<div class="empty">'+esc(e.message)+'</div>'; return; }
  }
  const scan = await api('/api/scans/' + scanId);
  renderDetail(scan);
}

function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B','KiB','MiB','GiB','TiB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 2 : 0) + ' ' + u[i];
}

function methodBadge(facts) {
  // Prefer the explicit method; infer from facts for older snapshots.
  let method = facts.collectionMethod;
  if (!method) {
    if (facts.atlas) method = 'atlas';
    else if (facts.serverStatus) method = 'direct';
    else return '';
  }
  const label = { 'direct':'driver', 'atlas':'Atlas API', 'mcp':'MCP (data-layer)', 'mcp+direct':'MCP + driver (deep)' }[method] || method;
  return '<span class="pill" title="How facts were collected">collected via ' + esc(label) + '</span>';
}

function storagePanel(storage) {
  if (!storage) return '';
  const used = storage.fsUsedBytes, total = storage.fsTotalBytes;
  const pct = used && total ? (used/total*100) : null;
  const barColor = pct == null ? 'var(--muted)' : pct >= 90 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)';
  const bar = pct == null ? '' : \`
    <div style="margin:8px 0">
      <div style="background:var(--panel2);border-radius:5px;height:10px;overflow:hidden">
        <div style="width:\${Math.min(100,pct).toFixed(1)}%;height:100%;background:\${barColor}"></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">Disk \${pct.toFixed(1)}% used — \${fmtBytes(used)} of \${fmtBytes(total)}</div>
    </div>\`;
  const topDbs = (storage.databases || []).slice().sort((a,b)=>(b.dataSize+b.indexSize)-(a.dataSize+a.indexSize)).slice(0,5);
  const rows = topDbs.map(d => \`<tr>
      <td>\${esc(d.name)}</td><td>\${fmtBytes(d.dataSize)}</td><td>\${fmtBytes(d.indexSize)}</td><td>\${d.collections}</td>
    </tr>\`).join('');
  return \`
    <div class="panel" style="margin-bottom:20px">
      <div style="font-weight:600;margin-bottom:6px">Storage</div>
      \${bar}
      <div class="muted" style="font-size:12px">Data \${fmtBytes(storage.dataSizeBytes)} · Indexes \${fmtBytes(storage.indexSizeBytes)}\${storage.databases?(' · '+storage.databases.length+' databases'):''}</div>
      \${rows ? '<table style="margin-top:10px"><thead><tr><th>Database</th><th>Data</th><th>Indexes</th><th>Colls</th></tr></thead><tbody>'+rows+'</tbody></table>' : ''}
    </div>\`;
}

// Render a finding's evidence (the specifics: namespaces, index names, numbers).
function evidenceHtml(ev) {
  if (!ev || typeof ev !== 'object' || Object.keys(ev).length === 0) return '';
  const parts = [];
  for (const [k, v] of Object.entries(ev)) {
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const items = v.map(x => '<li>' + esc(typeof x === 'object' ? JSON.stringify(x) : String(x)) + '</li>').join('');
      parts.push('<div class="evk">' + esc(k) + ':</div><ul class="evlist">' + items + '</ul>');
    } else if (v !== null && v !== undefined) {
      parts.push('<div class="evrow"><span class="evk">' + esc(k) + ':</span> <code>' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</code></div>');
    }
  }
  if (parts.length === 0) return '';
  return '<details class="evidence"><summary>Details</summary><div class="evbody">' + parts.join('') + '</div></details>';
}

function renderDetail(scan) {
  const t = scan.facts.topology;
  const back = '<span class="back" onclick="render()">← Back to fleet</span>';
  const scoreHtml = \`<div class="score"><span class="val" style="color:\${scoreColor(scan.score.value)}">\${scan.score.value}</span><span class="max">/100</span></div>\`;
  const analysis = scan.analysis ? \`<div class="analysis">
      <div style="font-weight:600;margin-bottom:6px">Analysis <span class="muted" style="font-weight:400">(\${esc(scan.analysis.generatedBy)})</span></div>
      <div>\${esc(scan.analysis.summary)}</div>
      \${scan.analysis.recommendations && scan.analysis.recommendations.length ? '<ul style="margin:10px 0 0">'+scan.analysis.recommendations.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>':''}
    </div>\` : '';
  const findings = scan.findings.length ? scan.findings.map(f => \`
    <div class="finding">
      <div class="ftitle"><span class="badge \${sevClass(f.severity)}">\${f.severity.toUpperCase()}</span> \${esc(f.title)} <code>\${esc(f.checkId)}</code></div>
      <div class="fdetail">\${esc(f.detail)}</div>
      \${f.remediation ? '<div class="fdetail">→ '+esc(f.remediation)+'</div>' : ''}
      \${evidenceHtml(f.evidence)}
    </div>\`).join('') : '<div class="empty">No issues detected.</div>';
  el.innerHTML = back + \`
    <div class="panel" style="margin-bottom:20px">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2 style="margin:0 0 4px">\${esc(scan.sourceName)}</h2>
          <div class="muted">\${esc((scan.facts.serverStatus && scan.facts.serverStatus.host) || (scan.facts.atlas ? 'Atlas project '+scan.facts.atlas.projectId : ''))} · \${t.type}\${t.setName?' "'+esc(t.setName)+'"':''} · \${t.nodeCount} node(s) · MongoDB \${esc(t.mongoVersion)}</div>
          <div class="pills" style="margin-top:8px">\${methodBadge(scan.facts)}</div>
        </div>
        <div style="text-align:right">
          \${scoreHtml}
          <div style="margin-top:10px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
            <button class="action scanbtn" id="scanbtn-detail" data-sid="\${scan.sourceId}" onclick="scanNow('\${scan.sourceId}', true)" title="Run a scan">Scan now</button>
            <button class="ghost" onclick="document.getElementById('bundleFile').click()" title="Attach any mix of getMongoData, mdiag, FTDC, or mongod.log files (across nodes) — auto-detected and merged into this deployment">Import files…</button>
            <button class="ghost" onclick="document.getElementById('bundleFolder').click()" title="Import a whole folder of diagnostics (recurses into subfolders) — each file is auto-detected and merged into this deployment">Import folder…</button>
            <input type="file" id="bundleFile" multiple style="display:none" onchange="uploadBundle('\${scan.sourceId}', this)" />
            <input type="file" id="bundleFolder" webkitdirectory directory multiple style="display:none" onchange="uploadBundle('\${scan.sourceId}', this)" />
            <button class="ghost" onclick="removeSource('\${scan.sourceId}', '\${esc(scan.sourceName)}')">Deregister</button>
          </div>
          <div class="muted" id="mdiag-status" style="font-size:11px;margin-top:4px;text-align:right">\${scan.facts.os ? 'mdiag attached ✓' : ''}</div>
          <div class="muted" id="ftdc-status" style="font-size:11px;margin-top:2px;text-align:right"></div>
          <div class="muted" id="ftdc-provenance" style="font-size:11px;margin-top:2px;text-align:right"></div>
        </div>
      </div>
    </div>
    \${analysis}
    <div id="availability-panel"></div>
    <div id="capacity-panel"></div>
    <div id="metrics-panel"></div>
    <div id="risk-panel"></div>
    \${storagePanel(scan.facts.storage)}
    <h3>Findings (\${scan.findings.length})</h3>
    \${findings}\`;
  const members = (scan.facts.replSetStatus && scan.facts.replSetStatus.members) || [];
  const roster = members.map(m => m.name);
  loadFtdcProvenance(scan.sourceId, roster);
  // Data availability: what's attached, what's missing, and the consequence.
  loadAvailability(scan.sourceId);
  // Auto-display the last computed capacity/risk reports if they're cached;
  // otherwise show a button so the user can compute them on demand (these are
  // expensive — Atlas/OpsManager API calls and an LLM round-trip).
  showCapacity(scan.sourceId);
  showRisks(scan.sourceId);
  // Per-node FTDC metric charts. Pass members so we can default to the PRIMARY.
  loadMetrics(scan.sourceId, members);
}

// Load + render the "data availability" panel: available inputs, missing inputs
// with their consequence, and a supplement action (import a file / add creds).
async function loadAvailability(sourceId) {
  const panel = document.getElementById('availability-panel');
  if (!panel) return;
  try {
    const a = await api('/api/sources/' + sourceId + '/capabilities');
    panel.innerHTML = availabilityPanel(a, sourceId);
    // Import-only deployments can't collect live — "Scan now" just re-runs the
    // rule engine + risk analysis on the imported facts, so relabel it.
    const btn = document.getElementById('scanbtn-detail');
    if (btn && a.capabilities && !a.capabilities.liveScan) {
      btn.textContent = 'Re-analyze';
      btn.title = 'Re-run the health + risk analysis on the imported data (no live connection; does not re-read files)';
    }
  } catch (e) {
    panel.innerHTML = '';
  }
}

function availabilityPanel(a, sourceId) {
  const depLabel = a.deployment === 'atlas' ? 'Atlas' : 'On-prem';
  const avail = (a.available || []).map(i =>
    '<span class="pill" style="background:rgba(0,180,80,0.12);border-color:var(--green)">✓ ' + esc(i.label)
    + (i.at ? ' <span class="muted" style="font-size:10px">(' + fmtWhen(i.at) + ')</span>' : '') + '</span>').join(' ');
  const missing = (a.missing || []).map(m => {
    const action = m.supplement === 'import'
      ? '<button class="ghost" style="font-size:11px;padding:2px 8px" onclick="document.getElementById(\\'bundleFile\\').click()">Import…</button>'
      : '<button class="ghost" style="font-size:11px;padding:2px 8px" onclick="openSupplement(\\'' + esc(sourceId) + '\\')">Add…</button>';
    return '<div class="finding" style="padding:8px 12px">'
      + '<div class="ftitle" style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
      + '<span><span class="badge info">MISSING</span> ' + esc(m.label) + '</span>' + action + '</div>'
      + '<div class="fdetail">' + esc(m.consequence) + '</div></div>';
  }).join('');
  return '<div class="panel" style="margin-bottom:20px">'
    + '<div style="font-weight:600;margin-bottom:8px">Data availability <span class="muted" style="font-weight:400;font-size:12px">(' + depLabel + ' deployment)</span></div>'
    + (avail ? '<div style="margin-bottom:' + (missing ? '12px' : '0') + '">' + avail + '</div>' : '')
    + (missing
        ? '<div class="muted" style="font-size:12px;margin-bottom:6px">Not attached — and what you\\'re missing:</div>' + missing
        : '<div class="muted" style="font-size:12px">All applicable inputs attached. 🎉</div>')
    + '</div>';
}

// Prompt for Atlas / Ops Manager API creds (or a connection string) and PATCH
// them onto an existing source via /connectivity.
async function openSupplement(sourceId) {
  const cs = prompt('Add connectivity. Paste a connection string, or leave blank to enter API keys:');
  const body = {};
  if (cs && cs.trim()) {
    body.connectionString = cs.trim();
  } else {
    // Try Atlas first, then Ops Manager, based on what the user provides.
    const group = prompt('Atlas/Ops Manager project (group) ID (blank to cancel):');
    if (!group) return;
    const pub = prompt('Public key:'); const priv = prompt('Private key:');
    if (!pub || !priv) return;
    const omUrl = prompt('Ops Manager base URL (blank if this is Atlas):');
    if (omUrl && omUrl.trim()) {
      body.opsManager = { baseUrl: omUrl.trim(), projectId: group, publicKey: pub, privateKey: priv };
    } else {
      const cluster = prompt('Atlas cluster name (recommended, for tier limits):') || undefined;
      body.atlas = { projectId: group, publicKey: pub, privateKey: priv, clusterName: cluster };
    }
  }
  try {
    await api('/api/sources/' + encodeURIComponent(sourceId) + '/connectivity', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await api('/api/sources/' + encodeURIComponent(sourceId) + '/scan?summarize=1', { method: 'POST' }).catch(()=>{});
    openDetail(sourceId, null);
  } catch (e) { alert('Failed to attach: ' + e.message); }
}

// ---------------------------------------------------------------------------
// Metrics panel — per-node FTDC time-series charts (inline SVG, no deps).
// ---------------------------------------------------------------------------

// Metric catalog: display label, unit, formatter, group, and optional warn/crit
// thresholds (as fractions 0..1 for '%' metrics, else absolute). Grouped like
// x-ray (Workload / Ops & Latencies / Performance). Entries whose key has no
// stored series are simply skipped, so this can list Phase-B metrics up front.
var METRIC_CATALOG = [
  // Workload (opcounters, ops/s)
  { key:'OPCOUNTER_QUERY',  label:'Query',   unit:'ops/s', group:'Workload', fmt:'num' },
  { key:'OPCOUNTER_INSERT', label:'Insert',  unit:'ops/s', group:'Workload', fmt:'num' },
  { key:'OPCOUNTER_UPDATE', label:'Update',  unit:'ops/s', group:'Workload', fmt:'num' },
  { key:'OPCOUNTER_DELETE', label:'Delete',  unit:'ops/s', group:'Workload', fmt:'num' },
  { key:'OPCOUNTER_COMMAND',label:'Command', unit:'ops/s', group:'Workload', fmt:'num' },
  { key:'OPCOUNTER_GETMORE',label:'GetMore', unit:'ops/s', group:'Workload', fmt:'num' },
  // Connections
  { key:'CONNECTIONS', label:'Connections', unit:'count', group:'Workload', fmt:'num' },
  // Ops & latencies
  { key:'DISK_PARTITION_IOPS_TOTAL', label:'Disk IOPS (total)', unit:'ops/s', group:'Ops & latencies', fmt:'num' },
  { key:'DISK_READ_OPS',   label:'Read operations',  unit:'ops/s', group:'Ops & latencies', fmt:'num' },
  { key:'DISK_WRITE_OPS',  label:'Write operations', unit:'ops/s', group:'Ops & latencies', fmt:'num' },
  { key:'DISK_READ_LATENCY',  label:'Read latency',  unit:'ms/op', group:'Ops & latencies', fmt:'num' },
  { key:'DISK_WRITE_LATENCY', label:'Write latency', unit:'ms/op', group:'Ops & latencies', fmt:'num' },
  // Performance
  { key:'SYSTEM_NORMALIZED_CPU_USER',   label:'CPU user',    unit:'%', group:'Performance', fmt:'pct', warn:85, crit:95 },
  { key:'SYSTEM_NORMALIZED_CPU_KERNEL', label:'CPU system',  unit:'%', group:'Performance', fmt:'pct', warn:20, crit:30 },
  { key:'SYSTEM_CPU_IOWAIT',            label:'CPU I/O wait', unit:'%', group:'Performance', fmt:'pct', warn:10, crit:20 },
  { key:'SYSTEM_MEMORY_UTIL',           label:'System memory utilization', unit:'%', group:'Performance', fmt:'pct', warn:85, crit:95 },
  { key:'MEMORY_FRAGMENTATION',         label:'Memory fragmentation', unit:'%', group:'Performance', fmt:'pct', warn:15, crit:25 },
  { key:'CACHE_FILL_PCT',  label:'Cache fill',  unit:'%', group:'Performance', fmt:'pct', warn:80, crit:95 },
  { key:'CACHE_DIRTY_PCT', label:'Cache dirty', unit:'%', group:'Performance', fmt:'pct', warn:5,  crit:20 },
  { key:'CACHE_USED_BYTES', label:'Cache used', unit:'bytes', group:'Performance', fmt:'bytes' },
  { key:'DISK_PARTITION_SPACE_USED', label:'Disk used',  unit:'bytes', group:'Performance', fmt:'bytes' },
  { key:'DISK_PARTITION_SPACE_FREE', label:'Disk free',  unit:'bytes', group:'Performance', fmt:'bytes' },
];
var METRIC_GROUPS = ['Workload', 'Ops & latencies', 'Performance'];

var _metricsState = { sourceId:null, node:null, bundle:null, members:[] };

async function loadMetrics(sourceId, members) {
  const panel = document.getElementById('metrics-panel');
  if (!panel) return;
  try {
    const bundle = await api('/api/sources/' + sourceId + '/metrics');
    if (!bundle.nodes || bundle.nodes.length === 0) { panel.innerHTML = ''; return; } // no FTDC series
    _metricsState.sourceId = sourceId;
    _metricsState.bundle = bundle;
    _metricsState.members = members || []; // replSetStatus members (role + config)
    // Default to the PRIMARY node if we can match it, else the first node.
    _metricsState.node = pickDefaultNode(bundle.nodes, members);
    renderMetricsPanel();
  } catch (e) {
    panel.innerHTML = '';
  }
}

// Choose the PRIMARY (state 1) member whose name maps to a node with series.
function pickDefaultNode(nodes, members) {
  const primary = (members || []).find(m => m.state === 1 || m.stateStr === 'PRIMARY');
  if (primary) {
    const match = nodes.find(n => reconcileNodeName(n, members.map(m=>m.name)) === primary.name || n === primary.name);
    if (match) return match;
  }
  return nodes[0];
}

function switchMetricsNode(node) { _metricsState.node = node; renderMetricsPanel(); }

// Find the replSetStatus member matching a node/member name (via node-identity
// reconciliation), so we can tag it with role + config (votes/priority/hidden).
function memberFor(name) {
  const members = _metricsState.members || [];
  if (!members.length) return null;
  const roster = members.map(m => m.name);
  const canonical = reconcileNodeName(name, roster);
  return members.find(m => m.name === canonical || m.name === name) || null;
}

// Short role label + color for a member (from its config/state).
function memberRole(m) {
  if (!m) return null;
  if (m.arbiterOnly) return ['ARBITER', 'var(--accent)'];
  if (m.hidden) return ['HIDDEN', 'var(--muted)'];
  if (m.health === 0) return ['DOWN', 'var(--red)'];
  const s = RS_STATES[m.state];
  return s ? [s[0], s[1]] : [m.stateStr || 'UNKNOWN', 'var(--muted)'];
}

// Config badges (votes / priority / hidden / arbiter) when available.
function memberConfigBadges(m) {
  if (!m) return '';
  const out = [];
  if (m.votes != null) out.push('v' + m.votes);
  if (m.priority != null) out.push('p' + m.priority);
  if (m.hidden) out.push('hidden');
  if (m.arbiterOnly) out.push('arbiter');
  if (out.length === 0) return '';
  return '<span class="muted" style="font-size:10px">' + out.map(esc).join(' · ') + '</span>';
}

function renderMetricsPanel() {
  const panel = document.getElementById('metrics-panel');
  if (!panel) return;
  _sparkData = {}; _sparkSeq = 0; // reset chart registry for this render
  const { bundle, node, sourceId } = _metricsState;
  const nodeSeries = (bundle.series && bundle.series[node]) || {};

  // Node selector pills, each tagged with the member's role/state when known.
  const pills = bundle.nodes.map(n => {
    const role = memberRole(memberFor(n));
    const tag = role ? ' <span class="rolebadge" style="background:' + role[1] + '">' + role[0] + '</span>' : '';
    return '<button class="ghost' + (n===node?' active-node':'') + '" style="font-size:11px;padding:3px 10px" onclick="switchMetricsNode(\\'' + esc(n) + '\\')">' + esc(n) + tag + '</button>';
  }).join(' ');

  // Only chart metrics that have data for this node, grouped + ordered.
  let body = '';
  for (const group of METRIC_GROUPS) {
    const defs = METRIC_CATALOG.filter(d => d.group === group && nodeSeries[d.key] && nodeSeries[d.key].length);
    if (defs.length === 0) continue;
    const rows = defs.map(d => metricRow(d, nodeSeries[d.key])).join('');
    body += '<div class="muted" style="font-size:12px;margin:14px 0 6px;font-weight:600">' + esc(group) + '</div>'
      + '<table class="mtable"><tbody>' + rows + '</tbody></table>';
  }

  // Replica-set member-state timeline (if MEMBER_STATE_* series exist for this node).
  const nodeUnits = (bundle.units && bundle.units[node]) || {};
  const stateKeys = Object.keys(nodeSeries).filter(k => k.indexOf('MEMBER_STATE_') === 0)
    .sort((a,b) => parseInt(a.slice(13)) - parseInt(b.slice(13)));
  if (stateKeys.length) {
    const rows = stateKeys.map(k => memberStateRow(nodeUnits[k] || k, nodeSeries[k])).join('');
    body += '<div class="muted" style="font-size:12px;margin:14px 0 6px;font-weight:600">Replica-set member state</div>'
      + MEMBER_STATE_LEGEND
      + '<table class="mtable mtable-rs"><tbody>' + rows + '</tbody></table>';
  }

  if (!body) body = '<div class="muted">No chartable metrics for this node.</div>';

  panel.innerHTML = '<div class="panel" style="margin-bottom:20px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
    + '<div style="font-weight:600">Metrics <span class="muted" style="font-weight:400;font-size:12px">(FTDC, per node)</span></div>'
    + '<div style="display:flex;gap:4px;flex-wrap:wrap">' + pills + '</div></div>'
    + body + '</div>';
}

// Replica-set member state codes → short label + color.
var RS_STATES = {
  0:['STARTUP','var(--muted)'], 1:['PRIMARY','var(--green)'], 2:['SECONDARY','var(--cyan)'],
  3:['RECOVERING','var(--amber)'], 5:['STARTUP2','var(--amber)'], 6:['UNKNOWN','var(--muted)'],
  7:['ARBITER','var(--accent)'], 8:['DOWN','var(--red)'], 9:['ROLLBACK','var(--red)'], 10:['REMOVED','var(--red)']
};
var MEMBER_STATE_LEGEND = (function(){
  var items = [1,2,7,3,8,9].map(function(c){ var s=RS_STATES[c]; return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="width:10px;height:10px;border-radius:2px;background:'+s[1]+';display:inline-block"></span>'+s[0]+'</span>'; }).join('');
  return '<div class="muted" style="font-size:11px;margin-bottom:6px">'+items+'</div>';
})();

// One member row: name (+ config badges + self) · current state badge · timeline.
function memberStateRow(name, points) {
  const cur = points[points.length-1][1];
  const curS = RS_STATES[cur] || ['STATE '+cur, 'var(--muted)'];
  const m = memberFor(name);
  const self = m && m.self ? ' <span class="muted" style="font-size:10px">(self)</span>' : '';
  const cfg = memberConfigBadges(m);
  return '<tr>'
    + '<td class="mlabel">' + esc(name) + self + (cfg ? '<br>' + cfg : '') + '</td>'
    + '<td class="mstat"><span class="badge" style="background:' + curS[1] + ';color:#0b0d12">' + curS[0] + '</span></td>'
    + '<td class="mthr"></td>'
    + '<td class="mchart">' + memberStateTimeline(points) + '</td>'
    + '</tr>';
}

// Inline SVG step-band timeline of member state over time.
function memberStateTimeline(points) {
  const W = 460, H = 26;
  if (!points || points.length === 0) return '';
  const xs = points.map(p => p[0]);
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  const sx = (x) => (x1===x0 ? 0 : (x - x0) / (x1 - x0)) * W;
  // Draw a rect for each segment between consecutive samples (step).
  let rects = '';
  for (let i=0;i<points.length;i++){
    const xStart = sx(points[i][0]);
    const xEnd = (i+1<points.length) ? sx(points[i+1][0]) : W;
    const s = RS_STATES[points[i][1]] || ['?','var(--muted)'];
    const w = Math.max(0.5, xEnd - xStart);
    rects += '<rect x="'+xStart.toFixed(1)+'" y="0" width="'+w.toFixed(1)+'" height="'+H+'" fill="'+s[1]+'"><title>'+esc(s[0])+' @ '+fmtWhen(new Date(points[i][0]).toISOString())+'</title></rect>';
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'" preserveAspectRatio="none" class="spark" style="border-radius:3px">'
    + rects + '</svg>';
}

// One metric row: label + peak/avg + inline SVG chart.
function metricRow(def, points) {
  const vals = points.map(p => p[1]);
  const peak = Math.max.apply(null, vals);
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  const fmt = (v) => def.fmt === 'bytes' ? fmtBytes(v)
    : def.fmt === 'pct' ? (v.toFixed(2) + '%')
    : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  const thr = (def.warn!=null && def.crit!=null) ? (def.warn + ' / ' + def.crit) : '—';
  return '<tr>'
    + '<td class="mlabel">' + esc(def.label) + ' <span class="muted">(' + esc(def.unit) + ')</span></td>'
    + '<td class="mstat">' + fmt(peak) + ' <span class="muted">/ ' + fmt(avg) + '</span></td>'
    + '<td class="mthr muted">' + thr + '</td>'
    + '<td class="mchart">' + sparkline(points, def) + '</td>'
    + '</tr>';
}

// Registry of chart data by id, so hover handlers can look up the exact points
// (points are not re-serialized into the DOM). Reset each render.
var _sparkData = {};
var _sparkSeq = 0;

/**
 * Inline SVG line chart (dependency-free). points = [[tsMs, value], …].
 * Draws an area+line, optional warn/crit threshold lines for '%' metrics, and a
 * hover overlay (guide line + dot + value/timestamp label) wired via mousemove.
 */
function sparkline(points, def) {
  const W = 460, H = 90, PAD = 4;
  if (!points || points.length === 0) return '';
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  let y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  // For % metrics, fix the scale 0..max(100,peak,crit) so thresholds are meaningful.
  if (def && def.fmt === 'pct') { y0 = 0; y1 = Math.max(100, y1, def.crit||0); }
  if (y1 - y0 < 1e-9) { y1 = y0 + 1; }
  const sx = (x) => PAD + (x1===x0 ? 0 : (x - x0) / (x1 - x0)) * (W - 2*PAD);
  const sy = (y) => H - PAD - (y - y0) / (y1 - y0) * (H - 2*PAD);
  let line = '', area = 'M ' + sx(xs[0]).toFixed(1) + ' ' + (H-PAD).toFixed(1);
  for (let i=0;i<points.length;i++){
    const X = sx(xs[i]).toFixed(1), Y = sy(ys[i]).toFixed(1);
    line += (i===0?'M ':'L ') + X + ' ' + Y + ' ';
    area += ' L ' + X + ' ' + Y;
  }
  area += ' L ' + sx(xs[xs.length-1]).toFixed(1) + ' ' + (H-PAD).toFixed(1) + ' Z';
  // Threshold guide lines.
  let guides = '';
  if (def && def.fmt === 'pct' && def.warn!=null) {
    const yw = sy(def.warn).toFixed(1), yc = sy(def.crit).toFixed(1);
    guides = '<line x1="0" x2="'+W+'" y1="'+yw+'" y2="'+yw+'" stroke="var(--amber)" stroke-width="0.7" stroke-dasharray="3 3" opacity="0.6"/>'
           + '<line x1="0" x2="'+W+'" y1="'+yc+'" y2="'+yc+'" stroke="var(--red)" stroke-width="0.7" stroke-dasharray="3 3" opacity="0.6"/>';
  }
  const peak = Math.max.apply(null, ys);
  const col = (def && def.fmt==='pct' && def.crit && peak>=def.crit) ? 'var(--red)'
            : (def && def.fmt==='pct' && def.warn && peak>=def.warn) ? 'var(--amber)' : 'var(--accent)';
  // Stash data + scale fns for the hover handler.
  const id = 'spk' + (_sparkSeq++);
  _sparkData[id] = { points, def, W, H, PAD, x0, x1, y0, y1, col };
  const svg = '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'" preserveAspectRatio="none" class="spark">'
    + guides
    + '<path d="'+area+'" fill="'+col+'" opacity="0.10"/>'
    + '<path d="'+line+'" fill="none" stroke="'+col+'" stroke-width="1.3"/>'
    + '<line class="hov-line" x1="0" x2="0" y1="0" y2="'+H+'" stroke="var(--text)" stroke-width="0.6" opacity="0" />'
    + '<circle class="hov-dot" r="2.5" fill="'+col+'" opacity="0" />'
    + '</svg>';
  return '<div class="sparkwrap" data-spk="'+id+'" onmousemove="metricHover(event,this)" onmouseleave="metricHoverOut(this)">'
    + svg + '<div class="hov-tip" style="display:none"></div></div>';
}

// Hover over a sparkline → show the nearest point's value + timestamp, a vertical
// guide line, and a dot. Maps the cursor x to the nearest data point by time.
function metricHover(ev, wrap) {
  const d = _sparkData[wrap.getAttribute('data-spk')];
  if (!d || !d.points.length) return;
  const rect = wrap.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const targetTs = d.x0 + frac * (d.x1 - d.x0);
  // Nearest point by time.
  let idx = 0, best = Infinity;
  for (let i=0;i<d.points.length;i++){ const dd = Math.abs(d.points[i][0]-targetTs); if (dd<best){best=dd;idx=i;} }
  const pt = d.points[idx];
  // SVG user-space coords for the guide line + dot.
  const ux = d.PAD + (d.x1===d.x0 ? 0 : (pt[0]-d.x0)/(d.x1-d.x0)) * (d.W - 2*d.PAD);
  const uy = d.H - d.PAD - (pt[1]-d.y0)/(d.y1-d.y0) * (d.H - 2*d.PAD);
  const svg = wrap.querySelector('svg');
  const vline = svg.querySelector('.hov-line'), dot = svg.querySelector('.hov-dot');
  vline.setAttribute('x1', ux); vline.setAttribute('x2', ux); vline.setAttribute('opacity','0.5');
  dot.setAttribute('cx', ux); dot.setAttribute('cy', uy); dot.setAttribute('opacity','1');
  // Tooltip.
  const tip = wrap.querySelector('.hov-tip');
  const f = d.def.fmt === 'bytes' ? fmtBytes(pt[1])
    : d.def.fmt === 'pct' ? (pt[1].toFixed(2)+'%')
    : (Math.abs(pt[1])>=100 ? pt[1].toFixed(0) : pt[1].toFixed(2));
  tip.innerHTML = '<strong>' + f + '</strong> <span class="muted">' + new Date(pt[0]).toLocaleString() + '</span>';
  tip.style.display = 'block';
  const px = Math.max(0, Math.min(rect.width - 150, frac*rect.width - 70));
  tip.style.left = px + 'px';
}
function metricHoverOut(wrap) {
  const svg = wrap.querySelector('svg');
  if (svg) { const l=svg.querySelector('.hov-line'); const c=svg.querySelector('.hov-dot'); if(l)l.setAttribute('opacity','0'); if(c)c.setAttribute('opacity','0'); }
  const tip = wrap.querySelector('.hov-tip'); if (tip) tip.style.display='none';
}

// Client-side node-identity reconciliation (mirrors src/core/nodeIdentity.ts) so
// the provenance panel shows one canonical name per physical node.
function reconcileNodeName(observed, roster) {
  if (!observed || !roster || roster.length === 0) return observed;
  const sp = id => { const i = id.lastIndexOf(':'); return (i>0 && /^\\d+$/.test(id.slice(i+1))) ? {h:id.slice(0,i), p:id.slice(i+1)} : {h:id}; };
  const short = h => h.split('.')[0].toLowerCase();
  const score = (o, c) => {
    if (o === c) return 100;
    const a = sp(o), b = sp(c), ah = a.h.toLowerCase(), bh = b.h.toLowerCase();
    if (ah === bh) return (a.p && b.p && a.p === b.p) ? 90 : 80;
    if (bh.startsWith(ah + '.') || ah.startsWith(bh + '.')) return 70;
    if (short(ah) === short(bh)) return 60;
    return 0;
  };
  let best = observed, bestScore = 0;
  for (const name of roster) { const s = score(observed, name); if (s > bestScore) { bestScore = s; best = name; } }
  return bestScore >= 60 ? best : observed;
}

async function loadFtdcProvenance(sourceId, roster) {
  const box = document.getElementById('ftdc-provenance');
  if (!box) return;
  try {
    const sources = await api('/api/sources');
    const src = sources.find(s => s.id === sourceId);
    const prov = src && src.ftdcProvenance;
    if (!prov || !prov.nodes || Object.keys(prov.nodes).length === 0) return;
    const fmt = iso => { try { return new Date(iso).toLocaleDateString(); } catch { return iso; } };
    // Collapse raw provenance keys onto canonical node names, merging ranges.
    const merged = {};
    for (const raw of Object.keys(prov.nodes)) {
      const name = reconcileNodeName(raw, roster || []);
      const r = prov.nodes[raw];
      const cur = merged[name];
      merged[name] = cur
        ? { from: (r.from < cur.from ? r.from : cur.from), to: (r.to > cur.to ? r.to : cur.to) }
        : { from: r.from, to: r.to };
    }
    const nodeNames = Object.keys(merged);
    const ranges = nodeNames.map(n => esc(n) + ': ' + fmt(merged[n].from) + '→' + fmt(merged[n].to));
    const imports = (prov.imports || []).length;
    box.innerHTML = 'FTDC ingested (' + nodeNames.length + ' node' + (nodeNames.length>1?'s':'') + ', ' + imports + ' import' + (imports>1?'s':'') + '): '
      + '<span title="' + esc(ranges.join('\\n')) + '">' + esc(ranges.slice(0,2).join(' · ')) + (ranges.length>2 ? ' · +' + (ranges.length-2) + ' more' : '') + '</span>';
  } catch { /* non-fatal */ }
}

// Empty-state placeholder shown when a report has never been computed: a titled
// panel with a button to compute it on demand (fn = loadCapacity/loadRisks).
function reportPlaceholder(title, note, fn, sourceId) {
  return '<div class="panel" style="margin-bottom:20px">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">'
    + '<div><div style="font-weight:600">' + esc(title) + '</div>'
    + '<div class="muted" style="font-size:12px;margin-top:2px">' + esc(note) + '</div></div>'
    + '<button class="ghost" onclick="' + fn + "('" + esc(sourceId) + "')" + '">Compute now</button>'
    + '</div></div>';
}

// Auto-display the cached capacity report if one exists (no compute); otherwise
// render a placeholder with a "Compute now" button.
async function showCapacity(sourceId) {
  const panel = document.getElementById('capacity-panel');
  if (!panel) return;
  try {
    const r = await fetch('/api/sources/' + sourceId + '/capacity?cachedOnly=1');
    if (r.status === 204) {
      panel.innerHTML = reportPlaceholder('Capacity & scaling', 'Not yet computed for the latest scan.', 'loadCapacity', sourceId);
      return;
    }
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
    panel.innerHTML = capacityPanel(await r.json(), sourceId);
  } catch (e) {
    panel.innerHTML = reportPlaceholder('Capacity & scaling', 'Unavailable: ' + e.message, 'loadCapacity', sourceId);
  }
}

// Auto-display the cached risk report if one exists (no compute); otherwise
// render a placeholder with a "Compute now" button.
async function showRisks(sourceId) {
  const panel = document.getElementById('risk-panel');
  if (!panel) return;
  try {
    const r = await fetch('/api/sources/' + sourceId + '/risks?cachedOnly=1');
    if (r.status === 204) {
      panel.innerHTML = reportPlaceholder('Risk register', 'Not yet assessed for the latest scan.', 'loadRisks', sourceId);
      return;
    }
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
    panel.innerHTML = riskPanel(await r.json(), sourceId);
  } catch (e) {
    panel.innerHTML = reportPlaceholder('Risk register', 'Unavailable: ' + e.message, 'loadRisks', sourceId);
  }
}

async function loadCapacity(sourceId, refresh) {
  const panel = document.getElementById('capacity-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">' + (refresh ? 'Recomputing capacity report…' : 'Computing capacity report…') + '</div></div>';
  try {
    const r = await api('/api/sources/' + sourceId + '/capacity' + (refresh ? '?refresh=1' : ''));
    panel.innerHTML = capacityPanel(r, sourceId);
  } catch (e) {
    panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Capacity unavailable: ' + esc(e.message) + '</div></div>';
  }
}

async function loadRisks(sourceId, refresh) {
  const panel = document.getElementById('risk-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">' + (refresh ? 'Re-assessing against the risk register…' : 'Assessing against the risk register…') + '</div></div>';
  try {
    const r = await api('/api/sources/' + sourceId + '/risks' + (refresh ? '?refresh=1' : ''));
    panel.innerHTML = riskPanel(r, sourceId);
  } catch (e) {
    panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Risk assessment unavailable: ' + esc(e.message) + '</div></div>';
  }
}

// A small header line shown on cached reports: when it was last computed plus a
// Refresh button that forces a recompute. kind is 'capacity' or 'risks'.
function cacheMeta(r, sourceId, kind) {
  const when = r.cached && r.cachedAt
    ? 'Last computed ' + fmtWhen(r.cachedAt)
    : 'Just computed';
  const fn = kind === 'capacity' ? 'loadCapacity' : 'loadRisks';
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
    + '<span class="muted" style="font-size:11px">' + (r.cached ? '⟳ cached · ' : '') + esc(when) + '</span>'
    + '<button class="ghost" style="font-size:11px;padding:2px 8px" onclick="' + fn + "('" + esc(sourceId) + "', true)" + '">Refresh</button>'
    + '</div>';
}

/** Human-friendly relative/absolute timestamp for a stored ISO date. */
function fmtWhen(iso) {
  try {
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    return d.toLocaleString();
  } catch { return esc(iso); }
}

// Toggle folder selection on the Add-deployment offline file input.
function onOfflineDir() {
  const el = document.getElementById('offlineFile');
  const on = document.getElementById('offlineDir').checked;
  if (on) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  else { el.removeAttribute('webkitdirectory'); el.removeAttribute('directory'); }
  el.value = '';
}

/**
 * Upload any mix of diagnostic files (getMongoData / mdiag / FTDC, multi-node)
 * in one multipart request to the unified import endpoint. If sourceId is given,
 * the files enrich that deployment; otherwise a new one is created.
 */
async function importDiagnostics(files, name, sourceId, silent) {
  if (!files || files.length === 0) return;
  const status = sourceId ? document.getElementById('ftdc-status') : null;
  const note = (m) => { if (status) status.textContent = m; };
  note('Uploading ' + files.length + ' file(s)…');
  const fd = new FormData();
  if (name) fd.append('name', name);
  for (const f of files) fd.append('files', f, f.name);
  const base = sourceId ? '/api/sources/' + encodeURIComponent(sourceId) + '/import' : '/api/sources/import';
  const r = await fetch(base, { method: 'POST', body: fd });
  if (!r.ok) {
    const msg = (await r.json().catch(()=>({}))).error || r.statusText;
    if (silent) throw new Error(msg);
    if (sourceId) { note('Import failed: ' + msg); } else { alert('Import failed: ' + msg); }
    return;
  }
  const res = await r.json();
  if ((res.warnings||[]).length) console.warn('import warnings:', res.warnings);
  if (silent) return res; // caller (addSource) drives the next step
  const c = res.counts || {};
  const summary = 'Imported: ' + (c.getMongoData||0) + ' getMongoData · ' + (c.mdiag||0) + ' mdiag · ' + (c.ftdc||0) + ' FTDC · ' + (c.mongodLog||0) + ' mongod.log'
    + (c.unknown ? ' · ' + c.unknown + ' unrecognized' : '') + ' (' + (res.nodes||[]).length + ' node(s))';
  if (sourceId) {
    note(summary + ' — refreshing…');
    const fleet = await api('/api/fleet');
    const f = fleet.find(x => x.source.id === res.sourceId);
    if (f && f.latestScanId) openDetail(res.sourceId, f.latestScanId);
    else openDetail(res.sourceId, null);
  } else {
    alert(summary);
    renderFleet();
  }
}

function uploadBundle(sourceId, inputEl) {
  const files = inputEl && inputEl.files;
  if (!files || files.length === 0) return;
  importDiagnostics([...files], undefined, sourceId);
}

function riskStatusBadge(s) {
  const map = { detected: ['crit','Detected'], suggested: ['warn','Suggested'], manual: ['info','Review'], unknown: ['info','Unknown'], clear: ['ok','Clear'] };
  const [cls, label] = map[s] || ['info', s];
  return '<span class="badge ' + cls + '">' + label + '</span>';
}

function riskPanel(r, sourceId) {
  const c = r.counts;
  const summary = '<div class="pills" style="margin-bottom:12px">'
    + '<span class="pill crit">' + c.detected + ' detected</span>'
    + '<span class="pill warn">' + c.suggested + ' suggested</span>'
    + '<span class="pill info">' + c.manual + ' manual review</span>'
    + '<span class="pill">' + c.clear + ' clear</span>'
    + '<span class="pill">' + c.unknown + ' unknown</span></div>';
  // Show detected + suggested + manual (hide clear/unknown behind a toggle via <details>).
  const active = r.assessments.filter(a => a.status === 'detected' || a.status === 'suggested');
  const review = r.assessments.filter(a => a.status === 'manual');
  const other = r.assessments.filter(a => a.status === 'clear' || a.status === 'unknown');
  const rowHtml = a =>
    '<div class="finding">'
    + '<div class="ftitle">' + riskStatusBadge(a.status)
    + ' <span class="badge ' + (a.risk.level==='high'?'crit':a.risk.level==='medium'?'warn':'info') + '">' + esc((a.risk.level||'').toUpperCase()) + '</span> '
    + esc(a.risk.name.split(':')[0]) + ' <code>#' + esc(a.risk.id) + '</code>'
    + (a.confidence!=null?' <span class="muted" style="font-size:11px">conf ' + Math.round(a.confidence*100) + '%</span>':'') + '</div>'
    + (a.detail?'<div class="fdetail">' + esc(a.detail) + '</div>':'')
    + (a.risk.recommendation?'<div class="fdetail">→ ' + esc(a.risk.recommendation.slice(0,240)) + '</div>':'')
    + '</div>';
  return '<div class="panel" style="margin-bottom:20px">'
    + '<div style="font-weight:600;margin-bottom:8px">Risk register <span class="muted" style="font-weight:400;font-size:12px">(' + r.assessments.length + ' expert risks)</span></div>'
    + cacheMeta(r, sourceId, 'risks')
    + summary
    + (active.length? '<div class="muted" style="font-size:12px;margin:6px 0 4px">Detected &amp; suggested</div>' + active.map(rowHtml).join('') : '<div class="muted">No risks auto-detected.</div>')
    + (review.length? '<details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:12px">' + review.length + ' risks needing manual review</summary><div style="margin-top:8px">' + review.map(rowHtml).join('') + '</div></details>' : '')
    + (other.length? '<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">' + other.length + ' clear / not-evaluable</summary><div style="margin-top:8px">' + other.map(rowHtml).join('') + '</div></details>' : '')
    + '</div>';
}

function gaugeRow(u) {
  if (u.unbounded || u.p95Pct == null) {
    return '<div class="grow"><span class="glabel">' + esc(u.resource) + '</span><span class="muted">' + (u.currentPct!=null?u.currentPct+'%':'—') + ' (no limit)</span></div>';
  }
  const p = Math.min(100, u.p95Pct);
  const color = p >= 85 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--green)';
  return '<div class="grow"><span class="glabel">' + esc(u.resource) + '</span>'
    + '<div class="gbar"><div style="width:' + p.toFixed(0) + '%;background:' + color + '"></div></div>'
    + '<span class="gval">' + (u.currentPct!=null?u.currentPct+'%':'?') + ' now · ' + u.p95Pct + '% p95</span></div>';
}

function scaleCard(scale) {
  const dir = scale.direction;
  if (dir === 'none') {
    return '<div class="scalecard none"><strong>No scaling needed</strong><div class="muted">' + esc(scale.rationale) + '</div></div>';
  }
  const icon = dir === 'up' ? '▲ Scale up' : dir === 'out' ? '⇔ Scale out' : '▼ Scale down (cost)';
  const cls = dir === 'down' ? 'down' : 'up';
  const tier = scale.currentTier && scale.targetTier ? (esc(scale.currentTier) + ' → ' + esc(scale.targetTier)) : (scale.targetTier ? esc(scale.targetTier) : '');
  return '<div class="scalecard ' + cls + '">'
    + '<div style="font-size:15px;font-weight:700">' + icon + (tier?' &nbsp;<span style="font-weight:500">' + tier + '</span>':'') + (scale.factor?' &nbsp;<span class="muted">×' + scale.factor + '</span>':'') + '</div>'
    + '<div class="muted" style="margin-top:6px">' + esc(scale.rationale) + '</div>'
    + (scale.confidence!=null?'<div class="muted" style="font-size:11px;margin-top:4px">confidence ' + Math.round(scale.confidence*100) + '%</div>':'')
    + '</div>';
}

function capacityPanel(r, sourceId) {
  const limitNote = r.hasLimits ? '' : '<div class="muted" style="font-size:12px;margin-bottom:10px">⚠ Limits unknown — add an Atlas API key + cluster name for full capacity analysis.</div>';
  // Growth
  const disk = (r.growth || []).find(g => g.metric && g.metric.indexOf('DISK') >= 0);
  let growthHtml = '<div class="muted">No growth trend yet.</div>';
  if (disk) {
    const perWk = disk.perWeekBytes != null ? fmtBytes(disk.perWeekBytes) : '—';
    const full = disk.daysUntilFull != null ? ('full in ~' + disk.daysUntilFull + ' days (' + (disk.projectedFullDate||'') + ')') : 'no fill projected';
    growthHtml = '<div><strong>Disk growth:</strong> ' + perWk + '/week'
      + (disk.perWeekPct!=null?' (' + disk.perWeekPct + '%/wk)':'') + ' · <strong>' + full + '</strong>'
      + ' <span class="muted">R²=' + disk.confidenceR2 + '</span></div>';
  }
  // Utilization gauges
  const gauges = (r.utilization || []).map(gaugeRow).join('') || '<div class="muted">No utilization data.</div>';
  // Bottlenecks
  const bn = (r.bottlenecks || []).slice(0,6).map(b =>
    '<div class="bnrow"><span class="bnscore" style="background:' + (b.score>=0.7?'var(--red)':b.score>=0.4?'var(--amber)':'var(--border)') + '">' + Math.round(b.score*100) + '</span>'
    + '<span class="muted" style="font-size:11px">' + esc(b.kind||'') + '</span> ' + esc(b.detail) + '</div>').join('') || '<div class="muted">None.</div>';

  return '<div class="panel" style="margin-bottom:20px">'
    + '<div style="font-weight:600;margin-bottom:8px">Capacity &amp; scaling <span class="muted" style="font-weight:400;font-size:12px">(last ' + r.windowDays + ' days)</span></div>'
    + cacheMeta(r, sourceId, 'capacity')
    + limitNote
    + scaleCard(r.scale)
    + '<div style="margin:14px 0 6px">' + growthHtml + '</div>'
    + '<div class="muted" style="font-size:12px;margin:14px 0 4px">Utilization (current · p95 vs limit)</div>'
    + gauges
    + '<div class="muted" style="font-size:12px;margin:14px 0 4px">Top bottlenecks</div>'
    + bn
    + (r.notes && r.notes.length ? '<div class="muted" style="font-size:11px;margin-top:10px">' + r.notes.map(esc).join(' ') + '</div>' : '')
    + '</div>';
}

async function removeSource(sourceId, name) {
  if (!confirm('Deregister "' + name + '"? This removes it from the fleet (does not touch the cluster).')) return;
  try {
    await api('/api/sources/' + sourceId, { method: 'DELETE' });
    render();  // back to fleet
  } catch (e) { alert('Failed to remove: ' + e.message); }
}

async function renderRisks() {
  el.innerHTML = '<div class="empty">Loading risks…</div>';
  const risks = await api('/api/risks');
  if (risks.length === 0) { el.innerHTML = '<div class="empty">No findings across the fleet. 🎉</div>'; return; }
  const rows = risks.map(r => \`<tr>
      <td><span class="badge \${sevClass(r.severity)}">\${r.severity.toUpperCase()}</span></td>
      <td>\${esc(r.title)}<div class="muted" style="font-size:12px">\${esc(r.detail)}</div></td>
      <td>\${esc(r.sourceName)}</td>
      <td><code>\${esc(r.category)}</code></td>
      <td><code>\${esc(r.checkId)}</code></td>
    </tr>\`).join('');
  el.innerHTML = '<div class="panel"><table><thead><tr><th>Severity</th><th>Finding</th><th>Deployment</th><th>Category</th><th>Check</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// --- risk catalog management ---
let _catalog = [];
async function renderCatalog() {
  el.innerHTML = '<div class="empty">Loading catalog…</div>';
  try { _catalog = await api('/api/catalog'); }
  catch (e) { el.innerHTML = '<div class="empty">'+esc(e.message)+'</div>'; return; }
  const enabled = _catalog.filter(r => r.enabled !== false).length;
  const toolbar = \`
    <div class="form" style="align-items:center">
      <strong>Risk catalog</strong>
      <span class="muted" style="font-size:12px">\${_catalog.length} risks · \${enabled} enabled</span>
      <span style="flex:1"></span>
      <button class="ghost" onclick="catalogAdd()">+ Add risk</button>
      <a class="ghost" style="text-decoration:none;padding:8px 14px;border:1px solid var(--border);border-radius:6px" href="/api/catalog/export">Export JSON</a>
      <button class="ghost" onclick="document.getElementById('catImport').click()">Import…</button>
      <input type="file" id="catImport" accept=".json,.xlsx" style="display:none" onchange="catalogImport(this)" />
    </div>\`;
  const rows = _catalog.map(r => {
    const on = r.enabled !== false;
    const lvl = r.level==='high'?'crit':r.level==='medium'?'warn':'info';
    return \`<tr style="\${on?'':'opacity:.5'}">
      <td><code>\${esc(r.id)}</code></td>
      <td><span class="badge \${lvl}">\${esc((r.level||'').toUpperCase())}</span></td>
      <td>\${esc((r.name||'').split(':')[0])}</td>
      <td style="white-space:nowrap">
        <label class="switch"><input type="checkbox" \${on?'checked':''} onchange="catalogToggle('\${esc(r.id)}', this.checked)"/> <span class="muted" style="font-size:11px">\${on?'on':'off'}</span></label>
      </td>
      <td style="white-space:nowrap">
        <button class="linkbtn" onclick="catalogEdit('\${esc(r.id)}')">edit</button>
        <button class="linkbtn danger" onclick="catalogDelete('\${esc(r.id)}', '\${esc((r.name||'').split(':')[0])}')">delete</button>
      </td>
    </tr>\`;
  }).join('');
  el.innerHTML = toolbar + '<div class="panel"><table><thead><tr><th>ID</th><th>Level</th><th>Name</th><th>Enabled</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function catalogToggle(id, enabled) {
  try { await api('/api/catalog/' + encodeURIComponent(id), { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) }); renderCatalog(); }
  catch (e) { alert('Failed: ' + e.message); }
}
async function catalogDelete(id, name) {
  if (!confirm('Delete risk "' + name + '"?')) return;
  try { await api('/api/catalog/' + encodeURIComponent(id), { method:'DELETE' }); renderCatalog(); }
  catch (e) { alert('Failed: ' + e.message); }
}
function catalogAdd() { catalogForm({ id:'', level:'medium', status:'Active', name:'', description:'', recommendation:'', enabled:true }, true); }
function catalogEdit(id) { const r = _catalog.find(x => x.id === id); if (r) catalogForm(r, false); }
function catalogForm(r, isNew) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = \`<div class="modal">
    <h3 style="margin:0 0 12px">\${isNew?'Add risk':'Edit risk'}</h3>
    <label>ID \${isNew?'':'(read-only)'}</label><input id="f_id" value="\${esc(r.id)}" \${isNew?'':'readonly'} />
    <label>Level</label><select id="f_level">\${['high','medium','low'].map(l=>'<option '+(r.level===l?'selected':'')+'>'+l+'</option>').join('')}</select>
    <label>Name</label><input id="f_name" value="\${esc(r.name)}" />
    <label>Description</label><textarea id="f_desc" rows="3">\${esc(r.description||'')}</textarea>
    <label>Recommendation</label><textarea id="f_reco" rows="2">\${esc(r.recommendation||'')}</textarea>
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
      <button class="ghost" onclick="this.closest('.overlay').remove()">Cancel</button>
      <button class="action" id="f_save">Save</button>
    </div></div>\`;
  document.body.appendChild(ov);
  ov.querySelector('#f_save').onclick = async () => {
    const body = {
      id: ov.querySelector('#f_id').value.trim(),
      level: ov.querySelector('#f_level').value,
      status: r.status || 'Active',
      name: ov.querySelector('#f_name').value.trim(),
      description: ov.querySelector('#f_desc').value.trim(),
      recommendation: ov.querySelector('#f_reco').value.trim(),
      enabled: r.enabled !== false,
    };
    if (!body.name) return alert('Name is required');
    try {
      if (isNew) await api('/api/catalog', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      else await api('/api/catalog/' + encodeURIComponent(body.id), { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      ov.remove(); renderCatalog();
    } catch (e) { alert('Save failed: ' + e.message); }
  };
}
async function catalogImport(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  if (file.name.endsWith('.xlsx')) { alert('For .xlsx, run: npm run risks:convert "file.xlsx" then import the generated JSON. Only JSON import is supported in the UI.'); inputEl.value=''; return; }
  const mode = confirm('Import mode:\\n  OK = REPLACE entire catalog\\n  Cancel = MERGE (upsert by id)') ? 'replace' : 'merge';
  try {
    const text = await file.text();
    const r = await fetch('/api/catalog/import?mode=' + mode, { method:'POST', body: text });
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
    const res = await r.json();
    alert('Imported ' + res.imported + ' risks (' + res.mode + ').');
    renderCatalog();
  } catch (e) { alert('Import failed: ' + e.message); }
  inputEl.value = '';
}

// --- chat drawer ---
const chatThread = 'web-' + Math.random().toString(36).slice(2, 10);
let chatReady = null;
async function toggleChat() {
  const d = document.getElementById('drawer');
  const opening = !d.classList.contains('open');
  d.classList.toggle('open');
  if (opening && chatReady === null) {
    try { chatReady = (await api('/api/chat/available')).available; }
    catch { chatReady = false; }
    if (!chatReady) {
      document.getElementById('chatInput').style.display = 'none';
      addMsg('bot', 'Chat is unavailable: no LLM provider configured. Set an API key or PS_AGENT_LLM_PROVIDER=ollama with PS_AGENT_LLM_MODEL, then restart the server.');
    } else {
      addMsg('bot', 'Hi! Ask me about your fleet — e.g. "which deployment is least healthy and why?"');
    }
  }
  if (opening) document.getElementById('chatText').focus();
}
function addMsg(role, text) {
  const m = document.createElement('div');
  m.className = 'msg ' + role;
  m.textContent = text;
  document.getElementById('msgs').appendChild(m);
  m.scrollIntoView();
  return m;
}
async function sendChat() {
  const input = document.getElementById('chatText');
  const text = input.value.trim();
  if (!text || !chatReady) return;
  input.value = '';
  addMsg('user', text);
  const bot = addMsg('bot', '…');
  const tools = [];
  let reply = '';
  try {
    const r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ threadId: chatThread, message: text }) });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\\n\\n'); buf = parts.pop();
      for (const p of parts) {
        const line = p.replace(/^data: /, '').trim();
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'tool_call') { tools.push(ev.name); bot.textContent = '⚙ running ' + ev.name + '…'; }
        else if (ev.type === 'reply') { reply = ev.text; }
        else if (ev.type === 'error') { reply = 'Error: ' + ev.error; }
      }
    }
  } catch (e) { reply = 'Error: ' + e.message; }
  bot.textContent = reply || '(no answer)';
  if (tools.length) {
    const t = document.createElement('div'); t.className = 'tools';
    t.textContent = 'tools: ' + tools.join(', ');
    bot.appendChild(t);
  }
  bot.scrollIntoView();
}

// --- live updates via SSE ---
function startLiveUpdates() {
  const dot = document.getElementById('livedot');
  const text = document.getElementById('livetext');
  const es = new EventSource('/api/events');
  es.onopen = () => { dot.classList.add('live'); text.textContent = 'Live updates connected'; };
  es.onerror = () => { dot.classList.remove('live'); text.textContent = 'Live updates reconnecting…'; };
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    const card = document.getElementById('card-' + ev.sourceId);
    if (ev.type === 'scan.started') {
      text.textContent = 'Scanning ' + (ev.sourceName || ev.sourceId) + '…';
      if (card) card.classList.add('scanning');
    } else if (ev.type === 'scan.completed') {
      text.textContent = 'Scan completed: ' + ev.sourceName + ' → ' + ev.scoreValue + '/100';
      if (card) card.classList.remove('scanning');
      if (view === 'fleet') renderFleet();  // refresh scores
    } else if (ev.type === 'scan.failed') {
      text.textContent = 'Scan failed: ' + ev.error;
      if (card) card.classList.remove('scanning');
    } else if (ev.type === 'schedule.changed') {
      text.textContent = 'Schedule updated';
    }
  };
}

render();
startLiveUpdates();
</script>
</body>
</html>`;
}
