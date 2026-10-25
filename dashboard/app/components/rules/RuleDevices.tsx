"use client";

import { useId, useState } from "react";
import { errorMessage, putApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { shortId } from "../../lib/rules";
import type { Device } from "../../lib/types";

interface Props {
  devices: Device[];
  /** Address a machine passes to `login`; null when this page is only reachable locally. */
  serverAddress: string | null;
  onChanged: () => Promise<void>;
}

export default function RuleDevices({ devices, serverAddress, onChanged }: Props) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  function start(d: Device) {
    setEditing(d.id);
    setDraft(d.label);
    setError(null);
    setStatus("");
  }

  async function rename(d: Device) {
    const label = draft.trim();
    if (!label || busy) return;
    if (label === d.label) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await putApi("/devices", { id: d.id, label });
      await onChanged();
      setEditing(null);
      setStatus(`Renamed to ${label}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const cell = "px-2 py-1.5 align-middle max-md:flex max-md:items-baseline max-md:gap-2 max-md:py-0.5";
  const mobileLabel = "w-20 shrink-0 text-xs text-muted md:hidden";

  return (
    <section aria-labelledby={`${id}-h`} className="panel lg:col-span-2">
      <h2 id={`${id}-h`} className="panel-title">
        Devices
      </h2>
      <p className="mb-3 text-sm text-muted">
        A machine joins by running{" "}
        <code className="rounded bg-raised px-1 py-0.5 text-xs">task-runner-mcp login {serverAddress ?? "<server address>"}</code> on it.
      </p>
      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      {devices.length === 0 ? (
        <p className="text-sm text-muted">No devices yet.</p>
      ) : (
        <table className="w-full text-sm max-md:block">
          <thead className="max-md:sr-only">
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="px-2 py-1.5 font-semibold">
                Label
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                Platform
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                ID
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                Last seen
              </th>
              <th scope="col" className="px-2 py-1.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-md:block">
            {devices.map((d) => {
              const isEditing = editing === d.id;
              return (
                <tr key={d.id} className="border-t border-line max-md:block max-md:py-2">
                  <td className={cell}>
                    <span className={mobileLabel}>Label</span>
                    {isEditing ? (
                      <form
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void rename(d);
                        }}
                      >
                        <label htmlFor={`${id}-${d.id}`} className="sr-only">
                          New label for {d.label}
                        </label>
                        <input
                          id={`${id}-${d.id}`}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          maxLength={60}
                          autoFocus
                          onFocus={(e) => e.currentTarget.select()}
                          autoComplete="off"
                          disabled={busy}
                          className="field min-w-0 flex-1 md:w-48 md:flex-none"
                        />
                        <button type="submit" disabled={busy || draft.trim() === ""} className="btn btn-sm btn-primary">
                          {busy ? "Saving…" : "Save"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setEditing(null)} className="btn btn-sm">
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span className="font-medium">{d.label}</span>
                    )}
                  </td>
                  <td className={cell}>
                    <span className={mobileLabel}>Platform</span>
                    <span className="text-muted">{d.platform ?? "—"}</span>
                  </td>
                  <td className={cell}>
                    <span className={mobileLabel}>ID</span>
                    <code className="text-xs text-muted" title={d.id}>
                      {shortId(d.id)}
                    </code>
                  </td>
                  <td className={cell}>
                    <span className={mobileLabel}>Last seen</span>
                    <span className="text-muted">{formatDateTime(d.last_seen)}</span>
                  </td>
                  <td className={`${cell} md:text-right`}>
                    {!isEditing && (
                      <button type="button" onClick={() => start(d)} className="btn btn-sm" aria-label={`Rename ${d.label}`}>
                        Rename
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
