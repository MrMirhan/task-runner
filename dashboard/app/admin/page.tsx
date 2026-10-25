"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuth, clearAuth } from "../lib/auth";
import { fetchApi, postApi, deleteApi } from "../lib/api";

interface ApiKey {
  id: string;
  key_prefix: string;
  tenant_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked: boolean;
  revoked_at: number | null;
}

interface AdminStats {
  total_keys: number;
  active_keys: number;
  revoked_keys: number;
}

export default function AdminPage() {
  const router = useRouter();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const auth = getAuth();
    if (auth.mode !== "admin") {
      router.push("/login");
      return;
    }
  }, [router]);

  const loadData = useCallback(() => {
    fetchApi<{ success: boolean; keys: ApiKey[] }>("/admin/keys").then((d) => {
      if (d.success) setKeys(d.keys);
    });
    fetchApi<{ success: boolean; stats: AdminStats }>("/admin/stats").then((d) => {
      if (d.success) setStats(d.stats);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreatedKey(null);
    try {
      const data = await postApi<{
        success: boolean;
        key: { raw_key: string };
      }>("/admin/keys", { label: newLabel || "Unnamed key" });
      if (data.success) {
        setCreatedKey(data.key.raw_key);
        setNewLabel("");
        loadData();
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRevokeKey(id: string) {
    await deleteApi(`/admin/keys/${id}`);
    loadData();
  }

  function handleCopy() {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleLogout() {
    clearAuth();
    router.push("/login");
  }

  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <p className="text-sm text-gray-500 mt-1">Manage API keys and users</p>
        </div>
        <button
          onClick={handleLogout}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
        >
          Logout
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{stats.active_keys}</div>
            <div className="text-sm text-gray-500">Active Keys</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{stats.total_keys}</div>
            <div className="text-sm text-gray-500">Total Keys</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{stats.revoked_keys}</div>
            <div className="text-sm text-gray-500">Revoked</div>
          </div>
        </div>
      )}

      {/* Create Key */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Generate New API Key
        </h2>
        <form onSubmit={handleCreateKey} className="flex gap-3">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Key label (e.g., dev-machine)"
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none text-sm"
          />
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
          >
            {creating ? "Generating..." : "Generate"}
          </button>
        </form>

        {createdKey && (
          <div className="mt-3 p-3 bg-green-900/20 border border-green-800 rounded-lg">
            <div className="text-xs text-green-400 mb-1 font-semibold">
              New API key created — copy it now, it won't be shown again:
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-gray-800 p-2 rounded font-mono text-green-300 break-all">
                {createdKey}
              </code>
              <button
                onClick={handleCopy}
                className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors shrink-0"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Key List */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            API Keys ({keys.length})
          </h2>
        </div>
        <div className="divide-y divide-gray-800">
          {keys.length === 0 ? (
            <div className="p-4 text-sm text-gray-600 text-center">
              No API keys yet. Generate one above.
            </div>
          ) : (
            keys.map((k) => (
              <div key={k.id} className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{k.label}</span>
                    <code className="text-xs text-gray-500 font-mono">
                      {k.key_prefix}
                    </code>
                    {k.revoked && (
                      <span className="text-xs px-1.5 py-0.5 bg-red-900/30 text-red-400 rounded">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    Created {new Date(k.created_at * 1000).toLocaleDateString()}
                    {k.last_used_at && (
                      <> · Last used {new Date(k.last_used_at * 1000).toLocaleDateString()}</>
                    )}
                  </div>
                </div>
                {!k.revoked && (
                  <button
                    onClick={() => handleRevokeKey(k.id)}
                    className="px-3 py-1 text-xs text-red-400 hover:text-red-300 border border-red-800 hover:border-red-700 rounded transition-colors"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
