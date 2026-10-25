"use client";

import { useTheme } from "../lib/theme";

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button type="button" onClick={toggle} className="btn" aria-label={`Switch to ${next} theme`}>
      {next === "light" ? "Light" : "Dark"}
    </button>
  );
}
