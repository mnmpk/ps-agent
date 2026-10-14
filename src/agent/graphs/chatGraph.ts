import { StateGraph, MessagesAnnotation, MemorySaver, END, START, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { HealthService } from "../../service/healthService.js";
import { buildHealthTools } from "../tools/healthTools.js";

const SYSTEM_PROMPT = `You are ps-agent, a MongoDB deployment health assistant.

You help operators understand the health and risks of their MongoDB deployments
(Atlas and self-managed). You have READ-ONLY tools over scan data.

CRITICAL GROUNDING RULES — violating these is a serious error:
- The ONLY facts you may state are those returned by tool calls in THIS conversation.
- NEVER invent deployment names, sourceIds, scores, metrics, findings, or numbers.
  Deployment names like "prod-cluster" or "staging" are FORBIDDEN unless a tool
  returned them. Use the exact names and numbers from tool JSON, verbatim.
- If a tool returned no data, say "no data available" — do not guess.

Workflow rules:
- list_fleet only returns scores/counts — it NEVER contains findings, namespaces,
  index names, or metric specifics.
- For ANY question about specific findings — "which namespace/collection/index",
  "why is X unhealthy", redundant/unused indexes, disk, replication, etc. — you
  MUST call query_findings. Its 'evidence' field holds the specifics (affected
  namespaces, index names, numbers). Read evidence to answer "which …" questions.
- Call list_fleet first only if you need a sourceId; otherwise go straight to
  query_findings (it works across the whole fleet without a sourceId).
- Do NOT call the same tool with the same arguments twice — reuse the result.
- Once you have the data you need, STOP calling tools and answer.
- TOOL ROUTING — pick the tool by what the question is about. list_fleet does
  NOT answer any of these; it only gives you the sourceId:
  - bottleneck / "what is slow" / "what's limiting performance" → get_bottlenecks
  - data growth / "how fast growing" / "when to scale" / "scale up/out/down" /
    utilization / "cost optimization" / capacity → get_capacity
  - a single metric over time → get_metric_trend
  - findings / "why unhealthy" / which namespace/index → query_findings
  These tools need a sourceId: if you don't have one, call list_fleet ONCE to
  get it, then immediately call the right tool above. Do NOT answer a
  capacity/bottleneck question from list_fleet alone — that is wrong.
  Example: "what's the bottleneck of demo?" → list_fleet (get id) →
  get_bottlenecks(sourceId) → answer with the top bottleneck's detail verbatim.
- Use get_metrics for point-in-time resource details.
- Cite checkIds and the exact names/numbers from the evidence, verbatim.
- NEVER invent names, scores, metrics, or namespaces. If a tool returned no data,
  say "no data available".
- suggest_remediation is advisory only; always include its caveat. You cannot and
  must not change any cluster.
- Be concise. Only mention deployments/namespaces that appear in tool results.`;

const MAX_TOOL_STEPS = 6;

export interface ChatGraphDeps {
  model: BaseChatModel;
  service: HealthService;
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Interactive chat agent built as an explicit model ⇄ tools loop (rather than
 * the prebuilt createReactAgent) so we can guard against small local models
 * that loop by repeatedly calling the same tool. We:
 *  - cap the number of tool steps, and
 *  - drop any tool call whose (name,args) was already executed this turn,
 *    forcing the model to answer from data it already has.
 */
export function buildChatAgent(deps: ChatGraphDeps) {
  const tools = buildHealthTools(deps.service);
  const toolNode = new ToolNode(tools);
  const modelWithTools = (deps.model as any).bindTools
    ? (deps.model as any).bindTools(tools)
    : deps.model;

  async function callModel(state: typeof MessagesAnnotation.State) {
    const seen = new Set<string>();
    let toolSteps = 0;
    for (const m of state.messages) {
      if (m.getType() === "ai") {
        const calls = (m as AIMessage).tool_calls ?? [];
        for (const c of calls) {
          seen.add(`${c.name}:${JSON.stringify(c.args ?? {})}`);
          toolSteps++;
        }
      }
    }

    const messages = ensureSystem(state.messages);
    const response = (await modelWithTools.invoke(messages)) as AIMessage;

    // Guard: if the model wants to repeat an already-run tool call, or has hit
    // the step limit, force a final answer. Small local models ground poorly on
    // raw ToolMessages but well on plain text, so we re-ask WITHOUT tools and
    // inline the collected tool results as plain context.
    const calls = response.tool_calls ?? [];
    if (calls.length > 0) {
      const fresh = calls.filter((c) => !seen.has(`${c.name}:${JSON.stringify(c.args ?? {})}`));
      if (fresh.length === 0 || toolSteps >= MAX_TOOL_STEPS) {
        return { messages: [await forceGroundedAnswer(deps.model, state.messages)] };
      }
      if (fresh.length !== calls.length) {
        response.tool_calls = fresh;
      }
    }
    return { messages: [response] };
  }

  function routeAfterModel(state: typeof MessagesAnnotation.State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return (last.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  }

  /**
   * After tools run, decide: let the model call MORE (distinct) tools, or
   * produce the final grounded answer. We allow another tool round only if the
   * model hasn't yet exhausted distinct useful calls; otherwise we answer.
   */
  async function routeAfterTools(
    state: typeof MessagesAnnotation.State,
  ): Promise<{ messages: BaseMessage[] }> {
    // Count distinct tool calls so far this turn.
    const toolSteps = state.messages.filter((m) => m instanceof ToolMessage).length;
    if (toolSteps < MAX_TOOL_STEPS) {
      // Give the model one chance to request additional DISTINCT data.
      const seen = collectSeenCalls(state.messages);
      const probe = (await modelWithTools.invoke(ensureSystem(state.messages))) as AIMessage;
      const calls = (probe.tool_calls ?? []).filter(
        (c) => !seen.has(`${c.name}:${JSON.stringify(c.args ?? {})}`),
      );
      if (calls.length > 0) {
        probe.tool_calls = calls;
        return { messages: [probe] };
      }
    }
    // No new data needed → final grounded answer (tools inlined as plain text).
    return { messages: [await forceGroundedAnswer(deps.model, state.messages)] };
  }

  function routeAfterProbe(state: typeof MessagesAnnotation.State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return (last.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  }

  /**
   * Deterministic intent prefetch: small local models often fail to chain to
   * the right tool for capacity/bottleneck questions. If the user's question
   * clearly maps to such a tool and we can resolve a single sourceId, we run
   * the tool up-front and inject its result as context — so the grounded answer
   * always has the data regardless of the model's tool-calling. Larger models
   * are unaffected (they'd call the tool anyway; duplicates are de-duped).
   */
  async function prefetch(state: typeof MessagesAnnotation.State) {
    const lastHuman = [...state.messages].reverse().find((m) => m.getType() === "human");
    const q = (lastHuman ? messageText(lastHuman) : "").toLowerCase();
    if (!q) return {};

    const wantsCapacity = /(scal|capacit|utiliz|cost|optimi[sz]|grow|disk.*full|how fast|headroom|downsize)/.test(q);
    const wantsBottleneck = /(bottleneck|slow|what.*limit|performance.*(issue|problem)|why.*slow)/.test(q);
    if (!wantsCapacity && !wantsBottleneck) return {};

    // Resolve a sourceId: explicit name match, else the only source.
    const fleet = await deps.service.fleetOverview();
    if (fleet.length === 0) return {};
    let source = fleet.find((f) => q.includes(f.source.name.toLowerCase()));
    if (!source && fleet.length === 1) source = fleet[0];
    if (!source) return {}; // ambiguous → let the model ask / choose

    const toolName = wantsBottleneck && !wantsCapacity ? "get_bottlenecks" : "get_capacity";
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) return {};
    try {
      const result = await (tool as any).invoke({ sourceId: source.source.id });
      // Inject as an AI tool-call + ToolMessage pair so it's part of the record.
      const callId = `prefetch-${Date.now()}`;
      return {
        messages: [
          new AIMessage({ content: "", tool_calls: [{ id: callId, name: toolName, args: { sourceId: source.source.id } }] }),
          new ToolMessage({ content: String(result), tool_call_id: callId, name: toolName }),
        ],
      };
    } catch {
      return {};
    }
  }

  /** Grounded final answer from prefetched tool data (bypasses model tool loop). */
  async function groundedFromPrefetch(state: typeof MessagesAnnotation.State) {
    return { messages: [await forceGroundedAnswer(deps.model, state.messages)] };
  }

  /** After prefetch: if we injected tool data, answer directly from it; else normal agent loop. */
  function routeAfterPrefetch(
    state: typeof MessagesAnnotation.State,
  ): "grounded" | "agent" {
    const last = state.messages[state.messages.length - 1];
    return last instanceof ToolMessage ? "grounded" : "agent";
  }

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("prefetch", prefetch)
    .addNode("grounded", groundedFromPrefetch)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addNode("respond", routeAfterTools)
    .addEdge(START, "prefetch")
    .addConditionalEdges("prefetch", routeAfterPrefetch, ["grounded", "agent"])
    .addEdge("grounded", END)
    .addConditionalEdges("agent", routeAfterModel, ["tools", END])
    .addEdge("tools", "respond")
    .addConditionalEdges("respond", routeAfterProbe, ["tools", END]);

  return graph.compile({ checkpointer: deps.checkpointer ?? new MemorySaver() });
}

/** Set of `${name}:${args}` tool calls already issued this turn. */
function collectSeenCalls(messages: BaseMessage[]): Set<string> {
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.getType() === "ai") {
      for (const c of (m as AIMessage).tool_calls ?? []) {
        seen.add(`${c.name}:${JSON.stringify(c.args ?? {})}`);
      }
    }
  }
  return seen;
}

/**
 * Produce the final answer WITHOUT tools, inlining collected tool results as
 * plain text. Small local models ground reliably on plain context but poorly on
 * the ToolMessage protocol — this is the key to correct grounding.
 */
async function forceGroundedAnswer(
  model: BaseChatModel,
  messages: BaseMessage[],
): Promise<AIMessage> {
  const userMsg = [...messages].reverse().find((m) => m.getType() === "human");
  const toolResults = messages
    .filter((m): m is ToolMessage => m instanceof ToolMessage)
    .map((m) => `- ${m.name}: ${messageText(m)}`)
    .join("\n");

  const prompt = [
    new SystemMessage(
      "Answer the user's question using ONLY the tool results below. " +
        "Never invent deployment names, scores, or numbers — copy them verbatim " +
        "from the data. If the data doesn't cover something, say so.",
    ),
    new HumanMessage(
      `User question: ${userMsg ? messageText(userMsg) : "(none)"}\n\n` +
        `Tool results:\n${toolResults || "(no tool results)"}\n\n` +
        `Write a concise, grounded answer.`,
    ),
  ];
  const r = (await model.invoke(prompt)) as AIMessage;
  return new AIMessage({ content: messageText(r) });
}

function ensureSystem(messages: BaseMessage[]): BaseMessage[] {
  if (messages.some((m) => m.getType() === "system")) return messages;
  return [new SystemMessage(SYSTEM_PROMPT), ...messages];
}

export interface ChatResult {
  reply: string;
  toolsUsed: string[];
}

export async function runChatTurn(
  agent: ReturnType<typeof buildChatAgent>,
  threadId: string,
  userMessage: string,
): Promise<ChatResult> {
  const result = await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    { configurable: { thread_id: threadId }, recursionLimit: 2 * MAX_TOOL_STEPS + 2 },
  );
  const messages = result.messages as BaseMessage[];
  return { reply: lastAiText(messages), toolsUsed: extractToolsUsed(messages, userMessage) };
}

export async function* streamChatTurn(
  agent: ReturnType<typeof buildChatAgent>,
  threadId: string,
  userMessage: string,
): AsyncGenerator<ChatStreamEvent> {
  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    {
      configurable: { thread_id: threadId },
      streamMode: "updates",
      recursionLimit: 2 * MAX_TOOL_STEPS + 2,
    },
  );
  for await (const update of stream) {
    for (const [node, value] of Object.entries(update as Record<string, any>)) {
      const msgs: BaseMessage[] = value?.messages ?? [];
      for (const m of msgs) {
        const toolCalls = (m as AIMessage).tool_calls;
        if (toolCalls?.length) {
          for (const tc of toolCalls) yield { type: "tool_call", name: tc.name };
        }
        const text = messageText(m);
        // Final reply can come from the agent node (no tools needed) or the
        // respond node (grounded answer after tools). Emit either.
        if ((node === "agent" || node === "respond" || node === "grounded") && text && !toolCalls?.length) {
          yield { type: "reply", text };
        }
      }
    }
  }
}

export type ChatStreamEvent =
  | { type: "tool_call"; name: string }
  | { type: "reply"; text: string };

// --- helpers ---------------------------------------------------------------

function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.getType() === "ai") {
      const text = messageText(m);
      if (text) return text;
    }
  }
  return "";
}

/** Tool calls that happened after the current user message (this turn only). */
function extractToolsUsed(messages: BaseMessage[], userMessage: string): string[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.getType() === "human" && messageText(messages[i]!) === userMessage) {
      start = i;
      break;
    }
  }
  const used: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m instanceof ToolMessage) used.push(m.name ?? "tool");
  }
  return used;
}

function messageText(m: BaseMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === "string" ? p : (p as any).text ?? "")).join("");
  }
  return "";
}
