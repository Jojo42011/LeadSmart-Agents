import { getSystemState, setSystemState } from "./memory/store";
import { getOpenAIClient, getFastModel } from "./openaiConfig";

const LAST_BRIEFED_DATE_KEY = "last_briefed_date";

export function getEasternDateString(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function getTimeAwareGreeting(): string {
  const hour = parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10
  );
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  return "Good evening.";
}

export async function handleActivation(memoryPacket: string): Promise<string> {
  const today = getEasternDateString();
  const lastBriefed = getSystemState(LAST_BRIEFED_DATE_KEY);
  if (today !== lastBriefed) {
    const brief = await generateBrief(memoryPacket);
    setSystemState(LAST_BRIEFED_DATE_KEY, today);
    return brief;
  }
  return `${getTimeAwareGreeting()} What do you need?`;
}

export async function generateBrief(memoryPacket: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) return getTimeAwareGreeting() + " Systems are online.";

  try {
    const res = await client.chat.completions.create({
      model: getFastModel(),
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Generate a brief activation greeting for JARVIS, the LeadSmart AI operator (Ringba scrub, affiliate payouts, payment portal). Max 4 sentences, spoken aloud. Most urgent first. Max 3 items. Open with a time-aware greeting. If nothing notable: "All clear. What do you need?" Context:\n${memoryPacket.slice(0, 2000)}`,
        },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text || getTimeAwareGreeting();
  } catch {
    return getTimeAwareGreeting();
  }
}
