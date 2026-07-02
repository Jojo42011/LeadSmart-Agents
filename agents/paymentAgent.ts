import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { parse } from "csv-parse/sync";

const BASE_URL = "https://api.ringba.com/v2";
const POLYARES_BASE_URL = "https://affiliates.polyares.com";
const POLYARES_LOGIN_URL = `${POLYARES_BASE_URL}/login`;
const POLYARES_USERNAME = "matthew@leadsmartinc.com";
const POLYARES_PASSWORD = "matthew@leadsmartinc.com";
const POLYARES_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const POLYARES_HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type PaymentSource = "RINGBA" | "POLYERAS";
export type MergedPaymentSource = PaymentSource | "BOTH";

export interface PublisherPayoutRow {
  publisherName: string;
  payoutAmount: number;
  source: PaymentSource;
  callCount?: number;
  convertedCalls?: number;
  completedCalls?: number;
}

export interface PublisherProfitRow {
  publisherName: string;
  payoutAmount: number;
  telcoCost: number;
  callCount: number;
  netProfit: number;
}

export interface MergedPublisherRow {
  publisherName: string;
  ringbaAmount: number;
  polyaresAmount: number;
  totalAmount: number;
  source: MergedPaymentSource;
  callCount?: number;
  convertedCalls?: number;
  completedCalls?: number;
}

export interface PaymentOutlier {
  polyaresName: string;
  polyaresAmount: number;
  similarRingbaName: string;
  ringbaAmount: number;
}

export interface MergeAffiliatesResult {
  publishers: MergedPublisherRow[];
  outliers: PaymentOutlier[];
}

function normalizePublisherName(name: string): string {
  return name.trim().toLowerCase();
}

const FORCE_BOTH_MERGE: Record<string, string> = {
  "dominik mikula": "DOMINIK MIKULA AND COMPANY LTD",
  "muhammad bilal2": "Muhammad Bilal2 LSW - N",
};

function isRingbaSuffixTagMatch(polyName: string, ringbaName: string): boolean {
  const poly = normalizePublisherName(polyName);
  const ringba = normalizePublisherName(ringbaName);
  if (poly === ringba) {
    return false;
  }
  if (!ringba.startsWith(poly)) {
    return false;
  }
  return ringba.slice(poly.length).startsWith(" -");
}

function isSimilarNameMatch(polyName: string, ringbaName: string): boolean {
  const poly = normalizePublisherName(polyName);
  const ringba = normalizePublisherName(ringbaName);
  if (poly === ringba) {
    return false;
  }
  if (isRingbaSuffixTagMatch(polyName, ringbaName)) {
    return false;
  }
  if (!ringba.startsWith(poly)) {
    return false;
  }
  const nextChar = ringba[poly.length];
  return nextChar === undefined || /[\s\-–—|/,(]/.test(nextChar);
}

function findSuffixTagRingbaMatch(
  polyName: string,
  ringbaRows: PublisherPayoutRow[]
): PublisherPayoutRow | null {
  const matches = ringbaRows.filter((row) =>
    isRingbaSuffixTagMatch(polyName, row.publisherName)
  );

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.payoutAmount - a.payoutAmount);
  return matches[0];
}

function findPartialRingbaMatch(
  polyName: string,
  ringbaRows: PublisherPayoutRow[]
): PublisherPayoutRow | null {
  const polyNorm = normalizePublisherName(polyName);
  const matches = ringbaRows.filter((row) =>
    isSimilarNameMatch(polyName, row.publisherName)
  );

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => {
    const aContains = normalizePublisherName(a.publisherName).includes(polyNorm)
      ? 1
      : 0;
    const bContains = normalizePublisherName(b.publisherName).includes(polyNorm)
      ? 1
      : 0;
    if (bContains !== aContains) {
      return bContains - aContains;
    }
    return b.payoutAmount - a.payoutAmount;
  });

  return matches[0];
}

/**
 * Merges Ringba and Polyares payout rows by exact name or Ringba suffix-tag name.
 * Ambiguous partial matches are flagged in outliers for manual review.
 */
export function mergeAffiliates(
  ringbaRows: PublisherPayoutRow[],
  polyaresRows: PublisherPayoutRow[]
): MergeAffiliatesResult {
  const ringbaByKey = new Map<string, PublisherPayoutRow>();
  for (const row of ringbaRows) {
    ringbaByKey.set(normalizePublisherName(row.publisherName), row);
  }

  const publishers: MergedPublisherRow[] = ringbaRows.map((row) => ({
    publisherName: row.publisherName,
    ringbaAmount: row.payoutAmount,
    polyaresAmount: 0,
    totalAmount: row.payoutAmount,
    source: "RINGBA",
    callCount: row.callCount,
    convertedCalls: row.convertedCalls,
    completedCalls: row.completedCalls,
  }));

  const publisherIndexByKey = new Map<string, number>();
  for (let i = 0; i < publishers.length; i++) {
    publisherIndexByKey.set(normalizePublisherName(publishers[i].publisherName), i);
  }

  const outliers: PaymentOutlier[] = [];

  for (const polyRow of polyaresRows) {
    const key = normalizePublisherName(polyRow.publisherName);
    const ringbaRow = ringbaByKey.get(key);
    const existingIndex = publisherIndexByKey.get(key);

    if (ringbaRow && existingIndex !== undefined) {
      const existing = publishers[existingIndex];
      publishers[existingIndex] = {
        publisherName: ringbaRow.publisherName,
        ringbaAmount: existing.ringbaAmount,
        polyaresAmount: polyRow.payoutAmount,
        totalAmount: existing.ringbaAmount + polyRow.payoutAmount,
        source: "BOTH",
        callCount: ringbaRow.callCount,
        convertedCalls: ringbaRow.convertedCalls,
        completedCalls: ringbaRow.completedCalls,
      };
      continue;
    }

    const forcedRingbaName = FORCE_BOTH_MERGE[key];
    if (forcedRingbaName) {
      const forcedRingba = ringbaByKey.get(normalizePublisherName(forcedRingbaName));
      const forcedIndex = publisherIndexByKey.get(normalizePublisherName(forcedRingbaName));
      if (forcedRingba && forcedIndex !== undefined) {
        const existing = publishers[forcedIndex];
        publishers[forcedIndex] = {
          publisherName: forcedRingba.publisherName,
          ringbaAmount: existing.ringbaAmount,
          polyaresAmount: existing.polyaresAmount + polyRow.payoutAmount,
          totalAmount: existing.ringbaAmount + existing.polyaresAmount + polyRow.payoutAmount,
          source: "BOTH",
          callCount: forcedRingba.callCount,
          convertedCalls: forcedRingba.convertedCalls,
          completedCalls: forcedRingba.completedCalls,
        };
        continue;
      }
    }

    const suffixTagRingba = findSuffixTagRingbaMatch(
      polyRow.publisherName,
      ringbaRows
    );
    if (suffixTagRingba) {
      const suffixKey = normalizePublisherName(suffixTagRingba.publisherName);
      const suffixIndex = publisherIndexByKey.get(suffixKey);
      if (suffixIndex !== undefined) {
        const existing = publishers[suffixIndex];
        publishers[suffixIndex] = {
          publisherName: suffixTagRingba.publisherName,
          ringbaAmount: existing.ringbaAmount,
          polyaresAmount: existing.polyaresAmount + polyRow.payoutAmount,
          totalAmount: existing.ringbaAmount + existing.polyaresAmount + polyRow.payoutAmount,
          source: "BOTH",
          callCount: suffixTagRingba.callCount,
          convertedCalls: suffixTagRingba.convertedCalls,
          completedCalls: suffixTagRingba.completedCalls,
        };
        continue;
      }
    }

    publishers.push({
      publisherName: polyRow.publisherName,
      ringbaAmount: 0,
      polyaresAmount: polyRow.payoutAmount,
      totalAmount: polyRow.payoutAmount,
      source: "POLYERAS",
    });

    const similarRingba = findPartialRingbaMatch(
      polyRow.publisherName,
      ringbaRows
    );
    if (similarRingba) {
      outliers.push({
        polyaresName: polyRow.publisherName,
        polyaresAmount: polyRow.payoutAmount,
        similarRingbaName: similarRingba.publisherName,
        ringbaAmount: similarRingba.payoutAmount,
      });
    }
  }

  publishers.sort((a, b) => b.totalAmount - a.totalAmount);

  return { publishers, outliers };
}

function getAccountId(): string {
  const accountId = process.env.RINGBA_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("RINGBA_ACCOUNT_ID is not set");
  }
  return accountId;
}

function getApiToken(): string {
  const token = process.env.RINGBA_API_TOKEN;
  if (!token) {
    throw new Error("RINGBA_API_TOKEN is not set");
  }
  return token;
}

function createClient(): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Token ${getApiToken()}`,
      "Content-Type": "application/json",
    },
    timeout: 120_000,
  });
}

function isoToMdY(isoDate: string): string {
  const d = new Date(isoDate);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${month}/${day}/${year}`;
}

function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isNaN(num) ? 0 : num;
}

function rowFromColumns(
  columns: Array<{ column?: string; name?: string; value?: unknown }>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    const key = col.column ?? col.name;
    if (key) {
      row[key] = col.value;
    }
  }
  return row;
}

function extractRawRows(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const root = data as Record<string, unknown>;
  const report = root.report as Record<string, unknown> | undefined;

  const candidates: unknown[] = [];

  if (report) {
    candidates.push(report.records, report.rows, report.data);
    const table = report.table as Record<string, unknown> | undefined;
    if (table) {
      candidates.push(table.rows, table.records, table.data);
    }
  }

  candidates.push(root.records, root.rows, root.data);

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const rows: Record<string, unknown>[] = [];
    for (const item of candidate) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.columns)) {
        rows.push(
          rowFromColumns(
            record.columns as Array<{
              column?: string;
              name?: string;
              value?: unknown;
            }>
          )
        );
      } else {
        rows.push(record);
      }
    }

    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

function normalizePublisherRow(
  raw: Record<string, unknown>
): PublisherPayoutRow | null {
  const publisherName = String(
    raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
  ).trim();

  if (!publisherName) {
    return null;
  }

  return {
    publisherName,
    payoutAmount: parseNumber(raw.payoutAmount),
    source: "RINGBA",
    callCount: parseNumber(raw.callCount),
    convertedCalls: parseNumber(raw.convertedCalls),
    completedCalls: parseNumber(raw.completedCalls),
  };
}

/**
 * Pulls affiliate payout aggregates from Ringba insights for a date range.
 */
export async function fetchPublisherPayouts(
  startDate: string,
  endDate: string
): Promise<PublisherPayoutRow[]> {
  const client = createClient();
  const accountId = getAccountId();

  const body = {
    reportStart: startDate,
    reportEnd: endDate,
    groupByColumns: [{ column: "publisherName", displayName: "Publisher" }],
    valueColumns: [
      { column: "callCount", aggregateFunction: null },
      { column: "completedCalls", aggregateFunction: null },
      { column: "convertedCalls", aggregateFunction: null },
      { column: "payoutAmount", aggregateFunction: null },
    ],
    orderByColumns: [{ column: "payoutAmount", direction: "desc" }],
    formatTimespans: true,
    formatPercentages: true,
    generateRollups: true,
    maxResultsPerGroup: 1000,
    filters: [],
    formatTimeZone: "America/Chicago",
  };

  let response;
  try {
    response = await client.post<unknown>(`/${accountId}/insights`, body);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "[PaymentAgent] Ringba insights error response:",
        JSON.stringify(error.response?.data, null, 2)
      );
    }
    throw error;
  }

  const rows = extractRawRows(response.data)
    .map(normalizePublisherRow)
    .filter((row): row is PublisherPayoutRow => row !== null);

  rows.sort((a, b) => b.payoutAmount - a.payoutAmount);

  return rows;
}

function normalizeProfitRow(
  raw: Record<string, unknown>
): PublisherProfitRow | null {
  const publisherName = String(
    raw.publisherName ?? raw.PublisherName ?? raw.publisher ?? ""
  ).trim();

  if (!publisherName) {
    return null;
  }

  const payoutAmount = parseNumber(raw.payoutAmount);
  const telcoCost = parseNumber(raw.telcoCost);
  const callCount = parseNumber(raw.callCount);

  if (payoutAmount === 0 && telcoCost === 0) {
    return null;
  }

  return {
    publisherName,
    payoutAmount,
    telcoCost,
    callCount,
    netProfit: payoutAmount - telcoCost,
  };
}

/**
 * Pulls per-publisher payout, telco cost, and net profit from Ringba insights.
 */
export async function fetchPublisherProfitData(
  startDate: string,
  endDate: string
): Promise<PublisherProfitRow[]> {
  const client = createClient();
  const accountId = getAccountId();

  const body = {
    reportStart: startDate,
    reportEnd: endDate,
    groupByColumns: [{ column: "publisherName" }],
    valueColumns: [
      { column: "payoutAmount", aggregateFunction: null },
      { column: "telcoCost", aggregateFunction: null },
      { column: "callCount", aggregateFunction: null },
    ],
    orderByColumns: [{ column: "telcoCost", direction: "desc" }],
    formatTimespans: true,
    formatPercentages: true,
    generateRollups: true,
    maxResultsPerGroup: 1000,
    filters: [],
    formatTimeZone: "America/Chicago",
  };

  let response;
  try {
    response = await client.post<unknown>(`/${accountId}/insights`, body);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "[PaymentAgent] Ringba profit insights error response:",
        JSON.stringify(error.response?.data, null, 2)
      );
    }
    throw error;
  }

  const rows = extractRawRows(response.data)
    .map(normalizeProfitRow)
    .filter((row): row is PublisherProfitRow => row !== null);

  rows.sort((a, b) => b.telcoCost - a.telcoCost);

  return rows;
}

const RENTAL_COST_PER_NUMBER = 1;

function findNumbersCsvPublisherColumn(columns: string[]): string | null {
  for (const column of columns) {
    const normalized = column.trim().toLowerCase().replace(/\s+/g, " ");
    if (
      normalized === "publisher name" ||
      normalized === "publishername" ||
      normalized === "publisher"
    ) {
      return column;
    }
  }
  return null;
}

/**
 * Parses a Ringba numbers CSV and counts rows per publisher.
 * Keys are normalized publisher names.
 */
export function parseNumbersCSV(csvText: string): Record<string, number> {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    return {};
  }

  const publisherColumn = findNumbersCsvPublisherColumn(
    Object.keys(records[0] ?? {})
  );
  if (!publisherColumn) {
    throw new Error('CSV must include a "Publisher Name" column');
  }

  const counts: Record<string, number> = {};
  for (const record of records) {
    const publisherName = String(record[publisherColumn] ?? "").trim();
    if (!publisherName) {
      continue;
    }
    const key = normalizePublisherName(publisherName);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

export function rentalCostsFromNumberCounts(
  counts: Record<string, number>
): Record<string, number> {
  const rentalCosts: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    rentalCosts[key] = count * RENTAL_COST_PER_NUMBER;
  }
  return rentalCosts;
}

function createPolyaresClient(jar: CookieJar) {
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 120_000,
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
      },
    })
  );
}

function logPolyaresStep(step: string, details: Record<string, unknown>): void {
  console.log(
    `[PaymentAgent] Polyares ${step}:`,
    JSON.stringify(details, null, 2)
  );
}

interface LoginFormInput {
  name: string;
  type: string;
  value: string;
}

interface ParsedLoginForm {
  actionUrl: string;
  formActionRaw: string | null;
  inputs: LoginFormInput[];
  hiddenFields: Record<string, string>;
  usesYii2LoginForm: boolean;
}

function resolvePolyaresUrl(action: string | null | undefined): string {
  if (!action || action === "") {
    return POLYARES_LOGIN_URL;
  }
  if (action.startsWith("http://") || action.startsWith("https://")) {
    return action;
  }
  if (action.startsWith("/")) {
    return `${POLYARES_BASE_URL}${action}`;
  }
  return `${POLYARES_BASE_URL}/${action}`;
}

function parseInputTag(tag: string): LoginFormInput | null {
  const nameMatch = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
  if (!nameMatch) {
    return null;
  }

  const typeMatch = tag.match(/\btype\s*=\s*["']([^"']+)["']/i);
  const valueMatch = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);

  return {
    name: nameMatch[1],
    type: typeMatch ? typeMatch[1].toLowerCase() : "text",
    value: valueMatch ? valueMatch[1] : "",
  };
}

function parseLoginForm(html: string): ParsedLoginForm {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? [];

  for (const form of forms) {
    if (!/<input\b[^>]*type\s*=\s*["']password["']/i.test(form)) {
      continue;
    }

    const actionMatch = form.match(
      /<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/i
    );
    const formActionRaw = actionMatch ? actionMatch[1] : "";
    const actionUrl = resolvePolyaresUrl(formActionRaw);

    const inputs: LoginFormInput[] = [];
    const hiddenFields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = inputRe.exec(form)) !== null) {
      const parsed = parseInputTag(match[0]);
      if (!parsed) {
        continue;
      }

      inputs.push(parsed);
      if (parsed.type === "hidden") {
        hiddenFields[parsed.name] = parsed.value;
      }
    }

    const usesYii2LoginForm = inputs.some(
      (input) =>
        input.name === "LoginForm[email]" ||
        input.name === "LoginForm[password]"
    );

    return {
      actionUrl,
      formActionRaw: formActionRaw || null,
      inputs,
      hiddenFields,
      usesYii2LoginForm,
    };
  }

  return {
    actionUrl: POLYARES_LOGIN_URL,
    formActionRaw: null,
    inputs: [],
    hiddenFields: extractHiddenFieldsFromHtml(html),
    usesYii2LoginForm: html.includes("LoginForm[email]"),
  };
}

function extractHiddenFieldsFromHtml(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = inputRe.exec(html)) !== null) {
    const parsed = parseInputTag(match[0]);
    if (!parsed || parsed.type !== "hidden") {
      continue;
    }
    fields[parsed.name] = parsed.value;
  }

  return fields;
}

function buildPolyaresLoginBody(parsedForm: ParsedLoginForm): URLSearchParams {
  const loginBody = new URLSearchParams();

  for (const [name, value] of Object.entries(parsedForm.hiddenFields)) {
    loginBody.set(name, value);
  }

  if (parsedForm.usesYii2LoginForm) {
    loginBody.set("LoginForm[email]", POLYARES_USERNAME);
    loginBody.set("LoginForm[password]", POLYARES_PASSWORD);
    return loginBody;
  }

  const usernameField = parsedForm.inputs.find(
    (input) =>
      input.type === "text" ||
      input.type === "email" ||
      input.name.toLowerCase().includes("user") ||
      input.name.toLowerCase().includes("email")
  );
  const passwordField = parsedForm.inputs.find(
    (input) => input.type === "password"
  );

  loginBody.set(usernameField?.name ?? "username", POLYARES_USERNAME);
  loginBody.set(passwordField?.name ?? "password", POLYARES_PASSWORD);

  return loginBody;
}

function extractCsrfFields(
  hiddenFields: Record<string, string>
): Record<string, string> {
  const csrfNames = [
    "_csrf",
    "csrf_token",
    "csrf",
    "csrfToken",
    "authenticity_token",
    "csrfmiddlewaretoken",
  ];
  const csrfFields: Record<string, string> = {};

  for (const [name, value] of Object.entries(hiddenFields)) {
    const lower = name.toLowerCase();
    if (
      csrfNames.some(
        (tokenName) =>
          lower === tokenName.toLowerCase() || lower.includes("csrf")
      )
    ) {
      csrfFields[name] = value;
    }
  }

  return csrfFields;
}

function polyaresLoginHeaders(): Record<string, string> {
  return {
    "User-Agent": POLYARES_USER_AGENT,
    Accept: POLYARES_HTML_ACCEPT,
    Referer: POLYARES_LOGIN_URL,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function formatAxiosErrorBody(data: unknown): string {
  if (typeof data === "string") {
    return data.slice(0, 2000);
  }
  return JSON.stringify(data, null, 2);
}

function parsePolyaresCommission(value: unknown): number {
  const cleaned = String(value ?? "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  return parseNumber(cleaned);
}

/**
 * Logs into Polyares affiliates portal and downloads income-by-period CSV.
 */
export async function fetchPolyaresPayouts(
  startDate: string,
  endDate: string
): Promise<PublisherPayoutRow[]> {
  const jar = new CookieJar();
  const client = createPolyaresClient(jar);

  logPolyaresStep("step 1 — GET login page", {
    url: POLYARES_LOGIN_URL,
    method: "GET",
    headers: {
      "User-Agent": POLYARES_USER_AGENT,
      Accept: POLYARES_HTML_ACCEPT,
    },
  });

  let loginPageHtml: string;
  try {
    const loginPageResponse = await client.get<string>(POLYARES_LOGIN_URL, {
      responseType: "text",
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
        Accept: POLYARES_HTML_ACCEPT,
      },
      maxRedirects: 5,
    });

    loginPageHtml =
      typeof loginPageResponse.data === "string"
        ? loginPageResponse.data
        : String(loginPageResponse.data ?? "");

    logPolyaresStep("step 1 — GET login page response", {
      status: loginPageResponse.status,
      statusText: loginPageResponse.statusText,
      contentType: loginPageResponse.headers["content-type"] ?? null,
      htmlLength: loginPageHtml.length,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 1 — GET login page failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const parsedForm = parseLoginForm(loginPageHtml);
  const csrfFields = extractCsrfFields(parsedForm.hiddenFields);

  logPolyaresStep("step 2 — parsed login form hidden fields", {
    hiddenFieldNames: Object.keys(parsedForm.hiddenFields),
    csrfFields: Object.keys(csrfFields),
    csrfValuesPresent: Object.fromEntries(
      Object.entries(csrfFields).map(([key, value]) => [
        key,
        value ? "[present]" : "[empty]",
      ])
    ),
  });

  logPolyaresStep("step 2b — login form fields and action", {
    formActionRaw: parsedForm.formActionRaw,
    formActionUrl: parsedForm.actionUrl,
    usesYii2LoginForm: parsedForm.usesYii2LoginForm,
    allInputs: parsedForm.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      value: input.type === "password" ? "[masked]" : input.value,
    })),
  });

  const loginBody = buildPolyaresLoginBody(parsedForm);
  const loginPostUrl = parsedForm.actionUrl;
  const loginBodyString = loginBody.toString();
  const loginHeaders = polyaresLoginHeaders();

  logPolyaresStep("step 3 — POST login request", {
    url: loginPostUrl,
    method: "POST",
    headers: loginHeaders,
    body: loginBodyString,
    usesYii2LoginForm: parsedForm.usesYii2LoginForm,
  });

  try {
    const loginResponse = await client.post(
      loginPostUrl,
      loginBodyString,
      {
        headers: loginHeaders,
        maxRedirects: 5,
        responseType: "text",
        validateStatus: (status) => status >= 200 && status < 400,
      }
    );

    logPolyaresStep("step 3 — POST login response", {
      status: loginResponse.status,
      statusText: loginResponse.statusText,
      finalUrl: loginResponse.request?.res?.responseUrl ?? loginPostUrl,
      contentType: loginResponse.headers["content-type"] ?? null,
      bodyPreview:
        typeof loginResponse.data === "string"
          ? loginResponse.data.slice(0, 500)
          : null,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 3 — POST login failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        headers: error.response?.headers ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const dateStart = isoToMdY(startDate);
  const dateEnd = isoToMdY(endDate);
  const exportUrl = `${POLYARES_BASE_URL}/reports/income-by-period/export?date_start=${encodeURIComponent(dateStart)}&date_end=${encodeURIComponent(dateEnd)}`;

  logPolyaresStep("step 4 — GET CSV export", {
    url: exportUrl,
    method: "GET",
    dateStart,
    dateEnd,
  });

  let csvResponse;
  try {
    csvResponse = await client.get<string>(exportUrl, {
      responseType: "text",
      headers: {
        "User-Agent": POLYARES_USER_AGENT,
        Accept: "text/csv,text/plain,*/*",
        Referer: POLYARES_BASE_URL,
      },
    });

    logPolyaresStep("step 4 — GET CSV export response", {
      status: csvResponse.status,
      contentType: csvResponse.headers["content-type"] ?? null,
      bytes:
        typeof csvResponse.data === "string" ? csvResponse.data.length : 0,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logPolyaresStep("step 4 — GET CSV export failed", {
        status: error.response?.status ?? null,
        statusText: error.response?.statusText ?? null,
        body: formatAxiosErrorBody(error.response?.data),
      });
    }
    throw error;
  }

  const csvText =
    typeof csvResponse.data === "string"
      ? csvResponse.data
      : String(csvResponse.data ?? "");

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const rows: PublisherPayoutRow[] = [];

  for (const record of records) {
    const affiliate = String(record.Affiliate ?? "").trim();
    const commission = parsePolyaresCommission(record.Commission);

    if (!affiliate || commission === 0) {
      continue;
    }

    rows.push({
      publisherName: affiliate,
      payoutAmount: commission,
      source: "POLYERAS",
    });
  }

  rows.sort((a, b) => b.payoutAmount - a.payoutAmount);

  console.log(
    `[PaymentAgent] Polyares CSV parsed: ${rows.length} affiliates (${dateStart} – ${dateEnd})`
  );

  return rows;
}

/** Allowed payment method tags for affiliate metadata (payment portal). */
export const PAYMENT_METHODS = [
  "PayPal",
  "Wise",
  "Venmo",
  "Bill.com",
  "Crypto",
  "Untagged",
] as const;

/** Allowed payment terms tags for affiliate metadata (payment portal). */
export const PAYMENT_TERMS = [
  "Weekly",
  "Biweekly",
  "Monthly",
  "Untagged",
] as const;

export type PaymentMethodTag = (typeof PAYMENT_METHODS)[number];
export type PaymentTermsTag = (typeof PAYMENT_TERMS)[number];

export interface AffiliateMetadata {
  paymentMethod: string | null;
  paymentTerms: string | null;
  isPaid: boolean;
  paidAt: string | null;
  updatedAt: string | null;
}

export type AffiliateMetadataMap = Record<string, AffiliateMetadata>;

/** Resolve merged total payout for one publisher in a date range. */
export async function resolvePublisherPayoutAmount(
  publisherName: string,
  startDate: string,
  endDate: string
): Promise<number> {
  const [ringbaPublishers, polyaresPublishers] = await Promise.all([
    fetchPublisherPayouts(startDate, endDate),
    fetchPolyaresPayouts(startDate, endDate),
  ]);
  const { publishers } = mergeAffiliates(ringbaPublishers, polyaresPublishers);
  const target = normalizePublisherName(publisherName);
  const row = publishers.find(
    (publisher) => normalizePublisherName(publisher.publisherName) === target
  );
  if (!row) {
    throw new Error(`Publisher not found: ${publisherName}`);
  }
  if (row.totalAmount <= 0) {
    throw new Error(`No payout amount for ${publisherName}`);
  }
  return row.totalAmount;
}

/** Sum merged payout totals for one publisher across multiple date ranges. */
export async function sumPublisherPayoutAcrossMonths(
  publisherName: string,
  ranges: Array<{ startDate: string; endDate: string }>
): Promise<number> {
  let total = 0;

  for (const range of ranges) {
    try {
      total += await resolvePublisherPayoutAmount(
        publisherName,
        range.startDate,
        range.endDate
      );
    } catch (err) {
      if (err instanceof Error) {
        const message = err.message;
        if (
          message.includes("Publisher not found") ||
          message.includes("No payout amount")
        ) {
          continue;
        }
      }
      throw err;
    }
  }

  if (total <= 0) {
    throw new Error(
      `No payout amount for ${publisherName} across selected months`
    );
  }

  return total;
}

export interface PayableRecipientMatch {
  id: number;
  accountHolderName: string;
  currency: string;
  country: string;
  email?: string | null;
}

/** Match a Wise recipient to a publisher by holder name or email. */
export function matchWiseRecipientByName(
  recipients: PayableRecipientMatch[],
  publisherName: string
): PayableRecipientMatch | null {
  const target = normalizePublisherName(publisherName);

  for (const recipient of recipients) {
    if (normalizePublisherName(recipient.accountHolderName) === target) {
      return recipient;
    }
  }

  for (const recipient of recipients) {
    const holder = normalizePublisherName(recipient.accountHolderName);
    if (holder.includes(target) || target.includes(holder)) {
      return recipient;
    }
  }

  if (target.includes("@")) {
    for (const recipient of recipients) {
      const email = recipient.email?.trim().toLowerCase();
      if (email && email === target) {
        return recipient;
      }
    }
  }

  return null;
}

export interface PayableVendorMatch {
  id: string;
  name: string;
  email?: string | null;
}

/** Match a Bill.com vendor to a publisher by name. */
export function matchBillcomVendorByName(
  vendors: PayableVendorMatch[],
  publisherName: string
): PayableVendorMatch | null {
  const target = normalizePublisherName(publisherName);

  for (const vendor of vendors) {
    if (normalizePublisherName(vendor.name) === target) {
      return vendor;
    }
  }

  for (const vendor of vendors) {
    const name = normalizePublisherName(vendor.name);
    if (name.includes(target) || target.includes(name)) {
      return vendor;
    }
  }

  return null;
}
