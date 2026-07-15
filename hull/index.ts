import { bootstrapHullMemory } from "./memory/bootstrap";
import { backfillEmbeddings } from "./memory/embeddings";
import { scheduleDailyDecay } from "./memory/decay";
import { scheduleWeeklySynthesis } from "./memory/synthesis";
import { scheduleReflection } from "./memory/reflection";

export function initHull(): void {
  bootstrapHullMemory();
  void backfillEmbeddings(100);
  scheduleDailyDecay();
  scheduleWeeklySynthesis();
  scheduleReflection();
  console.log("[hull] Aethon Intelligence hull initialized");
}

export {
  runAgentLoop,
  extractSentences,
  handleChatCompletions,
} from "./brain/agent-loop";
export { runPostConversationExtraction } from "./memory/extraction";
export {
  buildMemoryPacketForQuery,
  getHullToolDefinitions,
  executeHullTool,
} from "./brain/tools";
export { generateTTS } from "./voice/tts";
export { getHullDb } from "./memory/store";
export { registerHullWs, broadcastHullEvent } from "./ws";
export { handleActivation } from "./briefing";
