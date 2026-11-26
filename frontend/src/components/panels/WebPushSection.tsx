"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, Loader2, ShieldCheck, Send } from "lucide-react";
import {
  PushSubscriptionRecord,
  subscribeBrowserWebPush,
  unsubscribeBrowserWebPush,
} from "@/lib/push/webPushClient";
import { useAuthStore } from "@/store/useAuthStore";

export function WebPushSection() {
  const { accessToken, authedRequest } = useAuthStore();
  const [subs, setSubs] = useState<PushSubscriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSubs = useCallback(async () => {
    if (!accessToken) return;
    try {
      const data = await authedRequest<PushSubscriptionRecord[]>(
        "/push/subscriptions"
      );
      setSubs(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [accessToken, authedRequest]);

  useEffect(() => {
    loadSubs();
  }, [loadSubs]);

  const activeSub = subs[0] || null;

  const handleEnablePush = async (localDecrypt: boolean) => {
    setBusy(true);
    setFeedback(null);
    try {
      await subscribeBrowserWebPush(localDecrypt);
      await loadSubs();
      setFeedback("Web Push enabled on this browser.");
    } catch (err) {
      setFeedback(
        err instanceof Error ? err.message : "Could not enable Web Push."
      );
    } finally {
      setBusy(false);
    }
  };

  const handleToggleLocalDecrypt = async () => {
    if (!activeSub) return;
    setBusy(true);
    setFeedback(null);
    try {
      await authedRequest(`/push/subscriptions/${activeSub.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          local_decrypt_enabled: !activeSub.local_decrypt_enabled,
        }),
      });
      await loadSubs();
    } finally {
      setBusy(false);
    }
  };

  const handleDisablePush = async () => {
    if (!activeSub) return;
    setBusy(true);
    setFeedback(null);
    try {
      await unsubscribeBrowserWebPush(activeSub.id);
      await loadSubs();
      setFeedback("Web Push unsubscribed on this device.");
    } finally {
      setBusy(false);
    }
  };

  const handleSendTestPush = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await authedRequest("/push/test", { method: "POST" });
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification("RelayChat", { body: "New message" });
      }
      setFeedback("Dispatched E2EE-safe VAPID push payload ('New message').");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Test push failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "var(--rc-panel-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="rounded-xl border p-3.5 space-y-3"
      data-testid="web-push-section"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-[#00a884]" />
          <span
            style={{ color: "var(--rc-text-primary)" }}
            className="text-sm font-semibold"
          >
            Web Push (VAPID)
          </span>
        </div>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-[#00a884]" />
        ) : activeSub ? (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Active
          </span>
        ) : (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400">
            Off
          </span>
        )}
      </div>

      <p
        style={{ color: "var(--rc-text-secondary)" }}
        className="text-xs leading-relaxed"
      >
        Because messages are end-to-end encrypted, push notifications show{" "}
        <strong>&ldquo;New message&rdquo;</strong> only unless you opt into local
        Service Worker decryption on this device.
      </p>

      {!activeSub ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => handleEnablePush(false)}
          data-testid="enable-web-push-btn"
          className="w-full py-2 rounded-lg bg-[#00a884] hover:bg-[#009675] text-white text-xs font-semibold flex items-center justify-center gap-1.5"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Bell className="w-3.5 h-3.5" />
          )}
          Enable Background Web Push
        </button>
      ) : (
        <div className="space-y-2.5">
          <label className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-black/5 dark:bg-white/5 cursor-pointer">
            <div className="min-w-0">
              <div
                style={{ color: "var(--rc-text-primary)" }}
                className="text-xs font-medium flex items-center gap-1.5"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-[#00a884]" />
                Decrypt preview locally in Service Worker
              </div>
              <div
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-[11px]"
              >
                {activeSub.local_decrypt_enabled
                  ? "Service Worker decrypts 1:1 previews via IndexedDB key"
                  : "Strict mode: displays 'New message' only"}
              </div>
            </div>
            <input
              type="checkbox"
              checked={activeSub.local_decrypt_enabled}
              disabled={busy}
              onChange={handleToggleLocalDecrypt}
              className="accent-[#00a884]"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleSendTestPush}
              className="flex-1 py-1.5 rounded-lg bg-[#00a884]/15 hover:bg-[#00a884]/25 text-[#00a884] text-xs font-medium flex items-center justify-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" /> Test Push
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDisablePush}
              className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 text-xs font-medium flex items-center gap-1"
            >
              <BellOff className="w-3.5 h-3.5" /> Disable
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div className="text-[11px] text-[#00a884] font-medium">{feedback}</div>
      )}
    </div>
  );
}
