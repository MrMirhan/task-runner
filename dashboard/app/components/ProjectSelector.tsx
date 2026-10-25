"use client";

import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import type { Project } from "../lib/types";

interface Props {
  selected: string | null;
  onSelect: (key: string) => void;
}

export default function ProjectSelector({ selected, onSelect }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetchApi<{ projects: Project[] }>("/projects").then((d) => {
      setProjects(d.projects);
      // Auto-select most recent project if nothing selected
      if (!selected && d.projects.length > 0) {
        onSelect(d.projects[0].key);
      }
    });
  }, []);

  return (
    <select
      value={selected ?? ""}
      onChange={(e) => onSelect(e.target.value)}
      className="bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
    >
      <option value="" disabled>
        Select project...
      </option>
      {projects.map((p) => (
        <option key={p.key} value={p.key}>
          {p.project_name || p.key}
        </option>
      ))}
    </select>
  );
}
