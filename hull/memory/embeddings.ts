const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

export function embeddingDimensions(): number {
  return EMBEDDING_DIM;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function blobToFloat32(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.length === 0) return null;
  const arr = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return arr;
}

export function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export async function embedText(text: string): Promise<Float32Array | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || !text.trim()) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) {
      console.warn("[hull/embeddings] OpenAI error:", res.status);
      return null;
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) return null;
    return new Float32Array(emb);
  } catch (err) {
    console.warn("[hull/embeddings] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function backfillEmbeddings(limit = 100): Promise<number> {
  const { getHullDb } = await import("./store.js");
  const db = getHullDb();
  const rows = db
    .prepare(
      "SELECT id, content FROM facts WHERE superseded_by IS NULL AND embedding IS NULL LIMIT ?",
    )
    .all(limit) as { id: string; content: string }[];

  let count = 0;
  for (const row of rows) {
    const vec = await embedText(row.content);
    if (!vec) break;
    db.prepare("UPDATE facts SET embedding = ? WHERE id = ?").run(float32ToBlob(vec), row.id);
    count++;
  }
  if (count > 0) console.log(`[hull/embeddings] backfilled ${count} facts`);
  return count;
}