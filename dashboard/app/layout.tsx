import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Task Runner Dashboard",
  description: "Knowledge graph, memory entries, and task management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased" style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}>
        {children}
      </body>
    </html>
  );
}
