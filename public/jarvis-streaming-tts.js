/**
 * JARVIS streaming TTS — sentence-level queue with lookahead prefetch.
 */
(function () {
  "use strict";

  let ttsIsPlaying = false;
  let ttsCurrentSource = null;
  let ttsAudioCtx = null;
  let ttsSampleRate = 24000;
  let speakResolve = null;
  let speakOnEnd = null;
  let speakSession = null;

  const FIRST_CHUNK_MAX = 85;
  const CHUNK_MAX = 130;

  function stripForSpeech(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/^#+\s*/gm, "")
      .replace(/^[-•]\s+/gm, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitToMaxLen(segment, maxLen) {
    const t = segment.trim();
    if (!t) return [];
    if (t.length <= maxLen) return [t];

    const pieces = [];
    const clauses = t.split(/(?<=[,;])\s+|(?:\s+—\s+)|(?:\s+-\s+)/);
    let buf = "";

    for (const clause of clauses) {
      const c = clause.trim();
      if (!c) continue;
      if (!buf) buf = c;
      else if (buf.length + 1 + c.length <= maxLen) buf += " " + c;
      else {
        pieces.push(buf);
        buf = c;
      }
    }
    if (buf) pieces.push(buf);

    const out = [];
    for (const piece of pieces) {
      if (piece.length <= maxLen) {
        out.push(piece);
        continue;
      }
      const words = piece.split(/\s+/);
      let wb = "";
      for (const w of words) {
        if (!wb) wb = w;
        else if (wb.length + 1 + w.length <= maxLen) wb += " " + w;
        else {
          out.push(wb);
          wb = w;
        }
      }
      if (wb) out.push(wb);
    }
    return out;
  }

  function splitIntoSentences(text) {
    if (!text || text.trim().length === 0) return [];

    const raw = text
      .replace(/([.!?…])\s+(?=[A-Z"''])/g, "$1|||")
      .split("|||")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const merged = [];
    let buffer = "";

    for (const sentence of raw) {
      buffer = buffer ? buffer + " " + sentence : sentence;
      if (buffer.length >= 20) {
        merged.push(buffer);
        buffer = "";
      }
    }
    if (buffer) {
      if (merged.length > 0) merged[merged.length - 1] += " " + buffer;
      else merged.push(buffer);
    }

    const chunks = [];
    for (let i = 0; i < merged.length; i++) {
      const maxLen = i === 0 ? FIRST_CHUNK_MAX : CHUNK_MAX;
      chunks.push(...splitToMaxLen(merged[i], maxLen));
    }
    return chunks;
  }

  function ensureAudioContext(rate) {
    const r = rate && rate > 0 ? rate : 24000;
    if (
      !ttsAudioCtx ||
      ttsAudioCtx.state === "closed" ||
      ttsAudioCtx.sampleRate !== r
    ) {
      try {
        if (ttsAudioCtx) ttsAudioCtx.close();
      } catch (_) {}
      ttsAudioCtx = new AudioContext({ sampleRate: r });
    }
    if (ttsAudioCtx.state === "suspended") ttsAudioCtx.resume();
    ttsSampleRate = r;
    return ttsAudioCtx;
  }

  function finishSpeak(endCallback, naturalEnd) {
    if (!naturalEnd) {
      if (speakResolve) {
        const r = speakResolve;
        speakResolve = null;
        speakOnEnd = null;
        r();
      }
      return;
    }
    ttsIsPlaying = false;
    const onEnd = endCallback || speakOnEnd;
    speakOnEnd = null;
    if (speakResolve) {
      const r = speakResolve;
      speakResolve = null;
      onEnd?.();
      r();
    }
  }

  function abortPlayback() {
    if (speakSession) {
      speakSession.aborted = true;
      speakSession.streamingOpen = false;
    }
    ttsIsPlaying = false;
    if (ttsCurrentSource) {
      try {
        ttsCurrentSource.stop(0);
      } catch (_) {}
      ttsCurrentSource = null;
    }
  }

  async function generateTtsForSentence(text) {
    const startTime = Date.now();
    try {
      const res = await fetch("/jarvis/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 1200) }),
      });
      if (!res.ok) return null;
      const sampleRate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
      const buf = await res.arrayBuffer();
      const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
      const pcm = new Int16Array(buf);
      const ctx = ensureAudioContext(rate);
      const audioBuffer = ctx.createBuffer(1, pcm.length, rate);
      const ch = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      console.log(
        "[jarvis-tts] Generated in",
        Date.now() - startTime,
        "ms —",
        rate,
        "Hz"
      );
      return audioBuffer;
    } catch (err) {
      console.error("[jarvis-tts] Generation error:", err);
      return null;
    }
  }

  function playAudioBuffer(audioBuffer) {
    return new Promise((resolve) => {
      if (!ttsIsPlaying || speakSession?.aborted) {
        resolve();
        return;
      }
      const ctx = ensureAudioContext(ttsSampleRate);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      ttsCurrentSource = source;
      ttsIsPlaying = true;
      source.onended = () => {
        ttsCurrentSource = null;
        resolve();
      };
      source.start(0);
    });
  }

  async function runPlayLoop() {
    const s = speakSession;
    if (!s) return;

    let currentPromise =
      s.chunks.length > 0 ? generateTtsForSentence(s.chunks[0]) : Promise.resolve(null);
    let i = 0;

    while (true) {
      if (s.aborted || !ttsIsPlaying) {
        s.aborted = true;
        break;
      }

      if (i >= s.chunks.length) {
        if (s.streamingOpen) {
          await new Promise((r) => setTimeout(r, 50));
          if (i < s.chunks.length) continue;
        }
        break;
      }

      if (!currentPromise) {
        currentPromise = generateTtsForSentence(s.chunks[i]);
      }

      const audioBuffer = await currentPromise;
      let nextPromise = null;
      if (i + 1 < s.chunks.length) {
        nextPromise = generateTtsForSentence(s.chunks[i + 1]);
      }

      if (!audioBuffer) {
        currentPromise = nextPromise || Promise.resolve(null);
        i++;
        continue;
      }

      s.options?.onStart?.();

      if (s.aborted || !ttsIsPlaying) {
        s.aborted = true;
        break;
      }

      await playAudioBuffer(audioBuffer);
      currentPromise = nextPromise || Promise.resolve(null);
      i++;

      if (s.aborted || !ttsIsPlaying) {
        s.aborted = true;
        break;
      }
    }

    ttsIsPlaying = false;
    ttsCurrentSource = null;
    const wasAborted = s.aborted;
    const endCb = wasAborted ? null : s.options?.onEnd;
    speakSession = null;
    finishSpeak(endCb, !wasAborted);
  }

  function speak(fullText, options) {
    const clean = stripForSpeech(fullText);
    if (!clean) return Promise.resolve();

    speakOnEnd = null;
    abortPlayback();

    const chunks = splitIntoSentences(clean);
    if (!chunks.length) return Promise.resolve();

    ttsIsPlaying = true;
    speakSession = {
      chunks,
      options: options || {},
      aborted: false,
      streamingOpen: Boolean(options?.streamingOpen),
    };

    return new Promise((resolve) => {
      speakResolve = resolve;
      speakOnEnd = options?.onEnd;
      void runPlayLoop();
    });
  }

  function appendRemainingText(fullText, options) {
    const all = splitIntoSentences(stripForSpeech(fullText));
    const s = speakSession;

    if (!s || s.aborted) {
      void speak(fullText, options);
      return;
    }

    const earlyCount = s.chunks.length;
    const remaining = all.slice(earlyCount);
    s.streamingOpen = false;

    if (options?.onEnd) {
      const prev = s.options.onEnd;
      s.options.onEnd = () => {
        prev?.();
        options.onEnd?.();
      };
    }

    if (remaining.length) s.chunks.push(...remaining);
  }

  let prewarmDone = false;

  async function prewarmTts() {
    if (prewarmDone) return;
    prewarmDone = true;
    try {
      await generateTtsForSentence("Ready.");
    } catch (_) {
      prewarmDone = false;
    }
  }

  function isActive() {
    return (
      ttsIsPlaying ||
      ttsCurrentSource !== null ||
      (speakSession && !speakSession.aborted)
    );
  }

  function unlock() {
    if (!ttsAudioCtx) ttsAudioCtx = new AudioContext({ sampleRate: 24000 });
    if (ttsAudioCtx.state === "suspended") ttsAudioCtx.resume();
  }

  function stop() {
    speakOnEnd = null;
    abortPlayback();
    speakSession = null;
    finishSpeak(null, false);
  }

  window.JarvisStreamingTts = {
    speak,
    stop,
    isActive,
    unlock,
    splitIntoSentences,
    appendRemainingText,
    prewarm: prewarmTts,
  };

  void window.JarvisStreamingTts.prewarm();
})();
