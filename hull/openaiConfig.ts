import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  if (!client) {
    client = new OpenAI({ apiKey: key });
  }
  return client;
}

export function getChatModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o";
}

export function getFastModel(): string {
  return process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4o-mini";
}

export function getMaxTokens(): number {
  const raw = process.env.OPENAI_MAX_TOKENS?.trim();
  if (!raw) return 2048;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 2048 : parsed;
}

export function needsFullModel(message: string): boolean {
  return (
    message.length > 600 ||
    /\b(analyze|compare|strategy|explain in detail)\b/i.test(message)
  );
}
