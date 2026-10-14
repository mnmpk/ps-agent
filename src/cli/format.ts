import type { Finding, ScanResult, Severity } from "../core/types.js";

const RESET = "\x1b[0m";
const COLOR: Record<Severity, string> = {
  ok: "\x1b[32m", // green
  info: "\x1b[36m", // cyan
  warning: "\x1b[33m", // yellow
  critical: "\x1b[31m", // red
};
const LABEL: Record<Severity, string> = {
  ok: "OK",
  info: "INFO",
  warning: "WARN",
  critical: "CRIT",
};

function badge(sev: Severity, useColor: boolean): string {
  const text = `[${LABEL[sev].padEnd(4)}]`;
  return useColor ? `${COLOR[sev]}${text}${RESET}` : text;
}

function scoreColor(value: number, useColor: boolean): string {
  if (!useColor) return String(value);
  const c = value >= 85 ? COLOR.ok : value >= 60 ? COLOR.warning : COLOR.critical;
  return `${c}${value}${RESET}`;
}

const BOLD = "\x1b[1m";

export function formatScan(result: ScanResult, useColor = true): string {
  const { facts, findings, score, analysis } = result;
  const lines: string[] = [];
  const t = facts.topology;

  lines.push("");
  lines.push(`  Deployment : ${result.sourceName}`);
  const host =
    facts.serverStatus?.host ??
    (facts.atlas ? `Atlas project ${facts.atlas.projectId}` : "unknown");
  lines.push(`  Host       : ${host}`);
  lines.push(
    `  Topology   : ${t.type}${t.setName ? ` "${t.setName}"` : ""} · ${t.nodeCount} node(s) · MongoDB ${t.mongoVersion}`,
  );
  if (facts.collectionMethod) {
    lines.push(`  Collected  : via ${facts.collectionMethod}`);
  }
  lines.push(
    `  Health     : ${scoreColor(score.value, useColor)}/100   ` +
      `crit=${score.counts.critical} warn=${score.counts.warning} info=${score.counts.info}`,
  );
  lines.push("");

  if (findings.length === 0) {
    lines.push(`  ${badge("ok", useColor)} No issues detected.`);
  } else {
    for (const f of findings) {
      lines.push(`  ${badge(f.severity, useColor)} ${f.title}  ${dim(`(${f.checkId})`, useColor)}`);
      lines.push(`         ${f.detail}`);
      if (f.remediation) lines.push(`         ${dim("→ " + f.remediation, useColor)}`);
    }
  }

  if (analysis) {
    lines.push("");
    const header = useColor ? `${BOLD}  Analysis${RESET}` : "  Analysis";
    lines.push(header + dim(`  (${analysis.generatedBy})`, useColor));
    lines.push(`  ${analysis.summary}`);
    if (analysis.topRisks.length > 0) {
      lines.push("");
      lines.push(`  ${dim("Top risks:", useColor)}`);
      for (const r of analysis.topRisks) {
        lines.push(
          `    ${badge(r.severity, useColor)} ${r.title}  ${dim("[" + r.relatedCheckIds.join(", ") + "]", useColor)}`,
        );
      }
    }
    if (analysis.recommendations.length > 0) {
      lines.push("");
      lines.push(`  ${dim("Recommendations:", useColor)}`);
      analysis.recommendations.forEach((r, i) => lines.push(`    ${i + 1}. ${r}`));
    }
  }

  if (facts.warnings.length > 0) {
    lines.push("");
    lines.push(`  ${dim("Collection warnings:", useColor)}`);
    for (const w of facts.warnings) lines.push(`    ${dim("· " + w, useColor)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function dim(s: string, useColor: boolean): string {
  return useColor ? `\x1b[2m${s}\x1b[0m` : s;
}

export function formatJson(result: ScanResult): string {
  return JSON.stringify(
    { ...result, finding_count: result.findings.length },
    (_k, v) => (v instanceof Date ? v.toISOString() : v),
    2,
  );
}
