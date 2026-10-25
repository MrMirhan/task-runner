"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { clearKey, loadStoredKey, onUnauthorized, storeKey } from "./auth";
import { errorMessage, fetchHealth, verifyKey } from "./api";
import type { Health } from "./types";

type Phase = "loading" | "error" | "signin" | "ready";

interface Session {
  phase: Phase;
  health: Health | null;
  error: string | null;
  /** Shown on the sign-in screen when the server threw the saved key out. */
  notice: string | null;
  retry: () => void;
  signIn: (key: string, keep: boolean) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setPhase("loading");
    fetchHealth(ctl.signal)
      .then((h) => {
        setHealth(h);
        setError(null);
        setPhase(h.auth === "bearer" && !loadStoredKey() ? "signin" : "ready");
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setError(errorMessage(e));
        setPhase("error");
      });
    return () => ctl.abort();
  }, [attempt]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setNotice("The server did not accept the saved key. Sign in again.");
        setPhase("signin");
      }),
    [],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const signIn = useCallback(async (key: string, keep: boolean) => {
    await verifyKey(key);
    storeKey(key, keep);
    setNotice(null);
    setPhase("ready");
  }, []);

  const signOut = useCallback(() => {
    clearKey();
    setNotice(null);
    setPhase("signin");
  }, []);

  const value = useMemo(
    () => ({ phase, health, error, notice, retry, signIn, signOut }),
    [phase, health, error, notice, retry, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession needs a SessionProvider");
  return ctx;
}
