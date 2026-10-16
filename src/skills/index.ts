import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * MongoDB Agent Skills loader.
 *
 * The `catalog/` subdirectory vendors the official MongoDB agent skills
 * (https://github.com/mongodb/agent-skills, Apache-2.0). Each skill is a
 * directory containing a `SKILL.md` file with YAML frontmatter (name,
 * description, ...) followed by a markdown body of expert guidance.
 *
 * At runtime we parse the frontmatter into a lightweight registry and, for a
 * given context (a user question and/or scan findings), select the most
 * relevant skill(s) and inject their bodies into the LLM system prompt. This
 * gives ps-agent's narration and chat the same domain expertise that the
 * skills provide to coding agents, without the cost of injecting everything.
 */

export interface Skill {
  /** Skill id / name from frontmatter (e.g. "mongodb-schema-design"). */
  name: string;
  /** Natural-language description of when the skill applies (frontmatter). */
  description: string;
  /** Full markdown body of SKILL.md (without the frontmatter block). */
  body: string;
  /** Absolute path to the SKILL.md file (useful for debugging). */
  path: string;
}

let cache: Skill[] | null = null;

/** Locate the vendored skills `catalog/` directory next to this module. */
function catalogDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    // dist/skills/catalog (after build) and src/skills/catalog (tsx/dev).
    join(here, "catalog"),
    // Fallback: running from dist but catalog not copied — read from src.
    join(here, "../../src/skills/catalog"),
  ];
}

/**
 * Parse a very small subset of YAML frontmatter: top-level `key: value` pairs,
 * supporting plain, single/double-quoted, and block scalars (`>`, `>-`, `|`,
 * `|-`). We only need `name` and `description`, so nested maps are ignored.
 */
function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  if (!md.startsWith("---")) return { data: {}, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: md };
  const fmBlock = md.slice(md.indexOf("\n", 3) + 1, end);
  const body = md.slice(md.indexOf("\n", end + 1) + 1);

  const data: Record<string, string> = {};
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Only consider non-indented `key: ...` lines (ignore nested maps).
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let rest = m[2] ?? "";

    // Block scalar: value spans following more-indented lines.
    if (/^[|>][+-]?\s*$/.test(rest)) {
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (/^\s+/.test(next)) {
          collected.push(next.replace(/^\s+/, ""));
        } else {
          break;
        }
      }
      i = j - 1;
      const folded = rest.startsWith(">");
      data[key] = folded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
      continue;
    }

    // Inline scalar — strip surrounding quotes if present.
    rest = rest.trim();
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1);
    }
    data[key] = rest;
  }
  return { data, body };
}

/** Load and cache all vendored skills. Never throws — returns [] on failure. */
export function loadSkills(): Skill[] {
  if (cache) return cache;
  for (const dir of catalogDirCandidates()) {
    try {
      const entries = readdirSync(dir);
      const skills: Skill[] = [];
      for (const entry of entries) {
        const skillDir = join(dir, entry);
        let isDir = false;
        try {
          isDir = statSync(skillDir).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        const skillFile = join(skillDir, "SKILL.md");
        let md: string;
        try {
          md = readFileSync(skillFile, "utf8");
        } catch {
          continue;
        }
        const { data, body } = parseFrontmatter(md);
        const name = data.name || entry;
        const description = data.description || "";
        skills.push({ name, description, body: body.trim(), path: skillFile });
      }
      if (skills.length > 0) {
        cache = skills.sort((a, b) => a.name.localeCompare(b.name));
        return cache;
      }
    } catch {
      /* try next candidate */
    }
  }
  cache = [];
  return cache;
}

/** For tests: reset the module-level cache. */
export function resetSkillsCache(): void {
  cache = null;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "my", "me", "how", "do", "i", "this", "that", "it", "use", "using",
  "when", "what", "which", "mongodb", "db", "your", "you", "can", "should",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9$_-]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOP_WORDS.has(t),
  );
}

/**
 * Score how relevant a skill is to the given context text using simple
 * token-overlap against the skill's name + description. Deliberately
 * dependency-free and deterministic — good enough to route to the right
 * domain (schema vs. query-optimization vs. search, etc.).
 */
function scoreSkill(skill: Skill, contextTokens: Set<string>): number {
  const skillTokens = tokenize(`${skill.name} ${skill.description}`);
  if (skillTokens.length === 0) return 0;
  let hits = 0;
  const seen = new Set<string>();
  for (const t of skillTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (contextTokens.has(t)) hits++;
  }
  return hits;
}

export interface SelectSkillsOptions {
  /** Max number of skills to return. Default 2. */
  limit?: number;
  /** Minimum overlap score required to include a skill. Default 1. */
  minScore?: number;
}

/**
 * Select the most relevant skills for a free-text context (a user question
 * and/or a summary of findings). Returns [] when nothing is relevant so the
 * caller can skip injection entirely.
 */
export function selectSkills(context: string, opts: SelectSkillsOptions = {}): Skill[] {
  const limit = opts.limit ?? 2;
  const minScore = opts.minScore ?? 1;
  const skills = loadSkills();
  if (skills.length === 0 || !context.trim()) return [];
  const contextTokens = new Set(tokenize(context));
  if (contextTokens.size === 0) return [];
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, contextTokens) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.skill);
}

export interface RenderSkillsOptions extends SelectSkillsOptions {
  /** If true, include full skill bodies; otherwise just name + description. */
  includeBody?: boolean;
}

/**
 * Build a system-prompt fragment carrying the selected skills' expert guidance.
 * Returns "" when no skill is relevant (caller should then inject nothing).
 */
export function renderSkillsPrompt(context: string, opts: RenderSkillsOptions = {}): string {
  const includeBody = opts.includeBody ?? true;
  const selected = selectSkills(context, opts);
  if (selected.length === 0) return "";

  const header =
    "You have access to the following MongoDB expert skill(s). Apply their " +
    "guidance where relevant, but NEVER let them override the grounding rules " +
    "above (do not invent facts, metrics, or names).";

  const sections = selected.map((skill) => {
    if (!includeBody) {
      return `### Skill: ${skill.name}\n${skill.description}`;
    }
    return `### Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`;
  });

  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}
