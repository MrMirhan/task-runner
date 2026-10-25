import type { Device, RuleScope } from "./types";

export interface Target {
  scope: RuleScope;
  ref: string;
  device: string;
}

export const SCOPES: Array<{ value: RuleScope; label: string }> = [
  { value: "global", label: "Everywhere" },
  { value: "device", label: "A device" },
  { value: "org", label: "An organization" },
  { value: "project", label: "A project" },
  { value: "project_device", label: "A project on a device" },
];

export const SCOPE_TITLE: Record<RuleScope, string> = {
  global: "Everywhere",
  device: "Devices",
  org: "Organizations",
  project: "Projects",
  project_device: "Projects on a device",
};

export const needsRef = (scope: RuleScope): boolean => scope === "org" || scope === "project" || scope === "project_device";
export const needsDevice = (scope: RuleScope): boolean => scope === "device" || scope === "project_device";

/** Drops the fields a scope does not use, as the server does. */
export function normalizeTarget(t: Target): Target {
  return {
    scope: t.scope,
    ref: needsRef(t.scope) ? t.ref.trim() : "",
    device: needsDevice(t.scope) ? t.device : "",
  };
}

export function targetReady(t: Target): boolean {
  const n = normalizeTarget(t);
  return (!needsRef(n.scope) || n.ref !== "") && (!needsDevice(n.scope) || n.device !== "");
}

export function sameTarget(a: Target, b: Target): boolean {
  return a.scope === b.scope && a.ref === b.ref && a.device === b.device;
}

export const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

export function deviceName(id: string, devices: Device[]): string {
  const d = devices.find((x) => x.id === id);
  return d ? d.label : shortId(id);
}

export function targetLabel(t: Target, devices: Device[]): string {
  switch (t.scope) {
    case "global":
      return "Everywhere";
    case "device":
      return `Device ${t.device ? deviceName(t.device, devices) : "(none chosen)"}`;
    case "org":
      return `Organization ${t.ref || "(none chosen)"}`;
    case "project":
      return `Project ${t.ref || "(none chosen)"}`;
    case "project_device":
      return `Project ${t.ref || "(none chosen)"} on ${t.device ? deviceName(t.device, devices) : "(no device chosen)"}`;
  }
}

export function firstLine(body: string, max = 110): string {
  const line = body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
