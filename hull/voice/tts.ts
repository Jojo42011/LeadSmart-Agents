const ttsCache = new Map<string, { pcm: Buffer; sampleRate: number }>();
const TTS_CACHE_MAX = 50;

/** ElevenLabs returns raw S16LE PCM when output_format=pcm_24000 — matches the client's Int16 decoder. */
const ELEVENLABS_SAMPLE_RATE = 24000;

export async function generateTTS(text: string): Promise<{ pcm: Buffer; sampleRate: number } | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key || !text.trim()) return null;

  const cacheKey = text.trim().toLowerCase().substring(0, 200);
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    console.log("[TTS] Cache HIT for:", text.substring(0, 40));
    return cached;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM";
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5";

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    voiceId,
  )}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/pcm",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        text,
        model_id: modelId,
      }),
    });
  } catch (err) {
    console.error("[hull/tts] ElevenLabs request failed:", err instanceof Error ? err.message : err);
    return null;
  }

  if (!res.ok) {
    console.error("[hull/tts] ElevenLabs error:", res.status, await res.text().catch(() => ""));
    return null;
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (!pcm.length) return null;

  const result = { pcm, sampleRate: ELEVENLABS_SAMPLE_RATE };
  if (ttsCache.size >= TTS_CACHE_MAX) {
    const firstKey = ttsCache.keys().next().value;
    if (firstKey) ttsCache.delete(firstKey);
  }
  ttsCache.set(cacheKey, result);
  console.log("[TTS] Cached result for:", text.substring(0, 40), "— cache size:", ttsCache.size);

  return result;
}