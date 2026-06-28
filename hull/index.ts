import { bootstrapHullMemory } from "./memory/bootstrap.js";
import { backfillEmbeddings } from "./memory/embeddings.js";
import { scheduleDailyDecay } from "./memory/decay.js";
import { scheduleWeeklySynthesis } from "./memory/synthesis.js";
import { scheduleMorningBriefing } from "./briefing.js";
import { broadcastHullEvent } from "./ws.js";

export function initHull(): void {
  bootstrapHullMemory();
  void backfillEmbeddings(100);
  scheduleDailyDecay();
  scheduleWeeklySynthesis();
  scheduleMorningBriefing((brief) => {
    broadcastHullEvent({ type: "morning_briefing", text: brief });
  });
  console.log("[hull] Aethon Intelligence hull initialized");
}

export { runAgentLoop, extractSentences } from "./agentLoop.js";
export { runPostConversationExtraction } from "./memory/extraction.js";
export { handleActivation, getTimeAwareGreeting } from "./briefing.js";
export { buildMemoryPacketForQuery } from "./tools.js";
export { getAethonModel } from "./modelRouting.js";
export { generateTTS } from "./voice/tts.js";
export { getHullDb } from "./memory/store.js";
export { registerHullWs, broadcastHullEvent } from "./ws.js";
export {
  handleOpenClawChatCompletions,
  getOpenClawSession,
  resetOpenClawSession,
} from "./openclaw.js";