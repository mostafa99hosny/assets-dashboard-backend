import dotenv from "dotenv";

dotenv.config();

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const NODE_ENVS = new Set(["development", "test", "production"]);

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePositiveInteger(
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }

  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`${name} must be either true or false.`);
}

function parseCorsOrigins(raw: string): readonly string[] {
  const values = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one exact origin.");
  }

  const uniqueOrigins = new Set<string>();

  for (const value of values) {
    if (value === "*") {
      throw new Error("CORS_ORIGINS must not use '*'. Use exact frontend origins.");
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid URL: ${value}`);
    }

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        `CORS_ORIGINS entries must be bare http(s) origins without paths: ${value}`,
      );
    }

    uniqueOrigins.add(parsed.origin);
  }

  return Object.freeze([...uniqueOrigins]);
}

const nodeEnv = process.env.NODE_ENV?.trim() || "development";
if (!NODE_ENVS.has(nodeEnv)) {
  throw new Error("NODE_ENV must be development, test, or production.");
}

const mongoUrl = required("MONGO_URL_SCRAPPING");
if (!/^mongodb(\+srv)?:\/\//i.test(mongoUrl)) {
  throw new Error("MONGO_URL_SCRAPPING must start with mongodb:// or mongodb+srv://.");
}

const defaultCompanyId = required("DEFAULT_COMPANY_ID");
if (!OBJECT_ID_PATTERN.test(defaultCompanyId)) {
  throw new Error("DEFAULT_COMPANY_ID must be a 24-character MongoDB ObjectId.");
}

const maxPageSize = parsePositiveInteger("MAX_PAGE_SIZE", 100, 500);
const defaultPageSize = parsePositiveInteger(
  "DEFAULT_PAGE_SIZE",
  25,
  maxPageSize,
);
const realtimeRetryInitialMs = parsePositiveInteger(
  "REALTIME_RETRY_INITIAL_MS",
  1000,
  60000,
);
const realtimeRetryMaxMs = parsePositiveInteger(
  "REALTIME_RETRY_MAX_MS",
  30000,
  300000,
);

if (realtimeRetryMaxMs < realtimeRetryInitialMs) {
  throw new Error("REALTIME_RETRY_MAX_MS must be greater than or equal to REALTIME_RETRY_INITIAL_MS.");
}

export const env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === "production",
  port: parsePositiveInteger("PORT", 4000, 65535),
  trustProxy: parseBoolean("TRUST_PROXY", false),
  mongoUrl,
  mongoDbName: required("MONGO_DBNAME_SCRAPPING"),
  mongoMaxPoolSize: parsePositiveInteger("MONGO_MAX_POOL_SIZE", 10, 100),
  mongoQueryTimeoutMs: parsePositiveInteger("MONGO_QUERY_TIMEOUT_MS", 10000, 60000),
  realtimeRetryInitialMs,
  realtimeRetryMaxMs,
  defaultCompanyId,
  corsOrigins: parseCorsOrigins(
    process.env.CORS_ORIGINS?.trim() ||
      (nodeEnv === "production" ? required("CORS_ORIGINS") : "http://localhost:3000"),
  ),
  corsAllowNoOrigin: parseBoolean("CORS_ALLOW_NO_ORIGIN", true),
  defaultPageSize,
  maxPageSize,
  maxPage: parsePositiveInteger("MAX_PAGE", 10000, 100000),
  exportMaxRows: parsePositiveInteger("EXPORT_MAX_ROWS", 10000, 100000),
  filterOptionsLimit: parsePositiveInteger("FILTER_OPTIONS_LIMIT", 250, 1000),
});

export type AppEnvironment = typeof env;
