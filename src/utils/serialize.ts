import { ObjectId } from "mongodb";

export type PlainValue =
  | string
  | number
  | boolean
  | null
  | PlainValue[]
  | { [key: string]: PlainValue };

/** Converts BSON values to JSON-safe values without mutating MongoDB documents. */
export function toPlainValue(value: unknown): PlainValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof ObjectId) {
    return value.toHexString();
  }

  if (Array.isArray(value)) {
    return value
      .map(toPlainValue)
      .filter((item): item is PlainValue => item !== undefined);
  }

  if (typeof value === "object") {
    const output: Record<string, PlainValue> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const plain = toPlainValue(nestedValue);
      if (plain !== undefined) {
        output[key] = plain;
      }
    }
    return output;
  }

  return String(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Some imported asset fields legitimately drift between numeric and text types. */
export function numberOrStringOrNull(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return stringOrNull(value);
}

export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
