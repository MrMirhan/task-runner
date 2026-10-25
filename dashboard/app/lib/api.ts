import { clearKey, getKey, notifyUnauthorized } from "./auth";
import type { Health } from "./types";

// Same-origin by default: the CLI's `dashboard` server serves this UI and /api together.
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Param = string | number | boolean | null | undefined;

export function qs(params: Record<string, Param>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  const key = getKey();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the dashboard server.");
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.status === 401 && key && getKey() === key) {
    clearKey();
    notifyUnauthorized();
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const fetchApi = <T>(path: string) => request<T>("GET", path);
export const postApi = <T>(path: string, body: unknown) => request<T>("POST", path, body);
export const putApi = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
export const deleteApi = <T>(path: string) => request<T>("DELETE", path);

export const fetchApiSignal = <T>(path: string, signal: AbortSignal) => request<T>("GET", path, undefined, signal);

/** GET /health needs no key; it tells the page whether to ask for one. */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/health`, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the server.");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object" || !Array.isArray((data as Health).features)) {
    throw new ApiError(res.status, `Unexpected response from the server (${res.status}).`);
  }
  return data as Health;
}

/** Checks a key against the server without storing it. */
export async function verifyKey(key: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/devices`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new ApiError(0, "Cannot reach the server.");
  }
  if (res.ok) return;
  if (res.status === 401) throw new ApiError(401, "That key was not accepted");
  const data: unknown = await res.json().catch(() => null);
  throw new ApiError(
    res.status,
    data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
  );
}

/** Same-origin URL a plain link can download; the CSV endpoint takes the same query as /worklog. */
export const apiUrl = (path: string) => `${API_BASE}${path}`;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
