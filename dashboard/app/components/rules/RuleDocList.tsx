"use client";

import { useId } from "react";
import { formatDate } from "../../lib/format";
import { SCOPE_TITLE, firstLine, sameTarget, targetLabel, type Target } from "../../lib/rules";
import type { Device, RuleDoc, RuleScope } from "../../lib/types";

interface Props {
  docs: RuleDoc[];
  devices: Device[];
  current: Target;
  onOpen: (doc: RuleDoc) => void;
}

const ORDER: RuleScope[] = ["global", "device", "org", "project", "project_device"];

export default function RuleDocList({ docs, devices, current, onOpen }: Props) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="panel">
      <h2 id={`${id}-h`} className="panel-title">
        Documents
      </h2>
      {docs.length === 0 ? (
        <p className="text-sm text-muted">No rules yet. Pick a scope in the editor and write the first document.</p>
      ) : (
        <div className="space-y-4">
          {ORDER.map((scope) => {
            const group = docs.filter((d) => d.scope === scope);
            if (group.length === 0) return null;
            return (
              <div key={scope}>
                <h3 className="section-title">{SCOPE_TITLE[scope]}</h3>
                <ul className="space-y-1.5">
                  {group.map((d) => {
                    const active = sameTarget(d, current);
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => onOpen(d)}
                          aria-current={active ? "true" : undefined}
                          className={`w-full rounded-lg border bg-surface px-3 py-2 text-left hover:bg-raised ${active ? "border-link" : "border-line"}`}
                        >
                          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <span className="min-w-0 break-words text-sm font-medium">{targetLabel(d, devices)}</span>
                            <span className="text-xs text-muted">
                              {d.body.length} chars · v{d.version} · {formatDate(d.updated_at)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-subtle">{firstLine(d.body)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
