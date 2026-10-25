"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage, fetchApiSignal, postApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { targetLabel } from "../../lib/rules";
import type { Device, Proposal } from "../../lib/types";
import AutoTextarea from "./AutoTextarea";

interface Props {
  devices: Device[];
  refreshKey: number;
  onPendingChange: (count: number) => void;
  /** A proposal was approved or rejected: documents may have changed. */
  onDecided: () => Promise<void>;
}

const MODE_HINT: Record<Proposal["mode"], string> = {
  append: "adds to the end of the document",
  replace: "replaces the whole document",
};

export default function RuleInbox({ devices, refreshKey, onPendingChange, onDecided }: Props) {
  const id = useId();
  const [pending, setPending] = useState<Proposal[] | null>(null);
  const [decided, setDecided] = useState<Proposal[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [status, setStatus] = useState("");
  const ctlRef = useRef<AbortController | null>(null);
  const pendingCb = useRef(onPendingChange);
  pendingCb.current = onPendingChange;

  const load = useCallback(async () => {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const [p, all] = await Promise.all([
        fetchApiSignal<{ proposals: Proposal[] }>("/rules/proposals?status=pending", ctl.signal),
        showDecided ? fetchApiSignal<{ proposals: Proposal[] }>("/rules/proposals?status=all", ctl.signal) : Promise.resolve(null),
      ]);
      if (ctl.signal.aborted) return;
      setPending(p.proposals);
      setDecided(all ? all.proposals.filter((x) => x.status !== "pending") : null);
      setError(null);
      pendingCb.current(p.proposals.length);
    } catch (e) {
      if (!ctl.signal.aborted) setError(errorMessage(e));
    }
  }, [showDecided]);

  useEffect(() => {
    void load();
    return () => ctlRef.current?.abort();
  }, [load, refreshKey]);

  async function decide(p: Proposal, action: "approve" | "reject") {
    setBusyId(p.id);
    setRowError(null);
    setStatus("");
    const edited = edits[p.id];
    const changed = action === "approve" && edited !== undefined && edited.trim() !== p.text.trim();
    try {
      await postApi(`/rules/proposals/${action}`, changed ? { id: p.id, text: edited } : { id: p.id });
      setEdits((cur) => {
        const { [p.id]: _gone, ...rest } = cur;
        return rest;
      });
      setStatus(action === "approve" ? "Approved" : "Rejected");
      await Promise.all([load(), onDecided()]);
    } catch (e) {
      setRowError({ id: p.id, message: errorMessage(e) });
      // "already approved" and similar mean the list is stale
      void load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-h`} className="panel-title">
          Inbox{pending && pending.length > 0 ? ` (${pending.length})` : ""}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showDecided} onChange={(e) => setShowDecided(e.target.checked)} />
          Show decided
        </label>
      </div>
      <p className="mb-3 text-sm text-muted">The agent can only propose changes. Nothing applies until you approve it here.</p>
      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-bad">
          {error}{" "}
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      {!pending && !error ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : pending && pending.length === 0 ? (
        <p className="text-sm text-muted">No proposals. When the agent suggests a rule it shows up here.</p>
      ) : (
        <ul className="space-y-3">
          {(pending ?? []).map((p) => {
            const text = edits[p.id] ?? p.text;
            const edited = text.trim() !== p.text.trim();
            const busy = busyId === p.id;
            const fieldId = `${id}-${p.id}`;
            return (
              <li key={p.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="min-w-0 break-words text-sm font-medium">{targetLabel(p, devices)}</span>
                  <span className="pill">{p.mode}</span>
                  <span className="text-xs text-muted">by {p.author}</span>
                  <span className="text-xs text-muted">{formatDateTime(p.created_at)}</span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Mode {p.mode}: {MODE_HINT[p.mode]}.
                </p>
                {p.reason && <p className="mt-1 text-sm">Reason: {p.reason}</p>}
                <label htmlFor={fieldId} className="mb-1 mt-2 block text-xs font-medium text-muted">
                  Proposed text {edited && <span className="text-warn">(edited)</span>}
                </label>
                <AutoTextarea
                  id={fieldId}
                  minRows={3}
                  value={text}
                  onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void decide(p, "approve")} disabled={busy || text.trim() === ""} className="btn btn-primary">
                    Approve
                  </button>
                  <button type="button" onClick={() => void decide(p, "reject")} disabled={busy} className="btn btn-danger">
                    Reject
                  </button>
                  {edited && (
                    <button type="button" onClick={() => setEdits(({ [p.id]: _gone, ...rest }) => rest)} disabled={busy} className="btn">
                      Undo edits
                    </button>
                  )}
                </div>
                {rowError?.id === p.id && (
                  <p role="alert" className="mt-2 text-sm text-bad">
                    {rowError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {showDecided && decided && (
        <div className="mt-5">
          <h3 className="section-title">Decided</h3>
          {decided.length === 0 ? (
            <p className="text-sm text-muted">Nothing decided yet.</p>
          ) : (
            <ul className="space-y-2">
              {decided.map((p) => (
                <li key={p.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`status ${p.status === "approved" ? "text-ok" : "text-bad"}`}>{p.status === "approved" ? "Approved" : "Rejected"}</span>
                    <span className="min-w-0 break-words text-sm font-medium">{targetLabel(p, devices)}</span>
                    <span className="pill">{p.mode}</span>
                    <span className="text-xs text-muted">by {p.author}</span>
                    <span className="text-xs text-muted">{formatDateTime(p.decided_at ?? p.created_at)}</span>
                  </div>
                  {p.reason && <p className="mt-1 text-sm">Reason: {p.reason}</p>}
                  <pre className="field field-mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{p.text}</pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
