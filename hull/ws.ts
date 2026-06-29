import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

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

export function handleHullEventsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const url = request.url || "";
  if (!url.includes("/api/hull/events")) return false;

  const wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(request, socket, head, (ws) => {
    registerHullWs(ws);
    ws.send(JSON.stringify({ type: "connected" }));
  });
  return true;
}
