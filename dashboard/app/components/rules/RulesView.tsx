"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, fetchApiSignal } from "../../lib/api";
import type { Target } from "../../lib/rules";
import { useSession } from "../../lib/session";
import { confirmDiscard } from "../../lib/unsaved";
import type { Device, Project, RuleDoc } from "../../lib/types";
import { GLOBAL_PROJECT } from "../../lib/types";
import RuleDevices from "./RuleDevices";
import RuleDocList from "./RuleDocList";
import RuleEditor from "./RuleEditor";
import RuleInbox from "./RuleInbox";
import RulePreview from "./RulePreview";

interface Props {
  refreshKey: number;
  onPendingChange?: (count: number) => void;
}

interface Data {
  docs: RuleDoc[];
  devices: Device[];
  projectKeys: string[];
}

export default function RulesView({ refreshKey, onPendingChange }: Props) {
  const { health } = useSession();
  const local = Boolean(health?.features.includes("memory"));
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>({ scope: "global", ref: "", device: "" });
  const [editorKey, setEditorKey] = useState(0);
  const ctlRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const [docs, devices, projects] = await Promise.all([
        fetchApiSignal<{ docs: RuleDoc[] }>("/rules/docs", ctl.signal),
        fetchApiSignal<{ devices: Device[] }>("/devices", ctl.signal),
        local ? fetchApiSignal<{ projects: Project[] }>("/projects", ctl.signal).catch(() => ({ projects: [] as Project[] })) : { projects: [] as Project[] },
      ]);
      if (ctl.signal.aborted) return;
      setData({
        docs: docs.docs,
        devices: devices.devices,
        projectKeys: projects.projects.map((p) => p.key).filter((k) => k !== GLOBAL_PROJECT),
      });
      setError(null);
    } catch (e) {
      if (!ctl.signal.aborted) setError(errorMessage(e));
    }
  }, [local]);

  useEffect(() => {
    void load();
    return () => ctlRef.current?.abort();
  }, [load, refreshKey]);

  const orgs = useMemo(() => unique((data?.docs ?? []).filter((d) => d.scope === "org").map((d) => d.ref)), [data]);
  const projectRefs = useMemo(
    () => unique([...(data?.docs ?? []).filter((d) => d.scope === "project" || d.scope === "project_device").map((d) => d.ref), ...(data?.projectKeys ?? [])]),
    [data],
  );
  const docsStamp = useMemo(() => (data?.docs ?? []).map((d) => `${d.id}:${d.version}`).join(","), [data]);

  if (!data) {
    return error ? (
      <div className="p-2 text-sm">
        <p role="alert" className="text-bad">
          {error}
        </p>
        <button type="button" onClick={() => void load()} className="btn btn-primary mt-3">
          Try again
        </button>
      </div>
    ) : (
      <p className="p-2 text-sm text-muted" role="status">
        Loading rules…
      </p>
    );
  }

  function openDoc(doc: RuleDoc) {
    if (!confirmDiscard()) return;
    setTarget({ scope: doc.scope, ref: doc.ref, device: doc.device });
    setEditorKey((k) => k + 1);
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}{" "}
          <button type="button" onClick={() => void load()} className="btn btn-sm">
            Retry
          </button>
        </p>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <RuleEditor
          key={editorKey}
          target={target}
          onTarget={setTarget}
          docs={data.docs}
          devices={data.devices}
          orgs={orgs}
          projectRefs={projectRefs}
          onChanged={load}
        />
        <RuleDocList docs={data.docs} devices={data.devices} current={target} onOpen={openDoc} />
        <RulePreview devices={data.devices} orgs={orgs} projectRefs={projectRefs} docsStamp={docsStamp} />
        <RuleInbox devices={data.devices} refreshKey={refreshKey} onPendingChange={(n) => onPendingChange?.(n)} onDecided={load} />
        <RuleDevices devices={data.devices} serverAddress={local ? null : window.location.origin} onChanged={load} />
      </div>
    </div>
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
