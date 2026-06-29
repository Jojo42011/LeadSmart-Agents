(function () {
  "use strict";

  const chatLog = document.getElementById("chatLog");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");
  const chatError = document.getElementById("chatError");
  const sessionId = "jarvis-" + Date.now();

  let chatHistory = [];
  let transcript = [];
  let isBusy = false;
  let audioCtx = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function appendMessage(role, text) {
    if (!chatLog || !text) return;
    const div = document.createElement("div");
    div.className = "chat-msg chat-msg--" + role;
    div.innerHTML =
      '<span class="chat-msg__role">' +
      (role === "user" ? "YOU" : "JARVIS") +
      "</span>" +
      '<p class="chat-msg__text">' +
      escapeHtml(text) +
      "</p>";
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function setError(msg) {
    if (!chatError) return;
    chatError.textContent = msg || "";
    chatError.hidden = !msg;
  }

  function getShell() {
    return window.JarvisShell;
  }

  async function playTTS(text) {
    const res = await fetch("/jarvis/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("TTS failed");
    const sampleRate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
    const buf = await res.arrayBuffer();
    if (!audioCtx) audioCtx = new AudioContext({ sampleRate });
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const int16 = new Int16Array(buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const audioBuf = audioCtx.createBuffer(1, float32.length, sampleRate);
    audioBuf.copyToChannel(float32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);
    return new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    });
  }

  async function askJarvis(userText, voiceMode) {
    chatHistory.push({ role: "user", content: userText });
    transcript.push({ role: "user", text: userText });

    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chatHistory,
        voice_mode: voiceMode,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Chat failed");
    }
    const reply =
      data.choices?.[0]?.message?.content?.trim() || "No response.";
    chatHistory.push({ role: "assistant", content: reply });
    transcript.push({ role: "assistant", text: reply });
    return reply;
  }

  async function maybeExtractMemory() {
    if (transcript.length < 2) return;
    try {
      await fetch("/api/jarvis/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, transcript }),
      });
    } catch {
      /* non-blocking */
    }
  }

  async function handleUserMessage(text, voiceMode) {
    if (!text || isBusy) return;
    const shell = getShell();
    if (!shell) return;

    isBusy = true;
    setError("");
    appendMessage("user", text);

    shell.transitionTo(shell.STATE.PROCESSING);

    try {
      const reply = await askJarvis(text, voiceMode);
      appendMessage("assistant", reply);
      shell.transitionTo(shell.STATE.RESPONDING);

      if (voiceMode) {
        try {
          await playTTS(reply);
        } catch {
          setError("Voice playback failed — text reply shown above.");
        }
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }

      await maybeExtractMemory();
    } catch (err) {
      setError(err.message || "Request failed");
    } finally {
      shell.transitionTo(shell.STATE.STANDBY);
      isBusy = false;
    }
  }

  window.addEventListener("jarvis-transcript", (e) => {
    const text = (e.detail && e.detail.text) || "";
    if (text) void handleUserMessage(text, true);
  });

  if (chatSendBtn && chatInput) {
    chatSendBtn.addEventListener("click", () => {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = "";
      void handleUserMessage(text, false);
    });
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatSendBtn.click();
      }
    });
  }
})();
