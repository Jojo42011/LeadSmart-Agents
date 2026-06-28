import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { randomUUID } from "crypto";
import { embedText, float32ToBlob } from "../memory/embeddings";
import { findSimilarNode } from "../memory/nodes";
import { searchFacts, getMemoryPacket } from "../memory/retrieval";
import { getHullDb } from "../memory/store";

const MEMORY_TOOLS: Tool[] = [
  {
    name: "memory_store",
    description:
      "Explicitly store a durable fact about LeadSmart or its operations. Only call when the user says remember, store, or learn — or shares a stable fact worth keeping.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        category: { type: "string" },
        keywords: { type: "string" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Semantic search across facts and episodes. Only call when the user asks to recall, remember, or search memory.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_graph",
    description:
      "Traverse knowledge graph for an entity name. Only call when the user asks about relationships or connections.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string" },
      },
      required: ["entity"],
    },
  },
];

const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description:
    "Search the internet for current external information. Only call when the user explicitly asks about news, prices, or external research.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

export function getHullToolDefinitions(): Tool[] {
  const tools = [...MEMORY_TOOLS];
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) {
    tools.push(WEB_SEARCH_TOOL);
  }
  return tools;
}

export async function executeHullTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  if (name === "memory_store") {
    const content = String(input.content || "").trim();
    if (!content) return { error: "content required" };
    const db = getHullDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const vec = await embedText(content);
    db.prepare(
      `INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at, embedding)
       VALUES (?, ?, ?, ?, 1.0, 0, ?, ?, ?)`
    ).run(
      id,
      content,
      String(input.category || "general"),
      String(input.keywords || ""),
      now,
      now,
      vec ? float32ToBlob(vec) : null
    );
    return { ok: true, id };
  }

  if (name === "memory_recall") {
    const query = String(input.query || "").trim();
    const facts = await searchFacts(query, 10);
    const db = getHullDb();
    const episodes = db
      .prepare("SELECT summary, tone, timestamp FROM episodes ORDER BY timestamp DESC LIMIT 5")
      .all();
    return { facts, episodes };
  }

  if (name === "memory_graph") {
    const entity = String(input.entity || "").trim();
    const node = findSimilarNode(entity);
    if (!node) return { error: "entity not found", entity };
    const db = getHullDb();
    const edges = db
      .prepare(
        `SELECT e.relationship, n.name as name, n.type
         FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?
         UNION
         SELECT e.relationship, n.name, n.type
         FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`
      )
      .all(node.id, node.id);
    return { entity: node.name, connections: edges };
  }

  if (name === "web_search") {
    const query = String(input.query || "").trim();
    const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!apiKey) return { error: "BRAVE_SEARCH_API_KEY not configured" };
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return { error: `Brave search failed: ${res.status}` };
    const data = (await res.json()) as {
      web?: { results?: { title: string; description: string; url: string }[] };
    };
    return { results: data.web?.results?.slice(0, 5) || [] };
  }

  return { error: `Unknown tool: ${name}` };
}

export async function buildMemoryPacketForQuery(query: string): Promise<string> {
  const facts = await searchFacts(query, 8);
  return getMemoryPacket(query, facts);
}
