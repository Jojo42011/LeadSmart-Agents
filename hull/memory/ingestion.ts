import { randomUUID } from "crypto";
import { getHullDb } from "./store";
import { runContentExtraction } from "./extraction";
import { broadcastHullEvent } from "../ws";

/**
 * Document ingestion — the "feed Jarvis everything" pipeline.
 * Long text is chunked, each chunk run through memory extraction, and every
 * resulting fact tagged with the document id so learning is traceable and a
 * bad document can be retracted in one action.
 */

const CHUNK_CHARS = 3500;
const CHUNK_OVERLAP = 300;
const MAX_DOCUMENT_CHARS = 2_000_000;

export interface DocumentRow {
  id: string;
  title: string;
  source: string | null;
  chars: number;
  chunkCount: number;
  chunksDone: number;
  factsExtracted: number;
  status: "processing" | "done" | "error" | "retracted";
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Split on paragraph boundaries where possible, hard-split otherwise. */
export function chunkContent(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const paragraphBreak = clean.lastIndexOf("\n\n", end);
      const sentenceBreak = clean.lastIndexOf(". ", end);
      const softBreak = Math.max(paragraphBreak, sentenceBreak);
      if (softBreak > start + CHUNK_CHARS * 0.5) {
        end = softBreak + 1;
      }
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter(Boolean);
}

export function listDocuments(limit = 50): DocumentRow[] {
  return getHullDb()
    .prepare("SELECT * FROM documents ORDER BY createdAt DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 200)) as DocumentRow[];
}

export function getDocument(id: string): DocumentRow | null {
  const row = getHullDb()
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(id) as DocumentRow | undefined;
  return row ?? null;
}

function updateDocument(
  id: string,
  fields: Partial<Pick<DocumentRow, "chunksDone" | "factsExtracted" | "status" | "error" | "completedAt">>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (!sets.length) return;
  values.push(id);
  getHullDb()
    .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

/**
 * Register a document and process it in the background. Returns immediately
 * with the document row; progress streams over the hull WebSocket as
 * {type:"ingest_progress"} events and via GET /api/memory/documents.
 */
export function startIngestion(
  title: string,
  source: string | null,
  text: string,
): DocumentRow {
  const clean = String(text || "").slice(0, MAX_DOCUMENT_CHARS);
  const chunks = chunkContent(clean);
  if (chunks.length === 0) {
    throw new Error("Document is empty");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  getHullDb()
    .prepare(
      `INSERT INTO documents (id, title, source, chars, chunkCount, chunksDone, factsExtracted, status, createdAt)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'processing', ?)`,
    )
    .run(id, title.trim() || "Untitled", source?.trim() || null, clean.length, chunks.length, now);

  void processDocument(id, title, chunks);
  return getDocument(id)!;
}

async function processDocument(id: string, title: string, chunks: string[]): Promise<void> {
  let totalFacts = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const written = await runContentExtraction(
        id,
        chunks.length > 1 ? `${title} (part ${i + 1}/${chunks.length})` : title,
        chunks[i],
      );
      if (written === null) {
        updateDocument(id, {
          status: "error",
          error: "OPENAI_API_KEY not configured — extraction unavailable",
          completedAt: new Date().toISOString(),
        });
        broadcastHullEvent({ type: "ingest_progress", docId: id, status: "error" });
        return;
      }
      totalFacts += written;
      updateDocument(id, { chunksDone: i + 1, factsExtracted: totalFacts });
      broadcastHullEvent({
        type: "ingest_progress",
        docId: id,
        chunksDone: i + 1,
        chunkCount: chunks.length,
        factsExtracted: totalFacts,
      });
    }
    updateDocument(id, {
      status: "done",
      completedAt: new Date().toISOString(),
    });
    broadcastHullEvent({ type: "ingest_progress", docId: id, status: "done" });
    console.log(
      "[hull/ingest] Document %s done: %d chunks, %d facts",
      id,
      chunks.length,
      totalFacts,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateDocument(id, {
      status: "error",
      error: message.slice(0, 500),
      completedAt: new Date().toISOString(),
    });
    broadcastHullEvent({ type: "ingest_progress", docId: id, status: "error" });
    console.error("[hull/ingest] Document %s failed: %s", id, message);
  }
}

/**
 * Retract a document: everything Jarvis learned from it is superseded (drops
 * out of retrieval and the memory packet) and the document is marked retracted.
 */
export function retractDocument(id: string): { retractedFacts: number } {
  const db = getHullDb();
  const doc = getDocument(id);
  if (!doc) {
    throw new Error("Document not found");
  }
  const result = db
    .prepare(
      "UPDATE facts SET superseded_by = ? WHERE source_document = ? AND superseded_by IS NULL",
    )
    .run(`retracted-doc-${id}`, id);
  updateDocument(id, { status: "retracted" });
  broadcastHullEvent({ type: "memory_updated" });
  return { retractedFacts: result.changes };
}
