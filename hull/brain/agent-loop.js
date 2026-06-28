import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { getAethonModel, getHaikuModel, getMaxTokens, needsSonnet } from "../modelRouting.js";
import { searchFacts, getMemoryPacket, getRetrievalConfidence } from "../memory/retrieval.js";
import { getHullToolDefinitions, executeHullTool } from "../tools.js";
import { isGmailConfigured } from "../../integrations/gmail/index.js";
import { maybeAppendCuriosityQuestion } from "../curiosity.js";

const MAX_AGENT_STEPS = 8;
const MAX_TOOL_CHARS = 12000;

export function serializeToolResult(result: unknown): string {
  const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (str.length <= MAX_TOOL_CHARS) return str;
  return str.slice(0, MAX_TOOL_CHARS) + `\n\n[TRUNCATED: ${str.length} chars total]`;
}

function extractAssistantText(content: Anthropic.Messages.Message["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
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
  /** Low-latency path (WhatsApp): Haiku, short replies. */
  fastMode?: boolean;
  /** Marco self-chat — enables whatsapp_send for delegated outbound messages. */
  ownerMode?: boolean;
  /** Per-contact context line (e.g. Jahan DM). */
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

function finalizeSpeech(text: string, opts: AgentLoopOptions, hadToolOnly: boolean): string {
  let speech = opts.fastMode
    ? text
    : opts.voiceMode
      ? text
      : maybeAppendCuriosityQuestion(text, hadToolOnly);
  if (opts.voiceMode) speech = stripMarkdownForSpeech(speech);
  return speech;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
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
    /\b(lead|client|deal|listing|marco|tiktok|mojo|brivity|canyon|price|funnel)\b/i.test(opts.message);

  if (!opts.voiceMode && confidence < 0.15 && count < 3 && businessSpecific) {
    const clar = await client.messages.create({
      model: getHaikuModel(),
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Marco asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
        },
      ],
    });
    const q = extractAssistantText(clar.content);
    return { speech: q, toolRounds: 0, model: getHaikuModel(), clarification: true };
  }

  let system = buildFounderSystemPrompt(memoryPacket);
  system += `\n\n${HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT}`;
  if (opts.voiceMode) {
    system +=
      "\n\nVOICE MODE: Spoken replies only. Max 2-3 short sentences. Lead with the number or answer. No markdown, bullets, or asterisks — plain spoken English. For lead counts, TikTok stats, tasks, or pipeline questions, call the matching tool first instead of guessing. If the utterance is incomplete, ask one short clarifying question.";
    if (isGmailConfigured()) {
      system +=
        "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send first. Use to=\"marco\" for his inbox. NEVER confirm sent unless gmail_send returned ok:true with messageId.";
    }
  } else if (opts.fastMode) {
    system +=
      "\n\nWHATSAPP MODE: Reply in 1-3 short sentences. No markdown. Be direct and conversational.";
    if (opts.ownerMode) {
      system +=
        "\n\nWhen Marco asks you to text/send someone on WhatsApp, call whatsapp_send with the contact name or number and exact message. Confirm briefly after sending.";
    }
    if (opts.channelContext) {
      system += `\n\n${opts.channelContext}`;
    }
  }

  const model = opts.fastMode
    ? getHaikuModel()
    : opts.voiceMode
      ? getHaikuModel()
      : needsSonnet(opts.message)
        ? getAethonModel()
        : getHaikuModel();
  const messages: MessageParam[] = [...(opts.history || []), { role: "user", content: opts.message }];
  const hullTools = getHullToolDefinitions({ whatsappSend: opts.ownerMode });
  const sonnetTools = !opts.fastMode && model === getAethonModel();
  const ownerWhatsAppTools = opts.fastMode && opts.ownerMode;
  const voiceTools = Boolean(opts.voiceMode) && !opts.fastMode;
  const emailIntent =
    isGmailConfigured() &&
    /\b(send|email|e-mail|mail)\b/i.test(opts.message) &&
    /\b(email|e-mail|mail|inbox|gmail|me|marco)\b/i.test(opts.message);
  const nurtureIntent =
    /\b(nurture|scoring|score|hot lead|warm lead|cold lead|lead nurture|re-score|rescore)\b/i.test(
      opts.message,
    );
  const gmailTools =
    isGmailConfigured() &&
    (sonnetTools || ownerWhatsAppTools || voiceTools || emailIntent || opts.ownerMode);
  const nurtureTools =
    sonnetTools || ownerWhatsAppTools || voiceTools || nurtureIntent || opts.ownerMode;
  const toolsEnabled = sonnetTools || ownerWhatsAppTools || voiceTools || gmailTools || nurtureTools;
  if (gmailTools) {
    system +=
      "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send with recipient, subject, and body before replying. For Marco's inbox use to=\"marco\" or his full email if you know it. NEVER say an email was sent unless gmail_send returned ok:true with a messageId — if the tool returns error, report that error to Marco.";
  }
  if (nurtureTools) {
    system +=
      "\n\nLEAD NURTURE: For scoring, hot/warm/cold tiers, or nurture routing questions, call get_lead_nurture_overview or get_lead_nurture_tier before answering. Use get_lead_score_detail for one lead. Use lead_nurture_score_all / lead_nurture_rescore_cold only when Marco explicitly asks to refresh scores.";
  }
  const activeTools = toolsEnabled ? hullTools : undefined;
  const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 384 : getMaxTokens();

  let toolRounds = 0;
  let hadToolOnly = false;

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
      const finalMsg = await new Promise<Anthropic.Messages.Message>((resolve, reject) => {
        stream.on("text", (t) => {
          full += t;
          opts.onToken?.(t);
        });
        stream
          .finalMessage()
          .then(resolve)
          .catch(reject);
      });

      if (finalMsg.stop_reason !== "tool_use") {
        const text = full.trim() || extractAssistantText(finalMsg.content);
        return { speech: finalizeSpeech(text, opts, hadToolOnly), toolRounds, model };
      }

      const toolUseBlocks = finalMsg.content.filter((b) => b.type === "tool_use");
      hadToolOnly = toolUseBlocks.length > 0 && !full.trim();
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
        }),
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
        speech: finalizeSpeech(extractAssistantText(response.content), opts, hadToolOnly),
        toolRounds,
        model,
      };
    }

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    hadToolOnly = true;
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
      }),
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

export function extractSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /([^.!?]+[.!?]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const s = m[1].trim();
    if (s.length > 2) sentences.push(s);
  }
  const lastEnd = rest.lastIndexOf(".") > rest.lastIndexOf("!")
    ? Math.max(rest.lastIndexOf("."), rest.lastIndexOf("!"), rest.lastIndexOf("?"))
    : Math.max(rest.lastIndexOf("!"), rest.lastIndexOf("?"));
  if (lastEnd >= 0) rest = rest.slice(lastEnd + 1);
  else if (sentences.length) rest = "";
  return { sentences, remainder: rest };
}

// OpenAI-compatible /v1/chat/completions handler
export async function handleChatCompletions(req: any, res: any): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
    return;
  }

  const messages = req.body?.messages || [];
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  let message = "";
  if (typeof lastUser?.content === "string") {
    message = lastUser.content.trim();
  } else if (Array.isArray(lastUser?.content)) {
    for (const block of lastUser.content) {
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
    history: messages.slice(0, -1).map((m: any) => ({ role: m.role, content: m.content })),
    fastMode: req.body?.fast_mode === true,
    voiceMode: req.body?.voice_mode === true,
    ownerMode: req.body?.owner_mode === true,
    channelContext: req.body?.channel_context || undefined,
  });

  res.json({
    id: "chatcmpl-" + Date.now(),
    object: "chat.completion",
    model: result.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: result.speech,
      },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}