import { getHullDb } from "./store";
import { runPostConversationExtraction } from "./extraction";

/**
 * Server-side working memory for chat mode: turns are persisted per session so
 * a conversation survives browser refreshes, and extraction runs periodically
 * in the background instead of relying on the client to submit transcripts.
 */

const WORKING_MEMORY_TURNS = 12;
/** Run background extraction every N user turns. */
const EXTRACTION_EVERY_USER_TURNS = 4;

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export function appendTurn(sessionId: string, role: "user" | "assistant", text: string): void {
  getHullDb()
    .prepare(
      "INSERT INTO conversations (session_id, role, text, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, role, text.slice(0, 20_000), new Date().toISOString());
}

/** The most recent turns for a session, oldest first. */
export function recentTurns(sessionId: string, limit = WORKING_MEMORY_TURNS): ConversationTurn[] {
  const rows = getHullDb()
    .prepare(
      `SELECT role, text FROM conversations
       WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{ role: string; text: string }>;
  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: row.text,
    }));
}

function userTurnCount(sessionId: string): number {
  const row = getHullDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM conversations WHERE session_id = ? AND role = 'user'",
    )
    .get(sessionId) as { c: number };
  return row.c;
}

/**
 * Fire-and-forget memory extraction every few user turns so long chat sessions
 * feed durable memory without an explicit "end session" step.
 */
export function maybeExtractInBackground(sessionId: string): void {
  const count = userTurnCount(sessionId);
  if (count === 0 || count % EXTRACTION_EVERY_USER_TURNS !== 0) {
    return;
  }
  const turns = recentTurns(sessionId, EXTRACTION_EVERY_USER_TURNS * 2);
  if (turns.length < 2) return;
  void runPostConversationExtraction(
    sessionId,
    turns.map((t) => ({ role: t.role, text: t.text })),
  ).catch((err) => {
    console.warn(
      "[hull/conversations] background extraction failed:",
      err instanceof Error ? err.message : err,
    );
  });
}
