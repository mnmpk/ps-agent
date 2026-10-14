import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Finding, HealthAnalysis, HealthScore } from "../core/types.js";
import type { Topology } from "../core/types.js";
import { HealthAnalysisSchema } from "./schema.js";
import type { LlmConfig } from "./llm.js";

const SYSTEM_PROMPT = `You are a MongoDB reliability engineer reviewing an automated health scan.
You are given DETERMINISTIC findings produced by a rule engine, plus key metrics.

Hard rules:
- You MUST NOT invent findings, metrics, or numbers. Only reference what is provided.
- In relatedCheckIds, only use checkIds that appear in the provided findings.
- Correlate related findings into a single risk when they share a root cause.
- Be concise and specific; cite the evidence numbers you were given.
- If there are no findings, say the deployment looks healthy and return empty risk/recommendation lists.`;

interface CorrelateInput {
  sourceName: string;
  topology: Topology;
  host: string;
  findings: Finding[];
  score: HealthScore;
}

function buildMessages(input: CorrelateInput) {
  const payload = {
    deployment: input.sourceName,
    host: input.host,
    topology: input.topology,
    healthScore: input.score,
    findings: input.findings.map((f) => ({
      checkId: f.checkId,
      category: f.category,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence,
    })),
  };
  return [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(
      `Analyze this scan and return the structured analysis.\n\n` +
        "```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```",
    ),
  ];
}

/**
 * The single LLM node of the scan graph. Produces grounded narration via
 * schema-constrained structured output.
 *
 * Strategy differs by provider:
 *  - Cloud providers (Anthropic/OpenAI) use `withStructuredOutput`, which binds
 *    a tool and reliably returns typed output.
 *  - Ollama (local) uses native JSON-schema-constrained decoding (`format`),
 *    which small local models follow far more reliably than tool-calling.
 */
export async function correlateAndRank(
  model: BaseChatModel,
  input: CorrelateInput,
  generatedBy: string,
  provider?: LlmConfig["provider"],
): Promise<HealthAnalysis> {
  const raw =
    provider === "ollama"
      ? await invokeOllamaStructured(model, input)
      : await invokeWithStructuredOutput(model, input);

  // Validate/normalize no matter the path — never trust the model blindly.
  const parsed = HealthAnalysisSchema.parse(raw);
  return {
    summary: parsed.summary,
    topRisks: parsed.topRisks,
    recommendations: parsed.recommendations,
    generatedBy,
  };
}

/** Cloud-provider path: LangChain binds a tool for typed output. */
async function invokeWithStructuredOutput(
  model: BaseChatModel,
  input: CorrelateInput,
): Promise<unknown> {
  if (!("withStructuredOutput" in model) || typeof (model as any).withStructuredOutput !== "function") {
    throw new Error("Configured chat model does not support structured output.");
  }
  const structured = (model as any).withStructuredOutput(HealthAnalysisSchema, {
    name: "health_analysis",
  });
  return structured.invoke(buildMessages(input));
}

/**
 * Ollama path: constrain decoding to the JSON schema server-side and parse the
 * returned text. We clone the model with `format` set so we don't mutate the
 * shared instance.
 */
async function invokeOllamaStructured(
  model: BaseChatModel,
  input: CorrelateInput,
): Promise<unknown> {
  const jsonSchema = zodToJsonSchema(HealthAnalysisSchema);
  // ChatOllama exposes `format`; set it via bind so the schema constrains output.
  const bound = (model as any).bind
    ? (model as any).bind({ format: jsonSchema })
    : model;
  const res = await bound.invoke(buildMessages(input));
  const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Ollama returned non-JSON output: ${(err as Error).message}`);
  }
}

/** Deterministic fallback analysis when no LLM is configured. */
export function fallbackAnalysis(findings: Finding[], score: HealthScore): HealthAnalysis {
  const worst = [...findings].slice(0, 5);
  const summary =
    findings.length === 0
      ? `Deployment looks healthy (score ${score.value}/100). No issues detected.`
      : `Score ${score.value}/100 with ${score.counts.critical} critical, ${score.counts.warning} warning, and ${score.counts.info} informational findings. Address critical items first.`;
  return {
    summary,
    topRisks: worst.map((f) => ({
      title: f.title,
      severity: f.severity,
      relatedCheckIds: [f.checkId],
      rationale: f.detail,
    })),
    recommendations: worst
      .map((f) => f.remediation)
      .filter((r): r is string => Boolean(r)),
    generatedBy: "none (rule-engine fallback)",
  };
}
