import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

/**
 * JARVIS voice STT proxy.
 *
 * Upstream is ElevenLabs Scribe v2 Realtime (wss://api.elevenlabs.io/v1/speech-to-text/realtime).
 * We keep the public route (/api/jarvis/deepgram/listen) and the exported function name
 * unchanged so the browser client and server wiring do not need to change.
 *
 * The browser still streams raw 16-bit / 16 kHz PCM and still expects Deepgram Flux-style
 * "TurnInfo" frames, so this proxy translates in both directions:
 *   client PCM (binary)        -> Scribe input_audio_chunk (JSON, base64)
 *   Scribe partial_transcript  -> { type:"TurnInfo", event:"StartOfTurn"|"Update", transcript }
 *   Scribe committed_transcript-> { type:"TurnInfo", event:"EndOfTurn", transcript }
 */
const ELEVENLABS_STT_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export function elevenLabsSttUrl(): string {
  const model = process.env.ELEVENLABS_STT_MODEL?.trim() || "scribe_v2_realtime";
  const silenceSecs = process.env.ELEVENLABS_STT_SILENCE_SECS?.trim() || "0.65";
  const params = new URLSearchParams({
    model_id: model,
    audio_format: "pcm_16000",
    commit_strategy: "vad",
    vad_silence_threshold_secs: silenceSecs,
    no_verbatim: "true",
  });
  return `${ELEVENLABS_STT_BASE}?${params}`;
}

export function handleDeepgramUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  tokenOk: (req: IncomingMessage) => boolean,
): boolean {
  const url = request.url || "";
  if (!url.includes("/api/jarvis/deepgram/listen")) return false;

  if (!tokenOk(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return true;
  }

  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return true;
  }

  const upstream = new WebSocket(elevenLabsSttUrl(), {
    headers: { "xi-api-key": key },
  });

  let clientWs: WebSocket | null = null;

  // Turn tracking so we can emit Flux-compatible TurnInfo events to the client.
  let turnIndex = 0;
  let inTurn = false;

  const sendToClient = (payload: unknown) => {
    if (clientWs?.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  const wss = new WebSocketServer({ noServer: true });

  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    clientWs = ws;

    upstream.on("open", () => {
      console.log("[hull/elevenlabs-stt] Scribe proxy connected");
    });

    upstream.on("message", (data) => {
      let msg: { message_type?: string; text?: string; error?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.message_type) {
        case "session_started":
          // Upstream is ready — tell the client to start streaming.
          sendToClient({ type: "Connected", source: "elevenlabs-scribe" });
          return;

        case "partial_transcript": {
          const transcript = (msg.text || "").trim();
          if (!inTurn) {
            inTurn = true;
            sendToClient({ type: "TurnInfo", event: "StartOfTurn", transcript, turn_index: turnIndex });
          }
          sendToClient({ type: "TurnInfo", event: "Update", transcript, turn_index: turnIndex });
          return;
        }

        case "committed_transcript": {
          const transcript = (msg.text || "").trim();
          sendToClient({ type: "TurnInfo", event: "EndOfTurn", transcript, turn_index: turnIndex });
          inTurn = false;
          turnIndex += 1;
          return;
        }

        // Timestamped variant arrives after committed_transcript — already handled.
        case "committed_transcript_with_timestamps":
          return;

        case "auth_error":
        case "quota_exceeded":
        case "rate_limited":
        case "unaccepted_terms":
        case "resource_exhausted":
        case "session_time_limit_exceeded":
        case "transcriber_error":
        case "input_error":
        case "chunk_size_exceeded":
        case "queue_overflow":
        case "error":
          console.error(`[hull/elevenlabs-stt] upstream ${msg.message_type}: ${msg.error || "(no detail)"}`);
          if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
          return;

        default:
          return;
      }
    });

    upstream.on("close", () => {
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    upstream.on("error", (err) => {
      console.error("[hull/elevenlabs-stt] upstream error:", err.message);
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    ws.on("message", (data, isBinary) => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      // Client streams raw 16-bit / 16 kHz PCM. Wrap each chunk for Scribe.
      if (isBinary) {
        const audioBase64 = (data as Buffer).toString("base64");
        if (!audioBase64) return;
        upstream.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: audioBase64,
            commit: false,
            sample_rate: 16000,
          }),
        );
      }
    });

    ws.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });

    ws.on("error", () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
  });

  return true;
}