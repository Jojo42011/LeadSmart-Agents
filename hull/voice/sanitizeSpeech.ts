/** Strip operator junk before TTS. */
export function sanitizeSpeech(text: string): string {
  let s = String(text || "").trim();
  if (!s) return "";
  s = s.replace(/^```[\s\S]*?```/gm, " ").trim();
  s = s.replace(/^\{[\s\S]*\}$/m, (m) => {
    try {
      const o = JSON.parse(m);
      if (typeof o.speech === "string") return o.speech;
      if (typeof o.reply === "string") return o.reply;
    } catch {
      /* keep */
    }
    return m;
  });
  s = s.replace(/[*_#`]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 4000);
}