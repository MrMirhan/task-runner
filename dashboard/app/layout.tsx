import type { Metadata } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "./lib/theme";

export const metadata: Metadata = {
  title: "Task Runner",
  description: "Local dashboard for the task-runner memory graph, notes and tasks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
