/**
 * Converts a MongoDB "risk register" .xlsx into a committed JSON catalog
 * (src/risks/risks-catalog.json) that the risk engine loads.
 *
 * Re-run whenever the register changes:
 *   npx tsx scripts/convertRiskRegister.ts "risk register.xlsx"
 *
 * Reads the xlsx directly (zip + XML) — no spreadsheet dependency. Expects a
 * sheet whose header row contains: ID, Risk Level, Risk status, Probability,
 * Impact, Name, Risk Description, Risk Identified Date, Recommendations.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error('Usage: tsx scripts/convertRiskRegister.ts "<risk register.xlsx>"');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "riskxlsx-"));
execFileSync("unzip", ["-o", input, "-d", dir], { stdio: "ignore" });

// Shared strings.
const ss = readFileSync(join(dir, "xl/sharedStrings.xml"), "utf8");
const strings: string[] = [];
for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  let txt = "";
  for (const t of m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) txt += t[1];
  strings.push(unescapeXml(txt));
}

// First worksheet.
const sheet = readFileSync(join(dir, "xl/worksheets/sheet1.xml"), "utf8");
const rows: Record<number, Record<string, string>> = {};
for (const r of sheet.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const rn = Number(r[1]);
  const cells: Record<string, string> = {};
  for (const c of r[2]!.matchAll(
    /<c r="([A-Z]+)\d+"(?:[^>]*\bt="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?<\/c>/g,
  )) {
    const col = c[1]!;
    let val = c[4] ?? c[3] ?? "";
    if (c[2] === "s" && c[3] !== "" && c[3] != null) val = strings[Number(c[3])] ?? "";
    cells[col] = unescapeXml(val);
  }
  rows[rn] = cells;
}

// Find the header row (contains "Risk Description" or "Name").
let headerRow = -1;
for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
  const vals = Object.values(rows[rn]!).map((v) => v.toLowerCase());
  if (vals.includes("name") && vals.some((v) => v.includes("risk description"))) {
    headerRow = rn;
    break;
  }
}
if (headerRow < 0) {
  console.error("Could not find the header row (need 'Name' + 'Risk Description').");
  process.exit(1);
}

// Map header labels → column letters.
const header = rows[headerRow]!;
const colFor = (label: string): string | undefined =>
  Object.keys(header).find((c) => header[c]!.trim().toLowerCase() === label.toLowerCase());
const cId = colFor("ID");
const cLevel = colFor("Risk Level");
const cStatus = colFor("Risk status");
const cProb = colFor("Probability");
const cImpact = colFor("Impact");
const cName = colFor("Name");
const cDesc = colFor("Risk Description");
const cReco = colFor("Recommendations");

const catalog = [];
for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
  if (rn <= headerRow) continue;
  const c = rows[rn]!;
  const name = cName ? c[cName]?.trim() : "";
  if (!name) continue;
  catalog.push({
    id: (cId && c[cId]) || String(rn - headerRow),
    level: normalizeLevel(cLevel ? c[cLevel] : ""),
    status: (cStatus && c[cStatus]) || "",
    probability: (cProb && c[cProb]) || "",
    impact: (cImpact && c[cImpact]) || "",
    name,
    description: (cDesc && c[cDesc]?.trim()) || "",
    recommendation: (cReco && c[cReco]?.trim()) || "",
  });
}

const outPath = join(process.cwd(), "src/risks/risks-catalog.json");
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), risks: catalog }, null, 2));
console.log(`Wrote ${catalog.length} risks → ${outPath}`);

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&#9;/g, "\t");
}

/** "0-High" → "high", "1-Medium" → "medium", "2-Low" → "low". */
function normalizeLevel(raw: string): "high" | "medium" | "low" | "unknown" {
  const s = (raw || "").toLowerCase();
  if (s.includes("high")) return "high";
  if (s.includes("medium")) return "medium";
  if (s.includes("low")) return "low";
  return "unknown";
}
