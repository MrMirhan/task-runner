"use client";

export type AuthMode = "admin" | "apikey" | null;

export interface AuthState {
  mode: AuthMode;
  token: string | null; // JWT for admin, raw API key for apikey
}

const STORAGE_KEY = "ctr_auth";

export function getAuth(): AuthState {
  if (typeof window === "undefined") return { mode: null, token: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: null, token: null };
    return JSON.parse(raw) as AuthState;
  } catch {
    return { mode: null, token: null };
  }
}

export function setAuth(state: AuthState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event("auth-change"));
}

export function clearAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("auth-change"));
}

export function getAuthHeaders(): Record<string, string> {
  const auth = getAuth();
  if (!auth.token) return {};
  return { Authorization: `Bearer ${auth.token}` };
}
