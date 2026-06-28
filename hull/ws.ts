import { WebSocket } from "ws";

const clients = new Set<WebSocket>();

export function registerHullWs(ws: WebSocket): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcastHullEvent(payload: Record<string, unknown>): void {
  const msg = JSON.stringify(payload);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}