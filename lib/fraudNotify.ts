import axios from "axios";
import nodemailer from "nodemailer";
import { getPublisherFraud, setPublisherNotifiedAt } from "./fraudDb";

/**
 * Fraud alerts to Missioner: email (same SMTP config as payment confirmations)
 * and WhatsApp via the Twilio Messages API. Both are optional — unconfigured
 * channels are skipped with a log line, never an error.
 *
 * Env:
 *   FRAUD_ALERT_EMAIL        recipient email
 *   SMTP_HOST/PORT/USER/PASS, PAYMENT_EMAIL_FROM   (already used by payments)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM     e.g. whatsapp:+14155238886
 *   FRAUD_ALERT_WHATSAPP_TO  e.g. whatsapp:+8801521494008
 */

/** Do not re-alert the same publisher more often than this. */
const NOTIFY_THROTTLE_MS = 6 * 60 * 60 * 1000;

export interface FraudAlert {
  publisherName: string;
  reason: string;
  severity: number;
  callerNumber: string | null;
  signals: string[];
  flaggedCalls: number;
  riskScore: number;
}

function emailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.PAYMENT_EMAIL_FROM?.trim() &&
      process.env.FRAUD_ALERT_EMAIL?.trim()
  );
}

function whatsappConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_WHATSAPP_FROM?.trim() &&
      process.env.FRAUD_ALERT_WHATSAPP_TO?.trim()
  );
}

function alertText(alert: FraudAlert): string {
  return [
    `🚨 LeadSmart Fraud Alert`,
    ``,
    `Publisher: ${alert.publisherName}`,
    `Reason: ${alert.reason}`,
    `Severity: ${alert.severity}/100 · Risk score: ${alert.riskScore}/100`,
    alert.callerNumber ? `Caller: ${alert.callerNumber}` : null,
    alert.signals.length ? `Signals: ${alert.signals.join(", ")}` : null,
    `Flagged calls: ${alert.flaggedCalls}`,
    ``,
    `Investigate and block from the fraud dashboard if confirmed.`,
    `Nothing has been blocked automatically.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function sendEmailAlert(alert: FraudAlert): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port: parseInt(process.env.SMTP_PORT?.trim() || "587", 10),
    secure: parseInt(process.env.SMTP_PORT?.trim() || "587", 10) === 465,
    auth: {
      user: process.env.SMTP_USER!.trim(),
      pass: process.env.SMTP_PASS!.trim(),
    },
  });

  await transporter.sendMail({
    from: process.env.PAYMENT_EMAIL_FROM!.trim(),
    to: process.env.FRAUD_ALERT_EMAIL!.trim(),
    subject: `🚨 Fraud alert: ${alert.publisherName} (${alert.reason}, severity ${alert.severity})`,
    text: alertText(alert),
  });
}

async function sendWhatsappAlert(alert: FraudAlert): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const token = process.env.TWILIO_AUTH_TOKEN!.trim();

  const body = new URLSearchParams();
  body.set("From", process.env.TWILIO_WHATSAPP_FROM!.trim());
  body.set("To", process.env.FRAUD_ALERT_WHATSAPP_TO!.trim());
  body.set("Body", alertText(alert));

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    body.toString(),
    {
      auth: { username: sid, password: token },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30_000,
    }
  );
}

/**
 * Send a fraud alert for a publisher on all configured channels, throttled so
 * a noisy publisher does not spam Missioner. Never throws.
 */
export async function notifyFraudAlert(alert: FraudAlert): Promise<void> {
  const existing = getPublisherFraud(alert.publisherName);
  const lastNotified = existing?.notifiedAt
    ? new Date(existing.notifiedAt).getTime()
    : 0;
  if (Date.now() - lastNotified < NOTIFY_THROTTLE_MS) {
    console.log(
      "[Fraud/Notify] Throttled alert for %s (last notified %s)",
      alert.publisherName,
      existing?.notifiedAt
    );
    return;
  }

  let sent = false;

  if (emailConfigured()) {
    try {
      await sendEmailAlert(alert);
      sent = true;
      console.log("[Fraud/Notify] Email alert sent for %s", alert.publisherName);
    } catch (err) {
      console.error(
        "[Fraud/Notify] Email alert failed for %s: %s",
        alert.publisherName,
        err instanceof Error ? err.message : err
      );
    }
  } else {
    console.log("[Fraud/Notify] Email not configured (FRAUD_ALERT_EMAIL + SMTP_*) — skipping");
  }

  if (whatsappConfigured()) {
    try {
      await sendWhatsappAlert(alert);
      sent = true;
      console.log("[Fraud/Notify] WhatsApp alert sent for %s", alert.publisherName);
    } catch (err) {
      console.error(
        "[Fraud/Notify] WhatsApp alert failed for %s: %s",
        alert.publisherName,
        err instanceof Error ? err.message : err
      );
    }
  } else {
    console.log("[Fraud/Notify] WhatsApp not configured (TWILIO_* + FRAUD_ALERT_WHATSAPP_TO) — skipping");
  }

  if (sent) {
    setPublisherNotifiedAt(alert.publisherName, new Date().toISOString());
  }
}
