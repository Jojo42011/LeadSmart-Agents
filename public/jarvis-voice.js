/**
 * JARVIS voice — ElevenLabs Scribe STT (WS) + OpenAI brain + streaming TTS
 */
(function () {
  "use strict";

  const BARGE_IN_RMS_THRESHOLD = 3;

  let processor = null;
  let lpFilter = null;
  let captureCtx = null;
  let micStream = null;
  let sttWs = null;
  let sessionReady = false;
  let listening = false;
  let micSending = true;
  let voiceActive = false;
  let bargeInCooldown = false;

  let playCtx = null;
  let ttsQueue = [];
  let isPlaying = false;
  let currentSource = null;

  let sessionTranscript = [];
  let sessionStartTime = null;
  let brainBusy = false;
  let currentTurnIndex = -1;
  let latestTurnTranscript = "";
  let pendingCommitTimer = null;
  let micCaptureActive = false;

  function voiceSessionId() {
    const stored = sessionStorage.getItem("jarvis_session_id");
    if (stored) return stored;
    const id = "jarvis-voice-" + Date.now();
    sessionStorage.setItem("jarvis_session_id", id);
    return id;
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function shouldCommitTranscript(text, event) {
    const t = text.trim();
    if (!t) return false;
    if (!isMicCaptureActive()) return false;
    if (brainBusy || isVoicePlaybackActive()) return false;
    if (event !== "EndOfTurn") return false;
    if (wordCount(t) < 2 && t.length < 12) return false;
    return true;
  }

  function scheduleCommit(text, event) {
    if (!shouldCommitTranscript(text, event)) return;
    if (pendingCommitTimer) clearTimeout(pendingCommitTimer);
    pendingCommitTimer = setTimeout(() => {
      pendingCommitTimer = null;
      if (shouldCommitTranscript(text, event)) {
        void commitTranscript(text.trim());
      }
    }, 40);
  }

  window.isJarvisVoiceActive = function () {
    return voiceActive;
  };

  function syncShell(status) {
    const shell = window.JarvisShell;
    if (!shell) return;
    const map = {
      CONNECTING: shell.STATE.PROCESSING,
      LISTENING: shell.STATE.LISTENING,
      RESPONDING: shell.STATE.RESPONDING,
      PROCESSING: shell.STATE.PROCESSING,
      STANDBY: shell.STATE.STANDBY,
      ERROR: shell.STATE.STANDBY,
    };
    shell.transitionTo(map[status] || shell.STATE.STANDBY);
  }

  function setVoiceStatus(status) {
    const labels = {
      CONNECTING: "Connecting STT…",
      LISTENING: "Listening",
      RESPONDING: "Speaking",
      PROCESSING: "Thinking",
      STANDBY: "Standby",
      ERROR: "Error — check console",
    };
    const el = document.getElementById("jarvis-voice-status");
    if (el) el.textContent = labels[status] || status;
    syncShell(status);
  }

  function showVoiceError(msg) {
    const el = document.getElementById("jarvis-voice-error");
    if (el) {
      el.textContent = msg;
      el.hidden = false;
    }
    console.error("[jarvis-voice]", msg);
  }

  function clearVoiceError() {
    const el = document.getElementById("jarvis-voice-error");
    if (el) {
      el.textContent = "";
      el.hidden = true;
    }
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate === inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = buffer[idx] || 0;
      const b = buffer[Math.min(idx + 1, buffer.length - 1)] || 0;
      result[i] = a + frac * (b - a);
    }
    return result;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function stopCapture() {
    if (processor) {
      try {
        processor.disconnect();
        processor.onaudioprocess = null;
      } catch (_) {}
      processor = null;
    }
    if (lpFilter) {
      try {
        lpFilter.disconnect();
      } catch (_) {}
      lpFilter = null;
    }
    if (captureCtx) {
      try {
        captureCtx.close();
      } catch (_) {}
      captureCtx = null;
    }
  }

  function pauseMicCapture() {
    micCaptureActive = false;
    micSending = false;
  }

  function resumeMicCapture() {
    if (!voiceActive || !listening) return;
    micCaptureActive = true;
    micSending = true;
  }

  function isMicCaptureActive() {
    return micCaptureActive;
  }

  async function startCapture() {
    if (processor && captureCtx) return;
    stopCapture();
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    }

    captureCtx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    if (captureCtx.state === "suspended") await captureCtx.resume();

    const source = captureCtx.createMediaStreamSource(micStream);
    const inputRate = captureCtx.sampleRate;

    lpFilter = captureCtx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.frequency.value = 7500;
    lpFilter.Q.value = 0.707;

    processor = captureCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!listening || !sessionReady) return;
      const input = e.inputBuffer.getChannelData(0);

      if (micSending) {
        if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;
        const down = downsampleBuffer(input, inputRate, 16000);
        const pcm = floatTo16BitPCM(down);
        sttWs.send(pcm.buffer);
        return;
      }

      if (!isVoicePlaybackActive() || bargeInCooldown) return;
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length) * 100;
      if (rms > BARGE_IN_RMS_THRESHOLD) {
        triggerBargeIn();
      }
    };

    source.connect(lpFilter);
    lpFilter.connect(processor);
    processor.connect(captureCtx.destination);
    micSending = true;
    micCaptureActive = true;
  }

  function stopMicStream() {
    stopCapture();
    micCaptureActive = false;
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  function handleSttMessage(raw) {
    let msg;
    try {
      msg =
        typeof raw === "string"
          ? JSON.parse(raw)
          : JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "ready" || msg.type === "Connected") {
      sessionReady = true;
      setVoiceStatus("LISTENING");
      return;
    }

    if (msg.type === "TurnInfo") {
      const transcript = (msg.transcript || "").trim();
      const turnIndex = typeof msg.turn_index === "number" ? msg.turn_index : 0;
      const event = msg.event || "";

      if (event === "StartOfTurn") {
        if (!isMicCaptureActive()) return;
        if (!isVoicePlaybackActive()) return;
        triggerBargeIn();
        return;
      }

      if (event === "StartOfTurn" || event === "Update") {
        if (turnIndex !== currentTurnIndex) {
          currentTurnIndex = turnIndex;
          latestTurnTranscript = transcript;
        } else if (transcript) {
          latestTurnTranscript = transcript;
        }
        if (latestTurnTranscript) {
          window.onJarvisPartialTranscript?.(latestTurnTranscript, false);
        }
        return;
      }

      if (event === "TurnResumed") {
        if (pendingCommitTimer) {
          clearTimeout(pendingCommitTimer);
          pendingCommitTimer = null;
        }
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EagerEndOfTurn") {
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EndOfTurn") {
        const finalText = transcript || latestTurnTranscript;
        latestTurnTranscript = finalText;
        if (finalText) {
          window.onJarvisPartialTranscript?.(finalText, true);
        }
        scheduleCommit(finalText, event);
      }
      return;
    }

    if (msg.type === "Results" || msg.type === "Metadata") return;
  }

  function pauseMicForResponse() {
    pauseMicCapture();
    setVoiceStatus("RESPONDING");
  }

  function getChatHistory() {
    if (window.JarvisChat?.getHistory) {
      return window.JarvisChat.getHistory();
    }
    return [];
  }

  async function commitTranscript(text) {
    if (!text || brainBusy) return;
    brainBusy = true;
    sessionTranscript.push({ role: "user", text, ts: Date.now() });
    setVoiceStatus("PROCESSING");
    pauseMicCapture();

    try {
      const res = await fetch("/api/jarvis/voice/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: voiceSessionId(),
          stream: true,
          history: getChatHistory(),
        }),
      });
      if (!res.ok) throw new Error("Brain HTTP " + res.status);

      const contentType = res.headers.get("Content-Type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let firstChunkStarted = false;
        let fullSpeech = "";
        let speakPromise = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            const data = JSON.parse(line.slice(6));
            if (data.type === "error") throw new Error(data.error || "Brain stream error");
            if (data.type === "speech_chunk" && !firstChunkStarted && data.text) {
              firstChunkStarted = true;
              pauseMicForResponse();
              speakPromise = window.JarvisStreamingTts.speak(data.text, {
                streamingOpen: true,
              });
            }
            if (data.type === "speech_complete") {
              fullSpeech = data.speech || "";
              if (data.sessionId) {
                sessionStorage.setItem("jarvis_session_id", data.sessionId);
              }
            }
          }
        }

        if (fullSpeech) {
          sessionTranscript.push({ role: "assistant", text: fullSpeech, ts: Date.now() });
          if (window.JarvisChat?.pushTurn) {
            window.JarvisChat.pushTurn("user", text);
            window.JarvisChat.pushTurn("assistant", fullSpeech);
          }

          if (firstChunkStarted) {
            window.JarvisStreamingTts.appendRemainingText(fullSpeech, {
              onEnd: () => {
                resumeMicCapture();
                setVoiceStatus("LISTENING");
              },
            });
            if (speakPromise) await speakPromise;
          } else {
            await speakText(fullSpeech);
          }
        }
      } else {
        const data = await res.json();
        const speech = data.speech || "";
        if (speech) {
          sessionTranscript.push({ role: "assistant", text: speech, ts: Date.now() });
          if (window.JarvisChat?.pushTurn) {
            window.JarvisChat.pushTurn("user", text);
            window.JarvisChat.pushTurn("assistant", speech);
          }
          await speakText(speech);
        }
      }
    } catch (err) {
      showVoiceError(err instanceof Error ? err.message : String(err));
      setVoiceStatus("ERROR");
    } finally {
      brainBusy = false;
    }

    if (!isVoicePlaybackActive() && !isMicCaptureActive() && voiceActive) {
      resumeMicCapture();
      setVoiceStatus("LISTENING");
    }
  }

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

  function isVoicePlaybackActive() {
    if (window.JarvisStreamingTts?.isActive?.()) return true;
    return isPlaying;
  }

  async function speakText(fullText) {
    if (window.JarvisStreamingTts) {
      pauseMicForResponse();
      await window.JarvisStreamingTts.speak(fullText, {
        onEnd: () => {
          resumeMicCapture();
          setVoiceStatus("LISTENING");
        },
      });
      return;
    }
    const clean = stripForSpeech(fullText);
    if (!clean) return;
    ttsQueue.push(clean);
    if (!isPlaying) drainTtsQueue();
  }

  async function drainTtsQueue() {
    if (isPlaying) return;
    isPlaying = true;
    pauseMicCapture();
    setVoiceStatus("RESPONDING");

    while (ttsQueue.length > 0) {
      const text = ttsQueue.shift();
      if (!text) continue;
      try {
        const res = await fetch("/jarvis/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.slice(0, 1200) }),
        });
        if (!res.ok) continue;
        const sampleRate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
        const buf = await res.arrayBuffer();
        await playPcm(buf, sampleRate);
      } catch (e) {
        console.error("[jarvis-voice] TTS error:", e);
      }
    }

    isPlaying = false;
    resumeMicCapture();
    setVoiceStatus("LISTENING");
  }

  function unlockAudioFromUserGesture() {
    window.JarvisStreamingTts?.unlock?.();
    if (!playCtx) playCtx = new AudioContext();
    if (playCtx.state === "suspended") playCtx.resume();
  }

  function playPcm(buffer, sampleRate) {
    return new Promise((resolve) => {
      const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
      if (!playCtx || playCtx.sampleRate !== rate) {
        try {
          if (playCtx) playCtx.close();
        } catch (_) {}
        playCtx = new AudioContext({ sampleRate: rate });
      }
      if (playCtx.state === "suspended") playCtx.resume();

      const pcm = new Int16Array(buffer);
      const audioBuffer = playCtx.createBuffer(1, pcm.length, rate);
      const ch = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

      const source = playCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playCtx.destination);
      currentSource = source;
      source.start(playCtx.currentTime);
      source.onended = () => {
        currentSource = null;
        resolve();
      };
    });
  }

  async function flushTranscriptToMemory() {
    if (sessionTranscript.length < 2) {
      sessionTranscript = [];
      return;
    }
    try {
      await fetch("/api/memory/extract-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: voiceSessionId(),
          transcript: sessionTranscript.map((t) => ({ role: t.role, text: t.text })),
          sessionStart: sessionStartTime,
          sessionEnd: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.error("[jarvis-voice] memory flush failed:", e);
    }
    sessionTranscript = [];
    sessionStartTime = null;
  }

  async function startJarvisVoice() {
    if (typeof window.onJarvisVoiceSessionStart === "function") {
      window.onJarvisVoiceSessionStart();
    }
    clearVoiceError();
    setVoiceStatus("CONNECTING");
    voiceActive = true;
    sessionStartTime = new Date().toISOString();
    listening = true;
    sessionReady = false;

    const wsUrl = (
      window.location.origin + "/api/jarvis/deepgram/listen"
    ).replace(/^http/, "ws");

    const micPromise = navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      .then((stream) => {
        micStream = stream;
      });

    const wsPromise = new Promise((resolve, reject) => {
      sttWs = new WebSocket(wsUrl);
      sttWs.binaryType = "arraybuffer";

      sttWs.onmessage = (ev) => {
        handleSttMessage(ev.data);
      };

      sttWs.onerror = () => {
        reject(new Error("STT WebSocket error — check ELEVENLABS_API_KEY"));
      };

      sttWs.onclose = () => {
        listening = false;
        sessionReady = false;
      };

      sttWs.onopen = () => resolve();
    });

    try {
      await Promise.all([micPromise, wsPromise]);
      await startCapture();
      setVoiceStatus("LISTENING");
    } catch (err) {
      showVoiceError(err instanceof Error ? err.message : String(err));
      setVoiceStatus("ERROR");
      voiceActive = false;
      listening = false;
      if (sttWs) {
        sttWs.close();
        sttWs = null;
      }
      stopMicStream();
    }
  }

  function stopJarvisVoice() {
    voiceActive = false;
    listening = false;
    ttsQueue = [];
    window.JarvisStreamingTts?.stop?.();
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (_) {}
      currentSource = null;
    }
    isPlaying = false;
    if (sttWs) {
      sttWs.close();
      sttWs = null;
    }
    stopMicStream();
    void flushTranscriptToMemory();
    setVoiceStatus("STANDBY");
    if (typeof window.onJarvisVoiceSessionEnd === "function") {
      window.onJarvisVoiceSessionEnd();
    }
  }

  function interruptJarvis() {
    window.JarvisStreamingTts?.stop?.();
    ttsQueue = [];
    if (currentSource) {
      try {
        currentSource.stop(0);
      } catch (_) {}
      currentSource = null;
    }
    isPlaying = false;
    if (!isMicCaptureActive()) {
      resumeMicCapture();
      setVoiceStatus("LISTENING");
    }
  }

  function triggerBargeIn() {
    if (bargeInCooldown) return;
    bargeInCooldown = true;
    setTimeout(() => {
      bargeInCooldown = false;
    }, 300);
    interruptJarvis();
  }

  window.interruptJarvis = interruptJarvis;
  window.unlockJarvisVoiceAudio = unlockAudioFromUserGesture;

  window.startJarvisVoiceSession = async function () {
    unlockAudioFromUserGesture();
    if (voiceActive) return;
    await startJarvisVoice();
  };

  window.stopJarvisVoiceSession = function () {
    if (!voiceActive) return;
    stopJarvisVoice();
  };

  window.toggleJarvisVoiceSession = async function () {
    unlockAudioFromUserGesture();
    if (voiceActive) {
      stopJarvisVoice();
    } else {
      await startJarvisVoice();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const orb = document.getElementById("orb-canvas");
    if (orb) {
      orb.addEventListener(
        "pointerdown",
        () => {
          window.unlockJarvisVoiceAudio?.();
          window.JarvisStreamingTts?.prewarm?.();
        },
        { passive: true }
      );
    }
  });
})();
