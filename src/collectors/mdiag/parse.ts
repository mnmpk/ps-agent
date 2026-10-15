import type { OsFacts } from "../../core/types.js";

/**
 * Parses MongoDB's mdiag.sh JSON export into OsFacts (the OS/kernel tunings that
 * getMongoData can't see): swappiness, max_map_count, TCP keepalive, THP,
 * read-ahead, ulimits, SELinux, NUMA, I/O scheduler.
 *
 * mdiag --json output is a JSON array of entries:
 *   { section, subsection?, output: [..lines], command?, rc?, error? }
 * Most values are arrays of raw command/file text lines, so we grep them.
 * Defensive: missing sections → the field is left undefined (evaluators then
 * report "unknown"), never throws on a malformed entry.
 */
interface MdiagEntry {
  section?: string;
  subsection?: string;
  output?: unknown;
  ref?: string;
  version?: string;
}

export function parseMdiag(raw: string): OsFacts {
  const warnings: string[] = [];
  const entries = loadEntries(raw);

  const os: OsFacts = { warnings };

  // Provenance.
  const first = entries.find((e) => e.version || e.ref);
  os.mdiagVersion = first?.version;
  os.mdiagRef = first?.ref;

  // Hostname (for grouping node-level imports). mdiag runs `hostname` and
  // `uname -a`; take the first non-empty token.
  const hostLines = linesOf(
    entries.find((e) => e.section === "hostname" || e.subsection === "hostname"),
  );
  for (const l of hostLines) {
    const h = l.trim();
    if (h) {
      os.hostname = h.split(/\s+/)[0];
      break;
    }
  }
  if (!os.hostname) {
    // Fallback: uname -n style "... nodename ..." isn't reliable; try FQDN in uname.
    const uname = linesOf(entries.find((e) => e.section === "uname")).join(" ");
    const m = uname.match(/\b([a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+)\b/i);
    if (m) os.hostname = m[1];
  }

  // --- sysctl -a → vm.swappiness, vm.max_map_count, tcp_keepalive_time, somaxconn
  const sysctl = linesOf(entries.find((e) => e.section === "sysctl"));
  if (sysctl.length) {
    os.swappiness = sysctlNum(sysctl, "vm.swappiness");
    os.maxMapCount = sysctlNum(sysctl, "vm.max_map_count");
    os.tcpKeepaliveTime = sysctlNum(sysctl, "net.ipv4.tcp_keepalive_time");
    os.somaxconn = sysctlNum(sysctl, "net.core.somaxconn");
  } else {
    warnings.push("mdiag: no sysctl section.");
  }

  // --- transparent_hugepage → enabled + defrag (bracketed value is the active one)
  const thp = entries.filter((e) => e.section === "transparent_hugepage");
  for (const e of thp) {
    const sub = (e.subsection ?? "").toLowerCase();
    const active = bracketed(linesOf(e).join("\n"));
    if (!active) continue;
    if (sub.includes("defrag")) os.thpDefrag = active;
    else if (sub.includes("enabled")) os.transparentHugePages = active;
    else if (os.transparentHugePages == null) os.transparentHugePages = active;
  }

  // --- read_ahead_kb → max across devices
  const ra = entries.filter((e) => e.section === "read_ahead_kb");
  let maxRa: number | undefined;
  for (const e of ra) {
    for (const l of linesOf(e)) {
      const n = Number(l.trim());
      if (Number.isFinite(n)) maxRa = Math.max(maxRa ?? 0, n);
    }
  }
  os.readAheadKb = maxRa;

  // --- ulimit -a → open files (-n), max processes (-u)
  const ulimit = linesOf(entries.find((e) => e.section === "ulimit"));
  for (const l of ulimit) {
    const mNofile = l.match(/open files\s*\(.*?\)\s+(\d+|unlimited)/i);
    if (mNofile) os.openFilesLimit = mNofile[1] === "unlimited" ? Infinity : Number(mNofile[1]);
    const mProc = l.match(/max user processes\s*\(.*?\)\s+(\d+|unlimited)/i);
    if (mProc) os.maxProcessesLimit = mProc[1] === "unlimited" ? Infinity : Number(mProc[1]);
  }

  // --- selinux (sestatus)
  const selinux = linesOf(entries.find((e) => e.section === "selinux"));
  for (const l of selinux) {
    const m = l.match(/Current mode:\s*(\w+)/i) || l.match(/SELinux status:\s*(\w+)/i);
    if (m) os.selinux = m[1]!.toLowerCase();
  }

  // --- numactl → NUMA present?
  const numa = entries.filter((e) => e.section === "numactl");
  for (const e of numa) {
    const text = linesOf(e).join("\n").toLowerCase();
    if (/available:\s*([2-9]|\d{2,})\s*nodes/.test(text)) os.numa = true;
    else if (/available:\s*1\s*node/.test(text) && os.numa == null) os.numa = false;
  }

  // --- I/O scheduler (bracketed active one)
  const sched = entries.filter((e) => e.section === "scheduler");
  for (const e of sched) {
    const active = bracketed(linesOf(e).join("\n"));
    if (active) {
      os.ioScheduler = os.ioScheduler ? `${os.ioScheduler},${active}` : active;
    }
  }

  return os;
}

// --- helpers ---------------------------------------------------------------

function loadEntries(raw: string): MdiagEntry[] {
  let text = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // mdiag closes the array by replacing the last "}," — if truncated, salvage.
    const end = text.lastIndexOf("]");
    if (end > 0) {
      try {
        parsed = JSON.parse(text.slice(0, end + 1));
      } catch {
        throw new Error("mdiag file is not valid JSON (run mdiag.sh with --json).");
      }
    } else {
      throw new Error("mdiag file is not valid JSON (run mdiag.sh with --json).");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("mdiag file must be a JSON array (run with --json).");
  }
  return parsed as MdiagEntry[];
}

/** An entry's `output` as a flat array of text lines. */
function linesOf(e: MdiagEntry | undefined): string[] {
  if (!e) return [];
  const o = e.output;
  if (Array.isArray(o)) return o.map((x) => String(x));
  if (typeof o === "string") return o.split("\n");
  return [];
}

/** Parse "key = value" from sysctl -a lines. */
function sysctlNum(lines: string[], key: string): number | undefined {
  for (const l of lines) {
    const m = l.match(new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*(-?\\d+)`));
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** THP/scheduler files print choices with the active one in [brackets]. */
function bracketed(text: string): string | undefined {
  const m = text.match(/\[([a-z0-9_-]+)\]/i);
  return m ? m[1] : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
