"use client";

import { useEffect, useId, useRef, useState } from "react";
import { errorMessage, fetchApiSignal, qs } from "../../lib/api";
import { shortId } from "../../lib/rules";
import { MAX_RESOLVED_CHARS } from "../../lib/types";
import type { Device, ResolvedRules } from "../../lib/types";

interface Props {
  devices: Device[];
  orgs: string[];
  projectRefs: string[];
  /** Changes when any document changes, so a shown preview can refresh itself. */
  docsStamp: string;
}

const STORAGE_KEY = "task-runner-rules-preview";

interface Inputs {
  project: string;
  org: string;
  device: string;
}

function loadInputs(): Inputs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Inputs> | null;
    return { project: raw?.project ?? "", org: raw?.org ?? "", device: raw?.device ?? "" };
  } catch {
    return { project: "", org: "", device: "" };
  }
}

function saveInputs(inputs: Inputs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
  } catch {
    // storage can be blocked; the values just won't be remembered
  }
}

export default function RulePreview({ devices, orgs, projectRefs, docsStamp }: Props) {
  const id = useId();
  const [inputs, setInputs] = useState<Inputs>({ project: "", org: "", device: "" });
  const [result, setResult] = useState<ResolvedRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ctlRef = useRef<AbortController | null>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  useEffect(() => {
    setInputs(loadInputs());
  }, []);

  async function run() {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    const current = inputsRef.current;
    saveInputs(current);
    setLoading(true);
    setError(null);
    try {
      const out = await fetchApiSignal<ResolvedRules>(
        `/rules/resolve${qs({ project: current.project.trim(), org: current.org.trim(), device: current.device })}`,
        ctl.signal,
      );
      if (ctl.signal.aborted) return;
      setResult(out);
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(errorMessage(e));
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }

  // Keep a shown preview in step with saved documents.
  const shown = result !== null;
  useEffect(() => {
    if (shown) void run();
  }, [docsStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => ctlRef.current?.abort(), []);

  const deviceKnown = !inputs.device || devices.some((d) => d.id === inputs.device);
  const partsTotal = result?.parts.reduce((n, p) => n + p.chars, 0) ?? 0;
  const scale = Math.max(MAX_RESOLVED_CHARS, partsTotal);

  return (
    <section aria-labelledby={`${id}-h`} className="panel">
      <h2 id={`${id}-h`} className="panel-title">
        Preview
      </h2>
      <p className="mb-3 text-sm text-muted">The exact text an agent receives for a project, organization and device.</p>

      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div>
          <label htmlFor={`${id}-project`} className="mb-1 block text-xs font-medium text-muted">
            Project
          </label>
          <input
            id={`${id}-project`}
            list={`${id}-projects`}
            value={inputs.project}
            onChange={(e) => setInputs({ ...inputs, project: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            className="field"
          />
          <datalist id={`${id}-projects`}>
            {projectRefs.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor={`${id}-org`} className="mb-1 block text-xs font-medium text-muted">
            Organization
          </label>
          <input
            id={`${id}-org`}
            list={`${id}-orgs`}
            value={inputs.org}
            onChange={(e) => setInputs({ ...inputs, org: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            className="field"
          />
          <datalist id={`${id}-orgs`}>
            {orgs.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor={`${id}-device`} className="mb-1 block text-xs font-medium text-muted">
            Device
          </label>
          <select
            id={`${id}-device`}
            value={inputs.device}
            onChange={(e) => setInputs({ ...inputs, device: e.target.value })}
            className="field"
          >
            <option value="">No device</option>
            {!deviceKnown && <option value={inputs.device}>{shortId(inputs.device)} (unknown)</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} ({shortId(d.id)})
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-3">
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? "Loading…" : "Show preview"}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}{" "}
          <button type="button" className="btn btn-sm" onClick={() => void run()}>
            Retry
          </button>
        </p>
      )}

      {result && (
        <div className="mt-4 space-y-3">
          {result.truncated && (
            <p className="rounded-lg border border-warn px-3 py-2 text-sm text-warn" role="note">
              Cut: together these documents are longer than {MAX_RESOLVED_CHARS} characters, so the broadest sections lose text first. Shorten them to
              keep everything.
            </p>
          )}

          {result.parts.length === 0 ? (
            <p className="text-sm text-muted">No rules apply to this combination.</p>
          ) : (
            <div>
              <div
                role="img"
                aria-label={`Size of each part against the ${MAX_RESOLVED_CHARS} character budget: ${result.parts
                  .map((p) => `${p.label} ${p.chars}`)
                  .join(", ")}`}
                className="relative flex h-4 gap-0.5 overflow-hidden rounded border border-line bg-raised"
              >
                {result.parts.map((p, i) => (
                  <div
                    key={`${p.scope}-${i}`}
                    title={`${p.label}: ${p.chars}`}
                    style={{ width: `${(p.chars / scale) * 100}%`, background: `var(--scope-${p.scope})` }}
                  />
                ))}
                {scale > MAX_RESOLVED_CHARS && (
                  <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `${(MAX_RESOLVED_CHARS / scale) * 100}%` }} />
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                {partsTotal} / {MAX_RESOLVED_CHARS} characters of rules · {result.chars} in the text sent
              </p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {result.parts.map((p, i) => (
                  <li key={`${p.scope}-${i}`} className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--scope-${p.scope})` }} aria-hidden="true" />
                    <span>{p.label}</span>
                    <span className="text-muted">{p.chars}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.text !== "" && (
            <pre
              tabIndex={0}
              aria-label="Text the agent receives"
              className="field field-mono max-h-96 overflow-auto whitespace-pre-wrap break-words"
            >
              {result.text}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
