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
        <input id="name" placeholder="Name" style="width:180px" />
        <select id="kind" onchange="onKindChange()">
          <option value="direct">Direct (connection string)</option>
          <option value="mcp">MCP server</option>
          <option value="atlas">Atlas API</option>
          <option value="opsmanager">Ops Manager</option>
          <option value="offline">Offline (import diagnostics)</option>
        </select>
        <button class="action" onclick="addSource()">Add deployment</button>
      </div>
      <div class="addfields" id="fields-direct">
        <input class="uri" id="uri" placeholder="mongodb://user:pass@host:27017/" />
      </div>
      <div class="addfields" id="fields-mcp" style="display:none">
        <select id="mcpTransport" onchange="onMcpTransportChange()">
          <option value="stdio">stdio (spawn command)</option>
          <option value="http">http (url)</option>
        </select>
        <input id="mcpCommand" placeholder="npx -y mongodb-mcp-server" style="flex:1;min-width:240px" />
        <input id="mcpUrl" placeholder="http://localhost:3000/mcp" style="flex:1;min-width:240px;display:none" />
        <input class="uri" id="mcpConn" placeholder="mongodb://… (optional, enables deep check)" />
      </div>
      <div class="addfields" id="fields-atlas" style="display:none">
        <input id="atlasGroup" placeholder="Project (group) ID" style="width:200px" />
        <input id="atlasPub" placeholder="Public key" style="width:160px" />
        <input id="atlasPriv" placeholder="Private key" style="width:220px" />
        <input id="atlasCluster" placeholder="Cluster name (optional)" style="width:180px" />
      </div>
      <div class="addfields" id="fields-opsmanager" style="display:none">
        <input id="omUrl" placeholder="https://opsmgr.example.com:8080" style="width:260px" />
        <input id="omGroup" placeholder="Project (group) ID" style="width:200px" />
        <input id="omPub" placeholder="Public key" style="width:160px" />
        <input id="omPriv" placeholder="Private key" style="width:220px" />
      </div>
      <div class="addfields" id="fields-offline" style="display:none;flex-direction:column;align-items:flex-start;gap:6px">
        <input type="file" id="offlineFile" multiple />
        <label class="muted" style="font-size:12px;cursor:pointer"><input type="checkbox" id="offlineDir" onchange="onOfflineDir()" /> select a whole folder instead</label>
        <span class="muted" style="font-size:12px">Drop in ANY mix of getMongoData, mdiag, and FTDC files — across multiple nodes. Each file is auto-detected and imported into one deployment.</span>
      </div>
      <div id="atlas-extra" style="display:none;margin-top:8px">
        <label class="muted" style="font-size:12px;cursor:pointer">
          <input type="checkbox" id="wantTrends" onchange="onWantTrends()" />
          Add Atlas API key for trends &amp; capacity analysis (growth, bottlenecks, scaling)
        </label>
        <div class="addfields" id="fields-trends" style="display:none;margin-top:8px">
          <input id="tGroup" placeholder="Atlas project (group) ID" style="width:200px" />
          <input id="tPub" placeholder="Public key" style="width:160px" />
          <input id="tPriv" placeholder="Private key" style="width:220px" />
          <input id="tCluster" placeholder="Cluster name" style="width:180px" />
        </div>
      </div>
      <div class="muted" id="addhint" style="font-size:12px;margin-top:4px"></div>
    </div>\`;
  if (fleet.length === 0) {
    el.innerHTML = form + '<div class="empty">No deployments registered yet. Add one above.</div>';
    onKindChange();
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
      <div class="host">\${esc(f.source.connectionString || f.source.kind)}</div>
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
  onKindChange();
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
  btns.forEach(b => { b.disabled = true; b.textContent = 'Scanning…'; });
  try {
    await api('/api/sources/' + sourceId + '/scan' + (summarize ? '?summarize=1' : ''), { method: 'POST' });
    // Refresh current view (live-updates also triggers this on scan.completed).
    render();
  } catch (e) {
    alert('Scan failed: ' + e.message);
    btns.forEach(b => { b.disabled = false; b.textContent = 'Scan now'; });
  }
}

function onKindChange() {
  const kind = document.getElementById('kind').value;
  for (const k of ['direct','mcp','atlas','opsmanager','offline']) {
    document.getElementById('fields-' + k).style.display = (k === kind) ? 'flex' : 'none';
  }
  // The "add Atlas API for trends" expander only makes sense for direct/MCP.
  document.getElementById('atlas-extra').style.display = (kind === 'direct' || kind === 'mcp') ? 'block' : 'none';
  const hints = {
    direct: 'Deep driver check (replication, serverStatus, indexes, storage). Add an Atlas API key below for growth/capacity trends.',
    mcp: 'Scans via a MongoDB MCP server. Add a connection string for a deep "mcp+direct" check, and an Atlas API key below for trends.',
    atlas: 'Uses the Atlas Admin API (Project Read Only key). Unlocks trends, capacity & bottleneck analysis.',
    opsmanager: 'Self-managed via Ops Manager Public API (base URL + project ID + API key). Unlocks metrics, trends, capacity & bottlenecks (no cluster-tier limits).',
    offline: 'For isolated clusters: run MongoDB\\'s getMongoData.js on the node and upload the log here \u2014 no connection needed.',
  };
  document.getElementById('addhint').textContent = hints[kind] || '';
}
function onMcpTransportChange() {
  const t = document.getElementById('mcpTransport').value;
  document.getElementById('mcpCommand').style.display = (t === 'stdio') ? '' : 'none';
  document.getElementById('mcpUrl').style.display = (t === 'http') ? '' : 'none';
}
function onWantTrends() {
  const on = document.getElementById('wantTrends').checked;
  document.getElementById('fields-trends').style.display = on ? 'flex' : 'none';
}

function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

async function addSource() {
  const name = val('name') || 'deployment';
  const kind = document.getElementById('kind').value;
  let body = { name };

  // Offline: upload ANY mix of diagnostic files (getMongoData/mdiag/FTDC) in one
  // multipart request; the server auto-detects + ingests into one deployment.
  if (kind === 'offline') {
    const fileEl = document.getElementById('offlineFile');
    const files = fileEl && fileEl.files;
    if (!files || files.length === 0) return alert('Choose diagnostic files (or a folder) to upload');
    return importDiagnostics([...files], name !== 'deployment' ? name : undefined);
  }

  if (kind === 'direct') {
    const uri = val('uri');
    if (!uri) return alert('Enter a connection string');
    body.connectionString = uri;
  } else if (kind === 'mcp') {
    const transport = document.getElementById('mcpTransport').value;
    const mcp = { transport };
    if (transport === 'stdio') {
      if (!val('mcpCommand')) return alert('Enter the MCP server command');
      mcp.command = val('mcpCommand');
    } else {
      if (!val('mcpUrl')) return alert('Enter the MCP server URL');
      mcp.url = val('mcpUrl');
    }
    body.mcp = mcp;
    if (val('mcpConn')) body.connectionString = val('mcpConn'); // enables deep check
  } else if (kind === 'atlas') {
    if (!val('atlasGroup') || !val('atlasPub') || !val('atlasPriv'))
      return alert('Atlas needs project ID, public key, and private key');
    body.atlas = {
      projectId: val('atlasGroup'), publicKey: val('atlasPub'), privateKey: val('atlasPriv'),
      clusterName: val('atlasCluster') || undefined,
    };
  } else if (kind === 'opsmanager') {
    if (!val('omUrl') || !val('omGroup') || !val('omPub') || !val('omPriv'))
      return alert('Ops Manager needs base URL, project ID, public key, and private key');
    body.opsManager = {
      baseUrl: val('omUrl'), projectId: val('omGroup'),
      publicKey: val('omPub'), privateKey: val('omPriv'),
    };
  }

  // Optional Atlas API key attached to a direct/MCP source for trends/capacity.
  if ((kind === 'direct' || kind === 'mcp') && document.getElementById('wantTrends') && document.getElementById('wantTrends').checked) {
    if (!val('tGroup') || !val('tPub') || !val('tPriv') || !val('tCluster')) {
      return alert('Trends need Atlas project ID, public key, private key, AND cluster name (required for capacity limits)');
    }
    body.atlas = {
      projectId: val('tGroup'), publicKey: val('tPub'), privateKey: val('tPriv'),
      clusterName: val('tCluster'),
    };
  }

  try {
    const src = await api('/api/sources', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body) });
    await api('/api/sources/' + src.id + '/scan?summarize=1', { method:'POST' });
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
            <button class="action scanbtn" data-sid="\${scan.sourceId}" onclick="scanNow('\${scan.sourceId}', true)">Scan now</button>
            <button class="ghost" onclick="loadCapacity('\${scan.sourceId}')">Capacity</button>
            <button class="ghost" onclick="loadRisks('\${scan.sourceId}')">Risk register</button>
            <button class="ghost" onclick="document.getElementById('bundleFile').click()" title="Attach any mix of getMongoData, mdiag, or FTDC files (across nodes) — auto-detected and merged into this deployment">Import diagnostics…</button>
            <input type="file" id="bundleFile" multiple style="display:none" onchange="uploadBundle('\${scan.sourceId}', this)" />
            <button class="ghost" onclick="removeSource('\${scan.sourceId}', '\${esc(scan.sourceName)}')">Deregister</button>
          </div>
          <div class="muted" id="mdiag-status" style="font-size:11px;margin-top:4px;text-align:right">\${scan.facts.os ? 'mdiag attached ✓' : ''}</div>
          <div class="muted" id="ftdc-status" style="font-size:11px;margin-top:2px;text-align:right"></div>
          <div class="muted" id="ftdc-provenance" style="font-size:11px;margin-top:2px;text-align:right"></div>
        </div>
      </div>
    </div>
    \${analysis}
    <div id="capacity-panel"></div>
    <div id="risk-panel"></div>
    \${storagePanel(scan.facts.storage)}
    <h3>Findings (\${scan.findings.length})</h3>
    \${findings}\`;
  const roster = (scan.facts.replSetStatus && scan.facts.replSetStatus.members || []).map(m => m.name);
  loadFtdcProvenance(scan.sourceId, roster);
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

async function loadCapacity(sourceId) {
  const panel = document.getElementById('capacity-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Computing capacity report…</div></div>';
  try {
    const r = await api('/api/sources/' + sourceId + '/capacity');
    panel.innerHTML = capacityPanel(r);
  } catch (e) {
    panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Capacity unavailable: ' + esc(e.message) + '</div></div>';
  }
}

async function loadRisks(sourceId) {
  const panel = document.getElementById('risk-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Assessing against the risk register…</div></div>';
  try {
    const r = await api('/api/sources/' + sourceId + '/risks');
    panel.innerHTML = riskPanel(r);
  } catch (e) {
    panel.innerHTML = '<div class="panel" style="margin-bottom:20px"><div class="muted">Risk assessment unavailable: ' + esc(e.message) + '</div></div>';
  }
}

// Toggle folder selection on the Add-deployment offline file input.
function onOfflineDir() {
  const el = document.getElementById('offlineFile');
  const on = document.getElementById('offlineDir').checked;
  if (on) el.setAttribute('webkitdirectory', '');
  else el.removeAttribute('webkitdirectory');
  el.value = '';
}

/**
 * Upload any mix of diagnostic files (getMongoData / mdiag / FTDC, multi-node)
 * in one multipart request to the unified import endpoint. If sourceId is given,
 * the files enrich that deployment; otherwise a new one is created.
 */
async function importDiagnostics(files, name, sourceId) {
  if (!files || files.length === 0) return;
  const status = sourceId ? document.getElementById('ftdc-status') : null;
  const note = (m) => { if (status) status.textContent = m; };
  note('Uploading ' + files.length + ' file(s)…');
  try {
    const fd = new FormData();
    if (name) fd.append('name', name);
    for (const f of files) fd.append('files', f, f.name);
    const base = sourceId ? '/api/sources/' + encodeURIComponent(sourceId) + '/import' : '/api/sources/import';
    const r = await fetch(base, { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
    const res = await r.json();
    const c = res.counts || {};
    const summary = 'Imported: ' + (c.getMongoData||0) + ' getMongoData · ' + (c.mdiag||0) + ' mdiag · ' + (c.ftdc||0) + ' FTDC'
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
    if ((res.warnings||[]).length) console.warn('import warnings:', res.warnings);
  } catch (e) {
    if (sourceId) note('Import failed: ' + e.message);
    else alert('Import failed: ' + e.message);
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

function riskPanel(r) {
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

function capacityPanel(r) {
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
