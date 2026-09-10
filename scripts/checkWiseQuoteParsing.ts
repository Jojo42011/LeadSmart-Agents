/**
 * Regression check for the confirmation-email currency bug.
 *
 * A $100 USD payout to an INR/CAD recipient was emailing "you'll receive
 * 100 INR": Wise had not returned a top-level converted amount, and the quote
 * parser fell back to the USD source amount while keeping the foreign
 * currency code. This exercises both response shapes Wise actually returns
 * plus the email renderer, and fails loudly if the USD figure ever wears a
 * foreign currency again.
 *
 * Run: npx ts-node scripts/checkWiseQuoteParsing.ts
 */
import { parseWiseQuoteRow } from "../lib/wiseClient";
import { renderPaymentConfirmationForTest } from "../lib/paymentEmail";

const REQUEST = {
  sourceAmount: 100,
  targetCurrency: "INR",
  preferredPayIn: "BALANCE",
};

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. The shape that caused the incident: no top-level targetAmount, the real
//    converted figure only inside paymentOptions.
const optionsOnly = parseWiseQuoteRow(
  {
    id: "quote-options-only",
    sourceCurrency: "USD",
    targetCurrency: "INR",
    sourceAmount: 100,
    targetAmount: null,
    rate: 87.42,
    paymentOptions: [
      {
        disabled: true,
        payIn: "BANK_TRANSFER",
        sourceAmount: 100,
        targetAmount: 8_650.5,
        targetCurrency: "INR",
      },
      {
        disabled: false,
        payIn: "BALANCE",
        sourceAmount: 100,
        targetAmount: 8_690.13,
        targetCurrency: "INR",
      },
    ],
  },
  REQUEST
);
console.log("paymentOptions-only quote:");
check(
  "reads the BALANCE option's converted amount",
  optionsOnly.targetAmount === 8_690.13,
  String(optionsOnly.targetAmount)
);
check(
  "never falls back to the USD source amount",
  optionsOnly.targetAmount !== 100
);
check("keeps the target currency", optionsOnly.targetCurrency === "INR");

// 2. The documented shape: converted amount present at the top level.
const topLevel = parseWiseQuoteRow(
  {
    id: "quote-top-level",
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    sourceAmount: 100,
    targetAmount: 136.4,
    rate: 1.364,
  },
  { ...REQUEST, targetCurrency: "CAD" }
);
console.log("top-level quote:");
check("reads the top-level converted amount", topLevel.targetAmount === 136.4);

// 3. Nothing usable anywhere — must report unknown, not the USD amount.
const missing = parseWiseQuoteRow(
  {
    id: "quote-missing",
    sourceCurrency: "USD",
    targetCurrency: "PKR",
    sourceAmount: 100,
    rate: 281.5,
  },
  { ...REQUEST, targetCurrency: "PKR" }
);
console.log("quote with no converted amount:");
check("reports null rather than 100", missing.targetAmount === null);

// 4. A 1:1 cross-currency echo is not a conversion.
const echoed = parseWiseQuoteRow(
  {
    id: "quote-echo",
    sourceCurrency: "USD",
    targetCurrency: "INR",
    sourceAmount: 100,
    targetAmount: 100,
  },
  REQUEST
);
console.log("1:1 cross-currency echo:");
check("discards the echoed amount", echoed.targetAmount === null);

// 5. Plain USD payouts are untouched.
const usd = parseWiseQuoteRow(
  {
    id: "quote-usd",
    sourceCurrency: "USD",
    targetCurrency: "USD",
    sourceAmount: 100,
    targetAmount: 100,
    rate: 1,
  },
  { ...REQUEST, targetCurrency: "USD" }
);
console.log("USD → USD quote:");
check("keeps the USD amount", usd.targetAmount === 100);

// 6. The email itself — the artefact the affiliates actually read.
function emailFor(targetAmount: number | null, targetCurrency: string | null) {
  return renderPaymentConfirmationForTest({
    publisherName: "Test Affiliate",
    email: "affiliate@example.com",
    amount: 100,
    months: ["2026-08"],
    method: "Wise",
    targetAmount,
    targetCurrency,
  });
}

console.log("confirmation email:");
const panicEmail = emailFor(100, "INR");
check(
  "omits the line instead of saying 100 INR for a $100 payout",
  !panicEmail.text.includes("100 INR") && !panicEmail.html.includes("100 INR")
);
check(
  "names the currency without inventing an amount",
  panicEmail.text.includes("You'll receive: INR at Wise's exchange rate"),
  panicEmail.text
);

const unknownEmail = emailFor(null, "INR");
check(
  "states no number when the converted amount is unknown",
  !/You'll receive:.*\d/.test(unknownEmail.text),
  unknownEmail.text
);

const goodEmail = emailFor(8_690.13, "INR");
// Intl separates the code from the number with a non-breaking space.
const goodText = goodEmail.text.replace(/\u00a0/g, " ");
check(
  "shows the real converted amount with a leading ISO code",
  goodText.includes("INR 8,690.13"),
  goodText
);
check(
  "still shows the USD amount sent",
  goodEmail.text.includes("Amount: $100.00")
);

const usdEmail = emailFor(100, "USD");
check("adds no conversion row for USD payouts", !usdEmail.text.includes("You'll receive"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Wise quote / confirmation-email checks passed.");
