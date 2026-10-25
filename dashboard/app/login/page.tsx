"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setAuth } from "../lib/auth";

type Tab = "admin" | "apikey";

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("apikey");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Admin form
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // API key form
  const [apiKey, setApiKey] = useState("");

  const API_BASE =
    process.env.NEXT_PUBLIC_API_URL ||
    "/api";

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Invalid credentials");
        return;
      }
      setAuth({ mode: "admin", token: data.token });
      router.push("/admin");
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleApiKeyLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Validate the key by making a test request
      const res = await fetch(`${API_BASE}/projects`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (!res.ok) {
        setError("Invalid API key");
        return;
      }
      setAuth({ mode: "apikey", token: apiKey.trim() });
      router.push("/");
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-8">Knowledge Graph</h1>

        {/* Tabs */}
        <div className="flex mb-6 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => { setTab("apikey"); setError(""); }}
            className={`flex-1 py-2 text-sm rounded-md transition-colors ${
              tab === "apikey"
                ? "bg-gray-800 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            API Key
          </button>
          <button
            onClick={() => { setTab("admin"); setError(""); }}
            className={`flex-1 py-2 text-sm rounded-md transition-colors ${
              tab === "admin"
                ? "bg-gray-800 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Admin Login
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {tab === "apikey" ? (
          <form onSubmit={handleApiKeyLogin} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="ctr_..."
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {loading ? "Connecting..." : "Connect"}
            </button>
            <p className="text-xs text-gray-600 text-center">
              Enter your API key to view your knowledge graph
            </p>
          </form>
        ) : (
          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
            <p className="text-xs text-gray-600 text-center">
              Admin access for managing API keys
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
