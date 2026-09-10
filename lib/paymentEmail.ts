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
  /** Converted amount landing in the recipient's currency (Wise non-USD). */
  targetAmount?: number | null;
  targetCurrency?: string | null;
  /** Estimated arrival: ISO datetime or YYYY-MM-DD. Always labeled estimated. */
  expectedArrival?: string | null;
  /** Last 4 digits of the destination account. */
  accountLast4?: string | null;
  /** Provider reference the affiliate can quote (e.g. "Wise transfer #123"). */
  reference?: string | null;
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

/** "Wednesday, August 12, 2026" from an ISO datetime or a YYYY-MM-DD. */
function formatArrivalDate(value: string): string | null {
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const date = ymdMatch
    ? new Date(Date.UTC(
        parseInt(ymdMatch[1], 10),
        parseInt(ymdMatch[2], 10) - 1,
        parseInt(ymdMatch[3], 10)
      ))
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    // Plain calendar dates are timezone-less; datetimes render in Chicago.
    timeZone: ymdMatch ? "UTC" : CHICAGO_TZ,
  }).format(date);
}

/**
 * "INR 8,290.86" — the ISO code leads so nothing reads as a dollar sign in a
 * currency that isn't dollars. Exotic/unknown codes fall back to a plain
 * number plus the code rather than throwing.
 */
function formatCurrencyAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency}`;
  }
}

function formatTargetAmount(params: PaymentConfirmationParams): string | null {
  const currency = params.targetCurrency?.trim().toUpperCase();
  if (!currency || currency === "USD") {
    return null;
  }
  const amount = params.targetAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  // Last line of defence: a foreign-currency figure identical to the USD
  // amount is an un-converted echo, not a conversion. Say nothing rather than
  // tell an affiliate their $100 payout arrives as "100 INR".
  if (amount === params.amount) {
    return null;
  }
  return `≈ ${formatCurrencyAmount(amount, currency)}`;
}

/** Extra label/value rows, included only when the data is actually known. */
function extraDetailRows(
  params: PaymentConfirmationParams
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const currency = params.targetCurrency?.trim().toUpperCase();
  const converted = formatTargetAmount(params);
  if (converted) {
    rows.push({ label: "You'll receive", value: converted });
  } else if (currency && currency !== "USD") {
    // The payout currency is known but the converted figure is not. Name the
    // currency so the affiliate isn't surprised, without inventing an amount.
    rows.push({
      label: "You'll receive",
      value: `${currency} at Wise's exchange rate on the day of transfer`,
    });
  }
  if (params.expectedArrival) {
    const arrival = formatArrivalDate(params.expectedArrival);
    if (arrival) {
      rows.push({ label: "Expected arrival", value: `${arrival} (estimated)` });
    }
  }
  if (params.accountLast4) {
    rows.push({
      label: "Deposited to",
      value: `Account ending ••${params.accountLast4}`,
    });
  }
  if (params.reference) {
    rows.push({ label: "Reference", value: params.reference });
  }
  return rows;
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
${extraDetailRows(params)
  .map(
    (row) => `                <tr>
                  <td style="padding:0 18px 16px;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">${escapeHtml(row.label)}</strong><br />${escapeHtml(row.value)}
                  </td>
                </tr>`
  )
  .join("\n")}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;font-size:13px;line-height:1.5;color:#71717a;">
              Questions about this payment? Just reply to this email.<br /><br />— LeadSmart
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
    ...extraDetailRows(params).map((row) => `${row.label}: ${row.value}`),
    "",
    "Questions about this payment? Just reply to this email.",
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

/**
 * Render the confirmation bodies without sending — used by
 * scripts/checkWiseQuoteParsing.ts to assert what affiliates actually read.
 */
export function renderPaymentConfirmationForTest(
  params: PaymentConfirmationParams
): { text: string; html: string } {
  return { text: buildTextBody(params), html: buildHtmlBody(params) };
}
