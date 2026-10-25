"use client";

import { useSession } from "../lib/session";
import { confirmDiscard } from "../lib/unsaved";
import ThemeToggle from "./ThemeToggle";

export default function HeaderActions({ onRefresh }: { onRefresh: () => void }) {
  const { health, signOut } = useSession();
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <button type="button" onClick={onRefresh} className="btn">
        Refresh
      </button>
      <ThemeToggle />
      {health?.auth === "bearer" && (
        <button
          type="button"
          onClick={() => {
            if (confirmDiscard()) signOut();
          }}
          className="btn"
        >
          Sign out
        </button>
      )}
    </div>
  );
}
