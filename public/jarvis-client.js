(function () {
  "use strict";

  const chatLog = document.getElementById("chatLog");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");
  const chatError = document.getElementById("chatError");
  const sessionId =
    sessionStorage.getItem("jarvis_session_id") || "jarvis-" + Date.now();

  let chatHistory = [];
  let transcript = [];
  let isBusy = false;

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

  function pushTurn(role, text) {
    if (!text) return;
    const content = text.trim();
    if (!content) return;
    chatHistory.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
    transcript.push({ role, text: content });
  }

  async function handleUserMessage(text, voiceMode) {
    if (!text || isBusy) return;
    if (window.isJarvisVoiceActive?.()) return;
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
      await new Promise((r) => setTimeout(r, voiceMode ? 400 : 600));
      await maybeExtractMemory();
    } catch (err) {
      setError(err.message || "Request failed");
    } finally {
      isBusy = false;
      shell.transitionTo(shell.STATE.STANDBY);
    }
  }

  window.JarvisChat = {
    getHistory: () => chatHistory.slice(),
    pushTurn,
    appendMessage,
    setError,
    getSessionId: () => sessionId,
  };

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
