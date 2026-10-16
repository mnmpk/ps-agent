import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { CollectedFacts } from "../core/types.js";
import type { LlmConfig } from "../agent/llm.js";
import type { RiskAssessment, RiskCatalogEntry } from "./types.js";
import { renderSkillsPrompt } from "../skills/index.js";

const SYSTEM = `You are a MongoDB reliability expert cross-referencing an expert RISK REGISTER
against one cluster's collected diagnostic facts.

For each candidate risk you are given, decide whether the cluster's facts show
EVIDENCE that the risk may apply. You are ADVISORY only — these are unverified
suggestions for a human to confirm.

Hard rules:
- Only flag a risk as applicable if the provided facts give concrete evidence.
- Do NOT flag organizational/process risks (incident plans, staffing, procedures,
  access to hosts) — those can't be judged from facts; leave them out.
- Never invent facts. Reference the specific fact you relied on.
- Be conservative: when unsure, do not flag it.`;

const MatchSchema = z.object({
  matches: z
    .array(
      z.object({
        riskId: z.string().describe("The id of a candidate risk that may apply."),
        confidence: z.number().min(0).max(1),
        rationale: z.string().describe("The specific fact evidencing this risk."),
      }),
    )
    .describe("Only risks with concrete supporting evidence in the facts."),
});

/**
 * Ask the LLM which of the non-auto-detectable ("manual") risks may apply given
 * the facts. Returns updated assessments (status "suggested" for flagged ones).
 * Requires a configured model; callers skip this when no LLM is available.
 */
export async function matchRisksWithLlm(
  model: BaseChatModel,
  provider: LlmConfig["provider"] | undefined,
  facts: CollectedFacts,
  candidates: RiskCatalogEntry[],
): Promise<Map<string, { confidence: number; rationale: string }>> {
  const out = new Map<string, { confidence: number; rationale: string }>();
  if (candidates.length === 0) return out;

  const factSummary = summarizeFacts(facts);
  const payload = {
    facts: factSummary,
    candidateRisks: candidates.map((r) => ({
      id: r.id,
      name: r.name.slice(0, 160),
      description: r.description.slice(0, 400),
    })),
  };

  // Relevance context for skill selection: the candidate risk names/descriptions.
  const skillContext = candidates
    .map((r) => `${r.name} ${r.description}`)
    .join(" ");

  const raw =
    provider === "ollama"
      ? await invokeOllama(model, payload, skillContext)
      : await invokeStructured(model, payload, skillContext);

  const parsed = MatchSchema.safeParse(raw);
  if (!parsed.success) return out;
  for (const m of parsed.data.matches) {
    out.set(m.riskId, { confidence: m.confidence, rationale: m.rationale });
  }
  return out;
}

function buildMessages(payload: unknown, skillContext = "") {
  // Inject relevant MongoDB expert skill(s) after the hard rules so the
  // "never invent facts / be conservative" grounding always takes precedence.
  const skills = skillContext
    ? renderSkillsPrompt(skillContext, { limit: 2 })
    : "";
  const systemText = skills ? `${SYSTEM}\n\n${skills}` : SYSTEM;
  return [
    new SystemMessage(systemText),
    new HumanMessage(
      "Cross-reference these candidate risks against the cluster facts. Return only risks with evidence.\n\n```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```",
    ),
  ];
}

async function invokeStructured(
  model: BaseChatModel,
  payload: unknown,
  skillContext = "",
): Promise<unknown> {
  const structured = (model as any).withStructuredOutput(MatchSchema, { name: "risk_matches" });
  return structured.invoke(buildMessages(payload, skillContext));
}

async function invokeOllama(
  model: BaseChatModel,
  payload: unknown,
  skillContext = "",
): Promise<unknown> {
  const schema = zodToJsonSchema(MatchSchema);
  const bound = (model as any).bind ? (model as any).bind({ format: schema }) : model;
  const res = await bound.invoke(buildMessages(payload, skillContext));
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  try {
    return JSON.parse(text);
  } catch {
    return { matches: [] };
  }
}

/** Compact, fact-only summary for the model (no secrets). */
function summarizeFacts(f: CollectedFacts): Record<string, unknown> {
  return {
    topology: f.topology,
    version: f.serverStatus?.version ?? f.topology.mongoVersion,
    security: f.serverStatus?.security,
    hostInfo: f.hostInfo,
    connections: f.serverStatus?.connections,
    replica: f.replSetStatus
      ? {
          set: f.replSetStatus.set,
          members: f.replSetStatus.members.map((m) => ({ name: m.name, state: m.stateStr, votes: m.votes, priority: m.priority })),
        }
      : undefined,
    storage: f.storage
      ? { dataSizeBytes: f.storage.dataSizeBytes, indexSizeBytes: f.storage.indexSizeBytes, fsUsedBytes: f.storage.fsUsedBytes, fsTotalBytes: f.storage.fsTotalBytes }
      : undefined,
    unusedIndexes: (f.indexUsage ?? []).filter((i) => i.name !== "_id_" && i.ops === 0).length,
  };
}
