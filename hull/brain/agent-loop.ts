import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Request, Response } from "express";
import {
  getMemoryPacket,
  getRetrievalConfidence,
  searchFacts,
} from "../memory/retrieval";
import { executeHullTool, getHullToolDefinitions } from "./tools";

const MAX_AGENT_STEPS = 8;
const MAX_TOOL_CHARS = 12000;

const LEADSMART_SYSTEM_PROMPT = `You are JARVIS, the LeadSmart AI assistant. You help with Ringba call scrub operations, affiliate payouts, payment portal questions, and system status. Be concise and accurate.`;

function getAethonModel(): string {
  return process.env.AETHON_MODEL?.trim() || "claude-sonnet-4-6";
}

function getHaikuModel(): string {
  return process.env.AETHON_HAIKU_MODEL?.trim() || "claude-haiku-4-5-20251001";
}

function getMaxTokens(): number {
  return 2048;
}

function needsSonnet(message: string): boolean {
  return (
    message.length > 600 ||
    /\b(analyze|compare|strategy|explain in detail)\b/i.test(message)
  );
}

export function serializeToolResult(result: unknown): string {
  const str =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (str.length <= MAX_TOOL_CHARS) return str;
  return str.slice(0, MAX_TOOL_CHARS) + `\n\n[TRUNCATED: ${str.length} chars total]`;
}

function extractAssistantText(
  content: Anthropic.Messages.Message["content"]
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

export interface AgentLoopResult {
  speech: string;
  toolRounds: number;
  model: string;
  clarification?: boolean;
}

export interface AgentLoopOptions {
  message: string;
  history?: MessageParam[];
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

export async function runAgentLoop(
  opts: AgentLoopOptions
): Promise<AgentLoopResult> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      speech: "Anthropic API key not configured.",
      toolRounds: 0,
      model: "none",
    };
  }

  const client = new Anthropic({ apiKey: key });
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

  if (
    !opts.voiceMode &&
    confidence < 0.15 &&
    count < 3 &&
    businessSpecific
  ) {
    const clar = await client.messages.create({
      model: getHaikuModel(),
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `The user asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
        },
      ],
    });
    const q = extractAssistantText(clar.content);
    return {
      speech: q,
      toolRounds: 0,
      model: getHaikuModel(),
      clarification: true,
    };
  }

  const system = buildSystemPrompt(memoryPacket, opts);
  const model = opts.fastMode
    ? getHaikuModel()
    : opts.voiceMode
      ? getHaikuModel()
      : needsSonnet(opts.message)
        ? getAethonModel()
        : getHaikuModel();
  const messages: MessageParam[] = [
    ...(opts.history || []),
    { role: "user", content: opts.message },
  ];
  const activeTools = opts.voiceMode ? undefined : getHullToolDefinitions();
  const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 384 : getMaxTokens();

  let toolRounds = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (opts.onToken) {
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: activeTools,
      });

      let full = "";
      const finalMsg = await new Promise<Anthropic.Messages.Message>(
        (resolve, reject) => {
          stream.on("text", (t) => {
            full += t;
            opts.onToken?.(t);
          });
          stream
            .finalMessage()
            .then(resolve)
            .catch(reject);
        }
      );

      if (finalMsg.stop_reason !== "tool_use") {
        const text = full.trim() || extractAssistantText(finalMsg.content);
        return {
          speech: finalizeSpeech(text, opts),
          toolRounds,
          model,
        };
      }

      const toolUseBlocks = finalMsg.content.filter((b) => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tu) => {
          const input =
            tu.input &&
            typeof tu.input === "object" &&
            !Array.isArray(tu.input)
              ? (tu.input as Record<string, unknown>)
              : {};
          let result: unknown;
          try {
            result = await executeHullTool(tu.name, input);
          } catch (err) {
            result = {
              error: err instanceof Error ? err.message : String(err),
            };
          }
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: serializeToolResult(result),
          };
        })
      );
      messages.push({ role: "assistant", content: finalMsg.content });
      messages.push({ role: "user", content: toolResults });
      toolRounds++;
      continue;
    }

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools: activeTools,
    });

    if (response.stop_reason !== "tool_use") {
      return {
        speech: finalizeSpeech(extractAssistantText(response.content), opts),
        toolRounds,
        model,
      };
    }

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tu) => {
        const input =
          tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
            ? (tu.input as Record<string, unknown>)
            : {};
        let result: unknown;
        try {
          result = await executeHullTool(tu.name, input);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: serializeToolResult(result),
        };
      })
    );
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
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

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
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
    for (const block of lastUser.content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text") {
        message += (message ? " " : "") + (block.text || "").trim();
      }
    }
  }

  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }

  const result = await runAgentLoop({
    message,
    history: messages.slice(0, -1).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as MessageParam["content"],
    })),
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
