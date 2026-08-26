import type { ParsedQs } from "qs";
import { ObjectId } from "mongodb";

import { env } from "../config/env";
import { ValidationError } from "../errors/app-error";

export type QueryValue = string | string[] | ParsedQs | ParsedQs[] | undefined;

export interface AssetQueryFilters {
  q?: string;
  sources: string[];
  conditions: string[];
  categories: string[];
  types: string[];
  employers: string[];
  statuses: string[];
  isPresent?: boolean;
  isDone?: boolean;
  hasNotes?: boolean;
  folderId?: ObjectId;
  includeDescendants: boolean;
  updatedFrom?: Date;
  updatedTo?: Date;
  page: number;
  pageSize: number;
  sortBy: AssetSortField;
  sortDir: 1 | -1;
}

export type AssetSortField =
  | "displayName"
  | "updatedAt"
  | "condition"
  | "category"
  | "type"
  | "source"
  | "quantity";

export interface DashboardPagination {
  page: number;
  pageSize: number;
}

const SORT_FIELDS = new Set<AssetSortField>([
  "displayName",
  "updatedAt",
  "condition",
  "category",
  "type",
  "source",
  "quantity",
]);

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const MAX_FILTER_VALUES = 20;
const MAX_FILTER_VALUE_LENGTH = 120;

function isStringArray(value: QueryValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringValues(value: QueryValue, name: string): string[] {
  if (value === undefined) {
    return [];
  }

  const rawValues = typeof value === "string" ? [value] : isStringArray(value) ? value : undefined;
  if (!rawValues) {
    throw new ValidationError(`${name} must be a string or a repeated string query parameter.`);
  }

  const values = rawValues
    .flatMap((raw) => raw.split(","))
    .map((raw) => raw.trim())
    .filter(Boolean);

  if (values.length > MAX_FILTER_VALUES) {
    throw new ValidationError(`${name} accepts at most ${MAX_FILTER_VALUES} values.`);
  }

  if (values.some((item) => item.length > MAX_FILTER_VALUE_LENGTH)) {
    throw new ValidationError(`${name} values must be ${MAX_FILTER_VALUE_LENGTH} characters or fewer.`);
  }

  return [...new Set(values)];
}

function singleString(value: QueryValue, name: string): string | undefined {
  const values = stringValues(value, name);
  if (values.length > 1) {
    throw new ValidationError(`${name} accepts one value only.`);
  }
  return values[0];
}

function positiveInteger(
  value: QueryValue,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = singleString(value, name);
  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${name} must be a positive integer.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidationError(`${name} must be between 1 and ${maximum}.`);
  }

  return parsed;
}

function optionalBoolean(value: QueryValue, name: string): boolean | undefined {
  const raw = singleString(value, name);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new ValidationError(`${name} must be true or false.`);
}

function optionalDate(value: QueryValue, name: string, endOfDay: boolean): Date | undefined {
  const raw = singleString(value, name);
  if (raw === undefined) {
    return undefined;
  }

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(
    dateOnly ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : raw,
  );

  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${name} must be an ISO-8601 date or timestamp.`);
  }

  return parsed;
}

export function parseObjectId(value: unknown, name: string): ObjectId {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new ValidationError(`${name} must be a 24-character MongoDB ObjectId.`);
  }
  return new ObjectId(value);
}

export function parseAssetFilters(query: Record<string, QueryValue>): AssetQueryFilters {
  const q = singleString(query.q ?? query.search, "q");
  if (q && q.length > 100) {
    throw new ValidationError("q must be 100 characters or fewer.");
  }

  const updatedFrom = optionalDate(query.updatedFrom, "updatedFrom", false);
  const updatedTo = optionalDate(query.updatedTo, "updatedTo", true);
  if (updatedFrom && updatedTo && updatedFrom > updatedTo) {
    throw new ValidationError("updatedFrom must be earlier than or equal to updatedTo.");
  }

  const explicitSortBy = singleString(query.sortBy, "sortBy");
  const legacySort = singleString(query.sort, "sort");
  const [legacyField, legacyDirection] = legacySort?.split(":") ?? [];
  const sortAliases: Record<string, AssetSortField> = {
    name: "displayName",
    displayName: "displayName",
    updatedAt: "updatedAt",
    condition: "condition",
    category: "category",
    type: "type",
    source: "source",
    quantity: "quantity",
  };
  const rawSortField = explicitSortBy ?? legacyField ?? "updatedAt";
  const sortByCandidate = sortAliases[rawSortField] ?? rawSortField;
  if (!SORT_FIELDS.has(sortByCandidate as AssetSortField)) {
    throw new ValidationError(
      `sortBy must be one of: ${[...SORT_FIELDS].join(", ")}.`,
    );
  }

  const sortDirCandidate = singleString(query.sortDir, "sortDir") ?? legacyDirection ?? "desc";
  if (sortDirCandidate !== "asc" && sortDirCandidate !== "desc") {
    throw new ValidationError("sortDir must be asc or desc.");
  }

  const folderIdText = singleString(query.folderId, "folderId");

  return {
    q,
    sources: stringValues(query.source ?? query.sources, "source"),
    conditions: stringValues(query.condition ?? query.conditions, "condition"),
    categories: stringValues(query.category ?? query.categories, "category"),
    types: stringValues(query.type ?? query.types, "type"),
    employers: stringValues(query.employer ?? query.employers, "employer"),
    statuses: stringValues(query.status ?? query.statuses, "status"),
    isPresent: optionalBoolean(query.isPresent ?? query.present, "isPresent"),
    isDone: optionalBoolean(query.isDone ?? query.done, "isDone"),
    hasNotes: optionalBoolean(query.hasNotes, "hasNotes"),
    folderId: folderIdText ? parseObjectId(folderIdText, "folderId") : undefined,
    includeDescendants: optionalBoolean(query.includeDescendants, "includeDescendants") ?? true,
    updatedFrom,
    updatedTo,
    page: positiveInteger(query.page ?? query.cursor, "page", 1, env.maxPage),
    pageSize: positiveInteger(query.pageSize ?? query.limit, "pageSize", env.defaultPageSize, env.maxPageSize),
    sortBy: sortByCandidate as AssetSortField,
    sortDir: sortDirCandidate === "asc" ? 1 : -1,
  };
}

/** Pagination for the company dashboard project grid. */
export function parseDashboardPagination(query: Record<string, QueryValue>): DashboardPagination {
  return {
    page: positiveInteger(query.page, "page", 1, env.maxPage),
    // Twelve projects form a compact 3 × 4 desktop grid while keeping mobile
    // pages short. The server limit remains the environment-configured cap.
    pageSize: positiveInteger(query.pageSize, "pageSize", 12, env.maxPageSize),
  };
}

export function parseOptionCategories(query: Record<string, QueryValue>): string[] {
  return stringValues(query.category ?? query.categories, "category");
}

export function parseExportLimit(query: Record<string, QueryValue>): number {
  return positiveInteger(query.limit, "limit", env.exportMaxRows, env.exportMaxRows);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function publicFilters(filters: AssetQueryFilters): Record<string, unknown> {
  return {
    q: filters.q ?? null,
    source: filters.sources,
    condition: filters.conditions,
    category: filters.categories,
    type: filters.types,
    employer: filters.employers,
    status: filters.statuses,
    isPresent: filters.isPresent ?? null,
    present: filters.isPresent ?? null,
    isDone: filters.isDone ?? null,
    done: filters.isDone ?? null,
    hasNotes: filters.hasNotes ?? null,
    folderId: filters.folderId?.toHexString() ?? null,
    includeDescendants: filters.includeDescendants,
    updatedFrom: filters.updatedFrom?.toISOString() ?? null,
    updatedTo: filters.updatedTo?.toISOString() ?? null,
    sortBy: filters.sortBy,
    sortDir: filters.sortDir === 1 ? "asc" : "desc",
  };
}
