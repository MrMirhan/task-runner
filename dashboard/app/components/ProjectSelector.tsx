"use client";

import type { Project } from "../lib/types";
import { projectLabel } from "../lib/types";

interface Props {
  projects: Project[];
  selected: string | null;
  onSelect: (key: string) => void;
}

export default function ProjectSelector({ projects, selected, onSelect }: Props) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="project-select" className="sr-only">
        Project
      </label>
      <select
        id="project-select"
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={projects.length === 0}
        className="field w-auto max-w-[16rem]"
      >
        {projects.length === 0 && <option value="">No projects</option>}
        {projects.map((p) => (
          <option key={p.key} value={p.key} title={p.project_path ?? undefined}>
            {projectLabel(p, projects)}
          </option>
        ))}
      </select>
    </div>
  );
}
