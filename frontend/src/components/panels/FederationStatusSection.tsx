"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Ban,
  Check,
  Copy,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  FederationPolicyMode,
  FederationStatusResponse,
} from "@/lib/api/client";
import { useAuthStore } from "@/store/useAuthStore";

export function FederationStatusSection() {
  const { accessToken, authedRequest } = useAuthStore();
  const [status, setStatus] = useState<FederationStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const [ruleDomain, setRuleDomain] = useState("");
  const [ruleAction, setRuleAction] = useState<"allow" | "block">("allow");
  const [probeDomain, setProbeDomain] = useState("");

  const loadStatus = useCallback(async () => {
    if (!accessToken) return;
    setError(null);
    try {
      const data = await authedRequest<FederationStatusResponse>(
        "/federation/status"
      );
      setStatus(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load federation status."
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, authedRequest]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleModeChange = async (mode: FederationPolicyMode) => {
    if (!accessToken || !status?.can_manage) return;
    setBusyAction("policy");
    setError(null);
    try {
      const updated = await authedRequest<FederationStatusResponse>(
        "/federation/policy",
        {
          method: "PUT",
          body: JSON.stringify({ mode }),
        }
      );
      setStatus(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update policy.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = ruleDomain.trim().toLowerCase();
    if (!cleaned || !accessToken) return;
    setBusyAction("add-rule");
    setError(null);
    try {
      await authedRequest("/federation/domains", {
        method: "POST",
        body: JSON.stringify({ domain: cleaned, rule: ruleAction }),
      });
      setRuleDomain("");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add domain rule.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRemoveRule = async (domain: string) => {
    if (!accessToken) return;
    setBusyAction(`del-${domain}`);
    setError(null);
    try {
      await authedRequest(`/federation/domains/${encodeURIComponent(domain)}`, {
        method: "DELETE",
      });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove rule.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleProbePeer = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = probeDomain.trim().toLowerCase();
    if (!cleaned || !accessToken) return;
    setBusyAction("probe");
    setError(null);
    try {
      await authedRequest("/federation/peers/probe", {
        method: "POST",
        body: JSON.stringify({ domain: cleaned }),
      });
      setProbeDomain("");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Peer discovery failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryDeadLetters = async () => {
    if (!accessToken) return;
    setBusyAction("retry-dlq");
    setError(null);
    try {
      await authedRequest("/federation/outbox/retry-dead-letters", {
        method: "POST",
      });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry dead letters.");
    } finally {
      setBusyAction(null);
    }
  };

  if (loading && !status) {
    return (
      <div className="py-10 flex items-center justify-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin text-[#00a884]" />
        <span>Loading federation node status...</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-xl p-4 bg-red-500/10 text-red-500 text-xs">
        {error || "Federation status unavailable."}
      </div>
    );
  }

  const peerStatusBadge = (st: string, blocked: boolean) => {
    if (blocked || st === "blocked") {
      return "bg-red-500/15 text-red-400 border-red-500/30";
    }
    if (st === "online") {
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    }
    if (st === "degraded") {
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    }
    return "bg-slate-500/15 text-slate-400 border-slate-500/30";
  };

  return (
    <div className="space-y-4" data-testid="federation-status-section">
      {/* 1. Local Node Identity Card */}
      <div
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="rounded-xl p-4 space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
            <Server className="w-4 h-4" />
            <span>LOCAL NODE IDENTITY</span>
          </div>
          <button
            type="button"
            onClick={loadStatus}
            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition"
            title="Refresh peer status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="text-sm font-semibold font-mono">{status.domain}</div>

        <div className="space-y-1">
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px]"
          >
            Ed25519 Signing Key (`/.well-known/node-key`)
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono px-2.5 py-1.5 rounded-lg bg-black/10 dark:bg-black/25 truncate">
              {status.public_key_ed25519}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(status.public_key_ed25519);
                setCopiedKey(true);
                setTimeout(() => setCopiedKey(false), 1800);
              }}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#00a884]/15 text-[#00a884] hover:bg-[#00a884]/25 transition flex items-center gap-1"
            >
              {copiedKey ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-1 text-center">
          <div className="rounded-lg p-2 bg-black/5 dark:bg-black/20">
            <div className="text-sm font-bold text-[#00a884]">
              {status.peers.length}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[10px]"
            >
              Known Peers
            </div>
          </div>
          <div className="rounded-lg p-2 bg-black/5 dark:bg-black/20">
            <div className="text-sm font-bold">{status.cached_remote_users}</div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[10px]"
            >
              Cached Users
            </div>
          </div>
          <div className="rounded-lg p-2 bg-black/5 dark:bg-black/20">
            <div className="text-sm font-bold">
              {status.outbox_stats.pending} / {status.outbox_stats.dead_letter}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[10px]"
            >
              Queue / Dead
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl p-3 bg-red-500/10 border border-red-500/25 text-red-500 text-xs">
          {error}
        </div>
      )}

      {/* 2. Domain Policy & Allow/Block Controls */}
      <div
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="rounded-xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            <span>DOMAIN POLICY</span>
          </div>
          {!status.can_manage && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-400">
              Read-only
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { id: "open", label: "Open" },
              { id: "denylist", label: "Block-list" },
              { id: "allowlist", label: "Allow-list" },
            ] as const
          ).map((opt) => {
            const active = status.policy_mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={!status.can_manage || busyAction === "policy"}
                onClick={() => handleModeChange(opt.id)}
                data-testid={`fed-mode-${opt.id}`}
                className={`py-2 px-2 rounded-lg text-xs font-semibold border transition ${
                  active
                    ? "bg-[#00a884] text-white border-[#00a884]"
                    : "border-[var(--rc-border)] hover:bg-black/5 dark:hover:bg-white/5"
                } disabled:opacity-60`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {status.can_manage && (
          <form onSubmit={handleAddRule} className="flex flex-col gap-2 pt-1">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={ruleDomain}
                onChange={(e) => setRuleDomain(e.target.value)}
                placeholder="node-b.local"
                data-testid="fed-rule-domain-input"
                style={{
                  backgroundColor: "var(--rc-sidebar-bg)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="flex-1 min-w-0 rounded-lg px-3 py-1.5 text-xs border focus:outline-none focus:border-[#00a884]"
              />
              <select
                value={ruleAction}
                onChange={(e) =>
                  setRuleAction(e.target.value as "allow" | "block")
                }
                style={{
                  backgroundColor: "var(--rc-sidebar-bg)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="rounded-lg px-2 py-1.5 text-xs border"
              >
                <option value="allow">Allow</option>
                <option value="block">Block</option>
              </select>
              <button
                type="submit"
                disabled={!ruleDomain.trim() || busyAction === "add-rule"}
                className="px-2.5 py-1.5 rounded-lg bg-[#00a884] text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Save</span>
              </button>
            </div>
          </form>
        )}

        {status.rules.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {status.rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-black/5 dark:bg-black/20 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {r.rule === "block" ? (
                    <Ban className="w-3.5 h-3.5 text-red-500 shrink-0" />
                  ) : (
                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  )}
                  <span className="font-mono truncate">{r.domain}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold ${
                      r.rule === "block"
                        ? "bg-red-500/15 text-red-400"
                        : "bg-emerald-500/15 text-emerald-400"
                    }`}
                  >
                    {r.rule}
                  </span>
                </div>
                {status.can_manage && (
                  <button
                    type="button"
                    onClick={() => handleRemoveRule(r.domain)}
                    disabled={busyAction === `del-${r.domain}`}
                    className="p-1 text-slate-400 hover:text-red-500 transition"
                    title="Remove rule"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Peer Status Table & Discovery Probe */}
      <div
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="rounded-xl p-4 space-y-3"
      >
        <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
          <Globe className="w-4 h-4" />
          <span>FEDERATED PEER NODES</span>
        </div>

        {status.can_manage && (
          <form onSubmit={handleProbePeer} className="flex gap-1.5">
            <input
              type="text"
              value={probeDomain}
              onChange={(e) => setProbeDomain(e.target.value)}
              placeholder="Probe domain (e.g. node-b.local)"
              style={{
                backgroundColor: "var(--rc-sidebar-bg)",
                color: "var(--rc-text-primary)",
                borderColor: "var(--rc-border)",
              }}
              className="flex-1 min-w-0 rounded-lg px-3 py-1.5 text-xs border focus:outline-none focus:border-[#00a884]"
            />
            <button
              type="submit"
              disabled={!probeDomain.trim() || busyAction === "probe"}
              className="px-3 py-1.5 rounded-lg bg-[#00a884] text-white text-xs font-semibold disabled:opacity-50"
            >
              {busyAction === "probe" ? "Probing..." : "Ping"}
            </button>
          </form>
        )}

        {status.peers.length === 0 ? (
          <p
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-xs py-2"
          >
            No remote nodes discovered yet. Add a contact like{" "}
            <code className="font-mono">bob@node-b.local</code> to federate.
          </p>
        ) : (
          <div className="space-y-2">
            {status.peers.map((peer) => (
              <div
                key={peer.id}
                className="p-2.5 rounded-lg bg-black/5 dark:bg-black/20 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold font-mono truncate">
                    {peer.domain}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border uppercase font-semibold ${peerStatusBadge(
                      peer.status,
                      peer.is_blocked
                    )}`}
                  >
                    {peer.is_blocked ? "blocked" : peer.status}
                  </span>
                </div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-[11px] flex items-center justify-between gap-2"
                >
                  <span className="truncate">{peer.node_url}</span>
                  <span className="shrink-0">
                    Failures: {peer.failure_count}
                  </span>
                </div>
                {peer.last_seen_at && (
                  <div
                    style={{ color: "var(--rc-text-secondary)" }}
                    className="text-[10px]"
                  >
                    Last seen: {new Date(peer.last_seen_at).toLocaleString()}
                  </div>
                )}
                {peer.last_error && (
                  <div className="text-[10px] text-amber-400 truncate">
                    Last error: {peer.last_error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. Outbox Queue & Dead-Letter Controls */}
      <div
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="rounded-xl p-4 space-y-2.5"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
            <Activity className="w-4 h-4" />
            <span>OUTBOX DELIVERY QUEUE</span>
          </div>
          {status.can_manage && status.outbox_stats.dead_letter > 0 && (
            <button
              type="button"
              onClick={handleRetryDeadLetters}
              disabled={busyAction === "retry-dlq"}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 text-[11px] font-semibold flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Retry Dead Letters ({status.outbox_stats.dead_letter})</span>
            </button>
          )}
        </div>

        <div
          style={{ color: "var(--rc-text-secondary)" }}
          className="text-xs flex items-center justify-between"
        >
          <span>Delivered: {status.outbox_stats.delivered}</span>
          <span>Pending Retry: {status.outbox_stats.pending}</span>
          <span className="flex items-center gap-1">
            {status.outbox_stats.dead_letter > 0 && (
              <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
            )}
            Dead-letter: {status.outbox_stats.dead_letter}
          </span>
        </div>
      </div>
    </div>
  );
}
