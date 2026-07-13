import nodemailer from "nodemailer";
import { CHICAGO_TZ } from "./chicagoTime";

export interface PaymentConfirmationParams {
  publisherName: string;
  email: string;
  amount: number;
  /** Period keys: YYYY-MM months, or Monday YYYY-MM-DD weeks when periodType === "week". */
  months: string[];
  periodType?: "month" | "week";
  method: "Wise" | "Bill.com";
}

function smtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.PAYMENT_EMAIL_FROM?.trim()
  );
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey.trim());
  if (!match) {
    return monthKey;
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const date = new Date(Date.UTC(year, month, 1));
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatMonthsLabel(months: string[]): string {
  const sorted = [...months].sort();
  if (sorted.length === 0) {
    return "Payment period";
  }
  if (sorted.length === 1) {
    return formatMonthLabel(sorted[0]);
  }
  return sorted.map(formatMonthLabel).join(", ");
}

/** Format a Monday YYYY-MM-DD week key as "Mon D – Sun D, YYYY". */
function formatWeekLabel(weekKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekKey.trim());
  if (!match) {
    return weekKey;
  }
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const monday = new Date(Date.UTC(y, m, d));
  const sunday = new Date(Date.UTC(y, m, d + 6));
  const fmt = (dt: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(dt);
  return `${fmt(monday)} – ${fmt(sunday)}, ${sunday.getUTCFullYear()}`;
}

function formatPeriodsLabel(params: PaymentConfirmationParams): string {
  if (params.periodType === "week") {
    const sorted = [...params.months].sort();
    if (sorted.length === 0) {
      return "Payment period";
    }
    return sorted.map(formatWeekLabel).join(", ");
  }
  return formatMonthsLabel(params.months);
}

function formatDateChicago(): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: CHICAGO_TZ,
  }).format(new Date());
}

function buildHtmlBody(params: PaymentConfirmationParams): string {
  const monthLabel = formatPeriodsLabel(params);
  const amountLabel = formatMoney(params.amount);
  const dateLabel = formatDateChicago();
  const displayName = params.publisherName;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LeadSmart Payment Confirmation</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 8px;">
              <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;">LeadSmart</p>
              <h1 style="margin:0;font-size:22px;line-height:1.3;color:#18181b;">Payment Confirmation</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">
                Hi ${escapeHtml(displayName)},
              </p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3f3f46;">
                Your affiliate payment has been processed successfully.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;">
                <tr>
                  <td style="padding:16px 18px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">Publisher</strong><br />${escapeHtml(params.publisherName)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 18px 16px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">Amount</strong><br />${escapeHtml(amountLabel)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 18px 16px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">Period</strong><br />${escapeHtml(monthLabel)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 18px 16px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">Payment method</strong><br />${escapeHtml(params.method)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 18px 16px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">Date</strong><br />${escapeHtml(dateLabel)} CT
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;font-size:13px;line-height:1.5;color:#71717a;">
              — LeadSmart
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildTextBody(params: PaymentConfirmationParams): string {
  const monthLabel = formatPeriodsLabel(params);
  const amountLabel = formatMoney(params.amount);
  const dateLabel = formatDateChicago();

  return [
    `Hi ${params.publisherName},`,
    "",
    "Your affiliate payment has been processed successfully.",
    "",
    `Publisher: ${params.publisherName}`,
    `Amount: ${amountLabel}`,
    `Period: ${monthLabel}`,
    `Payment method: ${params.method}`,
    `Date: ${dateLabel} CT`,
    "",
    "— LeadSmart",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Send payment confirmation email via Gmail SMTP. Throws on transport failure. */
export async function sendPaymentConfirmationEmail(
  params: PaymentConfirmationParams
): Promise<void> {
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS, PAYMENT_EMAIL_FROM)");
  }

  const host = process.env.SMTP_HOST!.trim();
  const port = parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
  const user = process.env.SMTP_USER!.trim();
  const pass = process.env.SMTP_PASS!.trim();
  const from = process.env.PAYMENT_EMAIL_FROM!.trim();
  const monthLabel = formatPeriodsLabel(params);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to: params.email,
    subject: `LeadSmart Payment Confirmation — ${monthLabel}`,
    text: buildTextBody(params),
    html: buildHtmlBody(params),
  });
}
