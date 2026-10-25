"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage, fetchApiSignal, putApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import {
  SCOPES,
  firstLine,
  needsDevice,
  needsRef,
  normalizeTarget,
  sameTarget,
  shortId,
  targetLabel,
  targetReady,
  type Target,
} from "../../lib/rules";
import { setUnsaved } from "../../lib/unsaved";
import { MAX_DOC_CHARS } from "../../lib/types";
import type { Device, RuleDoc, RuleRevision } from "../../lib/types";
import AutoTextarea from "./AutoTextarea";

interface Props {
  target: Target;
  onTarget: (t: Target) => void;
  docs: RuleDoc[];
  devices: Device[];
  orgs: string[];
  projectRefs: string[];
  /** Reloads the documents; resolves once the new list is in. */
  onChanged: () => Promise<void>;
}

type Status = { kind: "ok" | "info"; text: string } | null;

const NEAR_LIMIT = Math.floor(MAX_DOC_CHARS * 0.9);

export default function RuleEditor({ target, onTarget, docs, devices, orgs, projectRefs, onChanged }: Props) {
  const ids = useId();
  const t = normalizeTarget(target);
  const ready = targetReady(target);
  const doc = useMemo(() => docs.find((d) => sameTarget(d, t)) ?? null, [docs, t.scope, t.ref, t.device]);
  const baseline = doc?.body ?? "";

  const [text, setText] = useState(baseline);
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  const dirty = cleaned !== baseline;
  const length = cleaned.length;
  const over = length > MAX_DOC_CHARS;
  const near = !over && length >= NEAR_LIMIT;

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState<string | null>(null);

  // A different document (or a refreshed one) replaces the text only while nothing is being edited.
  const lastBaseline = useRef(baseline);
  useEffect(() => {
    const previous = lastBaseline.current;
    if (previous === baseline) return;
    lastBaseline.current = baseline;
    setText((cur) => (cur.replace(/\r\n/g, "\n").trim() === previous ? baseline : cur));
  }, [baseline]);

  useEffect(() => {
    setUnsaved(dirty);
    return () => setUnsaved(false);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Switching the target in place would carry text meant for one document into another.
  const locked = dirty || busy;

  const label = targetLabel(t, devices);
  const deviceKnown = !t.device || devices.some((d) => d.id === t.device);

  async function save() {
    if (!ready || over || busy) return;
    if (cleaned === "") {
      if (!doc) return;
      if (!window.confirm(`Remove the rules for "${label}"? This deletes the document.`)) return;
    }
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await putApi<{ removed: boolean }>("/rules/docs", {
        scope: t.scope,
        ref: t.ref || undefined,
        device: t.device || undefined,
        body: cleaned,
      });
      await onChanged();
      setText(cleaned);
      setStatus({ kind: "ok", text: out.removed ? "Removed" : "Saved" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    setText(baseline);
    setError(null);
    setStatus({ kind: "info", text: "Edits discarded" });
  }

  // ─── History ─────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<RuleRevision[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyTry, setHistoryTry] = useState(0);
  const docId = doc?.id ?? null;
  const docVersion = doc?.version ?? 0;

  useEffect(() => {
    if (!historyOpen || !docId) {
      setRevisions(null);
      return;
    }
    const ctl = new AbortController();
    fetchApiSignal<{ revisions: RuleRevision[] }>(`/rules/revisions?doc_id=${encodeURIComponent(docId)}`, ctl.signal)
      .then((d) => {
        setRevisions(d.revisions);
        setHistoryError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setHistoryError(errorMessage(e));
      });
    return () => ctl.abort();
  }, [historyOpen, docId, docVersion, historyTry]);

  function restore(rev: RuleRevision) {
    setText(rev.body);
    setError(null);
    setStatus({ kind: "info", text: `Version ${rev.version} is in the editor. It is not saved until you press Save.` });
  }

  function setScope(scope: Target["scope"]) {
    if (locked) return;
    onTarget({ scope, ref: needsRef(scope) ? target.ref : "", device: needsDevice(scope) ? target.device : "" });
  }

  const textId = `${ids}-text`;
  const countId = `${ids}-count`;
  const countTone = over ? "text-bad" : near ? "text-warn" : "text-muted";

  return (
    <section aria-labelledby={`${ids}-h`} className="panel">
      <h2 id={`${ids}-h`} className="panel-title">
        Edit rules
      </h2>
      <p className="mb-3 text-sm text-muted">
        Standing instructions the agent gets at the start of every session. One document for each combination below; the more specific one wins when
        two disagree.
      </p>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Scope">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            type="button"
            disabled={locked && target.scope !== s.value}
            onClick={() => setScope(s.value)}
            aria-pressed={target.scope === s.value}
            className={`btn ${target.scope === s.value ? "!border-link !text-link" : ""}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {(needsDevice(target.scope) || needsRef(target.scope)) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {target.scope === "org" && (
            <div>
              <label htmlFor={`${ids}-org`} className="mb-1 block text-xs font-medium text-muted">
                Organization
              </label>
              <input
                id={`${ids}-org`}
                list={`${ids}-orgs`}
                value={target.ref}
                disabled={locked}
                onChange={(e) => onTarget({ ...target, ref: e.target.value })}
                placeholder="e.g. the GitHub owner"
                autoComplete="off"
                spellCheck={false}
                className="field"
              />
              <datalist id={`${ids}-orgs`}>
                {orgs.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </div>
          )}
          {(target.scope === "project" || target.scope === "project_device") && (
            <div>
              <label htmlFor={`${ids}-project`} className="mb-1 block text-xs font-medium text-muted">
                Project
              </label>
              <input
                id={`${ids}-project`}
                list={`${ids}-projects`}
                value={target.ref}
                disabled={locked}
                onChange={(e) => onTarget({ ...target, ref: e.target.value })}
                placeholder="project key"
                autoComplete="off"
                spellCheck={false}
                className="field"
              />
              <datalist id={`${ids}-projects`}>
                {projectRefs.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
          )}
          {needsDevice(target.scope) && (
            <div>
              <label htmlFor={`${ids}-device`} className="mb-1 block text-xs font-medium text-muted">
                Device
              </label>
              <select
                id={`${ids}-device`}
                value={target.device}
                disabled={locked}
                onChange={(e) => onTarget({ ...target, device: e.target.value })}
                className="field"
              >
                <option value="">Choose a device…</option>
                {!deviceKnown && <option value={t.device}>{shortId(t.device)} (unknown)</option>}
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} ({shortId(d.id)})
                  </option>
                ))}
              </select>
              {devices.length === 0 && <p className="mt-1 text-xs text-muted">No devices yet. See Devices below for how a machine joins.</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <label htmlFor={textId} className="mb-1 block text-xs font-medium text-muted">
          Rules for: <span className="text-fg">{ready ? label : "choose a target first"}</span>
        </label>
        <AutoTextarea
          id={textId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setStatus(null);
          }}
          disabled={!ready}
          aria-describedby={countId}
          placeholder={ready ? "Write rules in Markdown, one short instruction per line." : ""}
          spellCheck={false}
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span id={countId} className={countTone}>
            {length} / {MAX_DOC_CHARS}
          </span>
          {(near || over) && (
            <span role="status" className={countTone}>
              {over ? `Over the limit by ${length - MAX_DOC_CHARS}. Shorten it to save.` : "Close to the limit."}
            </span>
          )}
          {cleaned === "" && doc && <span className="text-muted">Saving an empty document removes it.</span>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!ready || over || busy || !dirty}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={revert} disabled={!dirty || busy} className="btn">
          Revert
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-expanded={historyOpen}
          aria-controls={`${ids}-history`}
          disabled={!doc}
          className="btn"
          title={doc ? undefined : "This target has no saved document yet"}
        >
          History
        </button>
        <span aria-live="polite" className={`text-sm ${status?.kind === "ok" ? "text-ok" : "text-muted"}`}>
          {status?.text}
        </span>
      </div>
      {dirty && <p className="mt-2 text-xs text-muted">Unsaved edits. Save or revert them to pick another target.</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}

      {historyOpen && doc && (
        <div id={`${ids}-history`} className="mt-4 border-t border-line pt-3">
          <h3 className="section-title">History</h3>
          {historyError ? (
            <p role="alert" className="text-sm text-bad">
              {historyError}{" "}
              <button type="button" className="btn btn-sm" onClick={() => setHistoryTry((n) => n + 1)}>
                Retry
              </button>
            </p>
          ) : !revisions ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-muted">No earlier versions.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {revisions.map((r) => (
                <li key={r.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="font-medium">v{r.version}</span>
                  {r.version === doc.version && <span className="status text-ok">Current</span>}
                  <span className="text-muted">{r.source}</span>
                  <span className="text-muted">{formatDateTime(r.at)}</span>
                  <span className="min-w-0 flex-1 basis-full truncate text-xs text-subtle sm:basis-0" title={r.body}>
                    {r.body === "" ? "(removed)" : firstLine(r.body, 80)}
                  </span>
                  <button type="button" onClick={() => restore(r)} disabled={r.body === "" || busy} className="btn btn-sm">
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
