/** Central Time (America/Chicago) — same zone used by the payment dashboard and scrub agent. */
export const CHICAGO_TZ = "America/Chicago";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ChicagoDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function readPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((part) => part.type === type)?.value ?? "0";
}

/** Current date/time components in America/Chicago. */
export function chicagoDateParts(at: Date = new Date()): ChicagoDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  let hour = parseInt(readPart(parts, "hour"), 10);
  if (hour === 24) {
    hour = 0;
  }

  const weekdayLabel = readPart(parts, "weekday");
  return {
    year: parseInt(readPart(parts, "year"), 10),
    month: parseInt(readPart(parts, "month"), 10),
    day: parseInt(readPart(parts, "day"), 10),
    hour,
    minute: parseInt(readPart(parts, "minute"), 10),
    weekday: WEEKDAY_INDEX[weekdayLabel] ?? 0,
  };
}

export function chicagoYmd(year: number, month: number, day: number): string {
  return (
    String(year) +
    "-" +
    String(month).padStart(2, "0") +
    "-" +
    String(day).padStart(2, "0")
  );
}

/** Today's calendar date in Central Time as YYYY-MM-DD. */
export function chicagoTodayYmd(at: Date = new Date()): string {
  const parts = chicagoDateParts(at);
  return chicagoYmd(parts.year, parts.month, parts.day);
}

function isChicagoWeekend(at: Date): boolean {
  const weekday = chicagoDateParts(at).weekday;
  return weekday === 0 || weekday === 6;
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Next Mon–Fri calendar date in Central Time (starting from `from` or the day after). */
export function chicagoNextBusinessDayYmd(from: Date = new Date()): string {
  let cursor = addDays(from, 1);
  for (let i = 0; i < 14; i++) {
    if (!isChicagoWeekend(cursor)) {
      return chicagoTodayYmd(cursor);
    }
    cursor = addDays(cursor, 1);
  }
  return chicagoTodayYmd(cursor);
}

/** N business days forward from today in Central Time (skip Sat/Sun). */
export function chicagoAddBusinessDaysYmd(
  businessDays: number,
  from: Date = new Date()
): string {
  let cursor = from;
  let remaining = businessDays;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (!isChicagoWeekend(cursor)) {
      remaining -= 1;
    }
  }
  return chicagoTodayYmd(cursor);
}

/**
 * Process date for Bill.com PayBills — Central Time, next business day.
 * Bill.com rejects same-day processDate (BDC_1152), including before the nominal cutoff.
 */
export function chicagoBillcomProcessDateYmd(at: Date = new Date()): string {
  return chicagoNextBusinessDayYmd(at);
}
