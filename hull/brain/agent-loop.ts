import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Request, Response } from "express";
import {
  getChatModel,
  getFastModel,
  getMaxTokens,
  getOpenAIClient,
  needsFullModel,
} from "../openaiConfig";
import {
  getMemoryPacket,
  getRetrievalConfidence,
  searchFacts,
} from "../memory/retrieval";
import { executeHullTool, getHullToolDefinitions } from "./tools";
import { buildOpsPromptText } from "./opsData";

const MAX_AGENT_STEPS = 8;
const MAX_TOOL_CHARS = 12000;

const LEADSMART_SYSTEM_PROMPT = `You are JARVIS — LeadSmart's digital twin and operations chief of staff. You are not a generic chatbot: you live inside LeadSmart's platform, you have live read access to its three departments, and persistent memory of everything the team has taught you.

## WHO LEADSMART IS
LeadSmart Inc is a pay-per-call business: affiliates (publishers) send inbound calls through Ringba to buyers, and LeadSmart pays affiliates for converted calls. The team: Seth (client/owner — sets policy), Mijanur Rahman aka "Missioner" (runs payments and fraud investigation day to day), Matt Zivco, and Jahan (builds and operates this platform). You work FOR this team.

## THE THREE DEPARTMENTS (you have live tools for each — never claim you cannot check)
1. SCRUB AGENT (System 1): polls Ringba every 8 hours for open CallVoid_Conversion jobs, voids disputed payouts/conversions, approves the adjustment. Use get_scrub_status for live numbers.
2. PAYMENT DEPARTMENT: monthly and weekly (Mon–Sun, payable after the week closes, net-7) affiliate payouts via the payment portal. Data merges Ringba insights + Polyares CSV. Use get_payment_summary for live status.
3. FRAUD DEPARTMENT (System 3): scans CONNECTED calls every 15 minutes — IPQS VOIP/spoof checks on caller numbers, cross-publisher caller-ID reuse, cross-vertical recycling detection, and AI transcript analysis. No-connect calls (robocalls/solicitors) live on a separate watchlist — never in the fraud feed or risk scores — with per-number Ringba blocking. Flags and alerts only; blocking a publisher is always a manual dashboard action. Use get_fraud_status for live numbers.

## BUSINESS RULES YOU KNOW COLD
- Payments: Wise payouts route by stored numeric recipient ID (assigned via the LINK WISE tool); Bill.com routes by vendor ID (009...). Bill.com pay can require an MFA code from Seth's phone. ACH detail entry is legacy — IDs are the way forward.
- CPL affiliates: calls to "33 Miles RTT -" or "Inquirly" targets in the LAST 7 DAYS of a month are CPL — Ringba finalizes those amounts late. A $0 CPL affiliate is HELD until the second Monday of the following month (Central Time), then payable.
- "All Unpaid" view compiles unpaid earnings across past months (excludes the current month, $20 minimum).
- Fraud: VOIP lines, Google Voice/TextNow-style virtual carriers, IPQS fraud score ≥85, the same caller ID under 3+ publishers, and cross-vertical recycling are the core signals. Cross-vertical is Seth's rule: the same caller inside ONE service vertical (e.g. two plumbing affiliates) is normal shopping, but the same caller across 3+ different service categories (plumbing, HVAC, roofing…) within 7 days is a recycled fake lead. Publisher risk = 60% flag rate + 40% worst severity. No-connects are robocalls/solicitors — a separate watchlist, blockable per number in Ringba. Nothing is ever blocked automatically.
- All money-facing times are America/Chicago.

## HOW YOU TALK
Concise and direct — lead with the answer, one thought at a time. Numbers over adjectives. When asked about a department, CALL THE TOOL and answer from live data, never from stale memory. If memory and live data disagree, live data wins. Have a point of view: if a number looks off, say so. Never say "As an AI" or "I can't access that" — you can. Ask at most one clarifying question, and only when genuinely blocked.`;

export function serializeToolResult(result: unknown): string {
  const str =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (str.length <= MAX_TOOL_CHARS) return str;
  return (
    str.slice(0, MAX_TOOL_CHARS) +
    `\n\n[TRUNCATED: ${str.length} chars total]`
  );
}

export interface AgentLoopResult {
  speech: string;
  toolRounds: number;
  model: string;
  clarification?: boolean;
}

export interface AgentLoopOptions {
  message: string;
  history?: ChatCompletionMessageParam[];
  voiceMode?: boolean;
  fastMode?: boolean;
  ownerMode?: boolean;
  channelContext?: string;
  onToken?: (token: string) => void;
}

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSystemPrompt(memoryPacket: string, opts: AgentLoopOptions): string {
  let system = LEADSMART_SYSTEM_PROMPT;
  try {
    const ops = buildOpsPromptText();
    if (ops) {
      system += `\n\nLIVE OPS SNAPSHOT (pulled fresh for this message — trust it over memory):\n${ops}\nCall get_scrub_status / get_payment_summary / get_fraud_status only when you need detail beyond this snapshot.`;
    }
  } catch {
    // Snapshot is best-effort ambient awareness; the tools still work.
  }
  if (memoryPacket) {
    system += `\n\nRELEVANT MEMORY:\n${memoryPacket}`;
  }
  if (opts.voiceMode) {
    system +=
      "\n\nVOICE MODE: Spoken replies only. Max 2-3 short sentences. Lead with the answer. No markdown, bullets, or asterisks.";
  } else if (opts.fastMode) {
    system +=
      "\n\nWHATSAPP MODE: Reply in 1-3 short sentences. No markdown. Be direct.";
    if (opts.channelContext) {
      system += `\n\n${opts.channelContext}`;
    }
  }
  return system;
}

function finalizeSpeech(text: string, opts: AgentLoopOptions): string {
  if (opts.voiceMode) return stripMarkdownForSpeech(text);
  return text;
}

function pickModel(opts: AgentLoopOptions, message: string): string {
  if (opts.fastMode || opts.voiceMode) return getFastModel();
  return needsFullModel(message) ? getChatModel() : getFastModel();
}

export async function runAgentLoop(
  opts: AgentLoopOptions
): Promise<AgentLoopResult> {
  const client = getOpenAIClient();
  if (!client) {
    return {
      speech: "OpenAI API key not configured.",
      toolRounds: 0,
      model: "none",
    };
  }

  const factLimit = opts.fastMode ? 4 : 8;
  const facts = await searchFacts(opts.message, factLimit);
  const memoryPacket = getMemoryPacket(opts.message, facts);
  const { confidence, count } = opts.fastMode
    ? { confidence: 1, count: facts.length }
    : await getRetrievalConfidence(opts.message);

  const businessSpecific =
    !opts.fastMode &&
    !opts.voiceMode &&
    /\b(ringba|scrub|affiliate|payout|polyares|payment|publisher|void)\b/i.test(
      opts.message
    );

  const model = pickModel(opts, opts.message);

  if (
    !opts.voiceMode &&
    confidence < 0.15 &&
    count < 3 &&
    businessSpecific
  ) {
    const clar = await client.chat.completions.create({
      model: getFastModel(),
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `The user asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
        },
      ],
    });
    const q = clar.choices[0]?.message?.content?.trim() || "";
    return {
      speech: q,
      toolRounds: 0,
      model: getFastModel(),
      clarification: true,
    };
  }

  const system = buildSystemPrompt(memoryPacket, opts);
  const messages: ChatCompletionMessageParam[] = [
    ...(opts.history || []),
    { role: "user", content: opts.message },
  ];
  const activeTools = getHullToolDefinitions();
  const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 384 : getMaxTokens();

  let toolRounds = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (opts.onToken) {
      const stream = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
        tools: activeTools,
        stream: true,
      });

      let full = "";
      const toolCallsByIndex = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          full += delta.content;
          opts.onToken(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsByIndex.has(idx)) {
              toolCallsByIndex.set(idx, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: "",
              });
            }
            const entry = toolCallsByIndex.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      }

      const toolCalls = [...toolCallsByIndex.values()].filter((t) => t.id && t.name);
      if (toolCalls.length === 0) {
        return {
          speech: finalizeSpeech(full.trim(), opts),
          toolRounds,
          model,
        };
      }

      const assistantMessage: ChatCompletionMessageParam = {
        role: "assistant",
        content: full || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      };
      messages.push(assistantMessage);

      for (const tc of toolCalls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
        } catch {
          input = {};
        }
        let result: unknown;
        try {
          result = await executeHullTool(tc.name, input);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: serializeToolResult(result),
        });
      }
      toolRounds++;
      continue;
    }

    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      tools: activeTools,
    });

    const choice = response.choices[0];
    const msg = choice?.message;
    if (!msg) {
      return {
        speech: "No response from model.",
        toolRounds,
        model,
      };
    }

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      return {
        speech: finalizeSpeech(msg.content?.trim() || "", opts),
        toolRounds,
        model,
      };
    }

    messages.push(msg);
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        input = {};
      }
      let result: unknown;
      try {
        result = await executeHullTool(tc.function.name, input);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: serializeToolResult(result),
      });
    }
    toolRounds++;
  }

  return {
    speech: "Hit the tool loop limit — try a narrower question.",
    toolRounds,
    model,
  };
}

export function extractSentences(buffer: string): {
  sentences: string[];
  remainder: string;
} {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /([^.!?]+[.!?]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const s = m[1].trim();
    if (s.length > 2) sentences.push(s);
  }
  const lastEnd =
    rest.lastIndexOf(".") > rest.lastIndexOf("!")
      ? Math.max(
          rest.lastIndexOf("."),
          rest.lastIndexOf("!"),
          rest.lastIndexOf("?")
        )
      : Math.max(rest.lastIndexOf("!"), rest.lastIndexOf("?"));
  if (lastEnd >= 0) rest = rest.slice(lastEnd + 1);
  else if (sentences.length) rest = "";
  return { sentences, remainder: rest };
}

function findFirstSentenceBoundary(text: string): number {
  const match = text.match(/[.!?…]\s/);
  return match ? match.index! + 1 : -1;
}

function extractFirstSpeechChunk(accumulated: string): string | null {
  const boundary = findFirstSentenceBoundary(accumulated);
  if (boundary > 0) {
    const first = accumulated.slice(0, boundary).trim();
    if (first.length >= 6) return first;
  }
  const comma = accumulated.indexOf(", ");
  if (comma >= 8 && comma < 90) {
    return accumulated.slice(0, comma + 1).trim();
  }
  const trimmed = accumulated.trim();
  if (trimmed.length >= 14 && trimmed.includes(" ")) {
    const words = trimmed.split(/\s+/);
    if (words.length >= 4) return words.slice(0, 4).join(" ");
  }
  return null;
}

export async function handleVoiceCommand(
  req: Request,
  res: Response
): Promise<void> {
  if (!getOpenAIClient()) {
    res.status(503).json({ error: "OPENAI_API_KEY not set" });
    return;
  }

  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing message" });
    return;
  }

  const sessionId =
    typeof req.body?.sessionId === "string"
      ? req.body.sessionId.trim()
      : "jarvis-voice-" + Date.now();
  const streamMode = req.body?.stream === true;

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: ChatCompletionMessageParam[] = rawHistory
    .filter(
      (m: { role?: string; content?: unknown }) =>
        m.role === "user" || m.role === "assistant"
    )
    .map((m: { role: string; content: unknown }) => ({
      role: m.role as "user" | "assistant",
      content:
        typeof m.content === "string"
          ? m.content
          : String(m.content ?? ""),
    }));

  if (streamMode) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let accumulated = "";
    let firstChunkSent = false;

    try {
      const result = await runAgentLoop({
        message,
        history,
        voiceMode: true,
        onToken: (t) => {
          accumulated += t;
          if (!firstChunkSent) {
            const first = extractFirstSpeechChunk(accumulated);
            if (first) {
              firstChunkSent = true;
              res.write(
                `data: ${JSON.stringify({ type: "speech_chunk", text: first, isFinal: false })}\n\n`
              );
            }
          }
        },
      });
      res.write(
        `data: ${JSON.stringify({
          type: "speech_complete",
          speech: result.speech,
          sessionId,
        })}\n\n`
      );
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
    return;
  }

  try {
    const result = await runAgentLoop({
      message,
      history,
      voiceMode: true,
    });
    res.status(200).json({ speech: result.speech, sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

/**
 * Chat mode: server-side sessions. Turns persist in the hull database (last 12
 * feed each reply as working memory) and background extraction runs every few
 * user turns — no client-submitted transcripts needed.
 */
export async function handleChatMessage(req: Request, res: Response): Promise<void> {
  if (!getOpenAIClient()) {
    res.status(503).json({ error: "OPENAI_API_KEY not set" });
    return;
  }

  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }
  const sessionId =
    typeof req.body?.sessionId === "string" && req.body.sessionId.trim()
      ? req.body.sessionId.trim().slice(0, 80)
      : "chat-" + Date.now();

  const { appendTurn, recentTurns, maybeExtractInBackground } = await import(
    "../memory/conversations"
  );

  try {
    const history: ChatCompletionMessageParam[] = recentTurns(sessionId).map(
      (turn) => ({ role: turn.role, content: turn.text })
    );

    appendTurn(sessionId, "user", message);

    const result = await runAgentLoop({ message, history });

    appendTurn(sessionId, "assistant", result.speech);
    maybeExtractInBackground(sessionId);

    res.json({
      speech: result.speech,
      sessionId,
      toolRounds: result.toolRounds,
      model: result.model,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Chat failed",
    });
  }
}

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  if (!getOpenAIClient()) {
    res.status(503).json({ error: "OPENAI_API_KEY not set" });
    return;
  }

  const messages = (req.body?.messages || []) as Array<{
    role: string;
    content: unknown;
  }>;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let message = "";
  if (typeof lastUser?.content === "string") {
    message = lastUser.content.trim();
  } else if (Array.isArray(lastUser?.content)) {
    for (const block of lastUser.content as Array<{
      type?: string;
      text?: string;
    }>) {
      if (block.type === "text") {
        message += (message ? " " : "") + (block.text || "").trim();
      }
    }
  }

  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  const history: ChatCompletionMessageParam[] = messages
    .slice(0, -1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content:
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? ""),
    }));

  const result = await runAgentLoop({
    message,
    history,
    fastMode: req.body?.fast_mode === true,
    voiceMode: req.body?.voice_mode === true,
    ownerMode: req.body?.owner_mode === true,
    channelContext: req.body?.channel_context || undefined,
  });

  res.json({
    id: "chatcmpl-" + Date.now(),
    object: "chat.completion",
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.speech,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}
