"use client";

import { useId, useState } from "react";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import ThemeToggle from "./ThemeToggle";

export default function SignIn() {
  const { signIn, notice } = useSession();
  const id = useId();
  const [key, setKey] = useState("");
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = key.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(value, keep);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-3">
        <h1 className="text-base font-bold">Task Runner</h1>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center p-4">
        {/* method="post" keeps the key out of the URL if the form is ever submitted before the script runs. */}
        <form onSubmit={submit} method="post" className="card w-full max-w-sm space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold">Sign in</h2>
            <p className="mt-1 text-sm text-muted">Enter the server key to manage your rules.</p>
          </div>

          {notice && (
            <p role="status" className="text-sm text-warn">
              {notice}
            </p>
          )}

          <div>
            <label htmlFor={`${id}-key`} className="mb-1 block text-sm font-medium">
              Server key
            </label>
            <input
              id={`${id}-key`}
              name="server-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              className="field"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep me signed in on this browser
          </label>

          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy || key.trim() === ""} className="btn btn-primary w-full justify-center">
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}
