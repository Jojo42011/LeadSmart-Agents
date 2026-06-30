(function () {
  "use strict";

  const sessionId =
    sessionStorage.getItem("jarvis_session_id") || "jarvis-" + Date.now();

  let chatHistory = [];

  function pushTurn(role, text) {
    if (!text) return;
    const content = text.trim();
    if (!content) return;
    chatHistory.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  window.JarvisChat = {
    getHistory: () => chatHistory.slice(),
    pushTurn,
    getSessionId: () => sessionId,
  };
})();
