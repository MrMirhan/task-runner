export type StoreErrorCode = "invalid" | "not_found" | "conflict";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function assertIn<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new StoreError("invalid", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StoreError("invalid", `${field} is required`);
  }
  return value;
}
