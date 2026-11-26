"use client";

import React, { useEffect, useState } from "react";
import { CheckCheck, Clock3, Loader2, ShieldCheck, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { useChatStore } from "@/store/useChatStore";

function formatDetailTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageReadByModal() {
  const message = useChatStore((s) => s.readByModalMessage);
  const setReadByModalMessage = useChatStore((s) => s.setReadByModalMessage);
  const fetchMessageReceipts = useChatStore((s) => s.fetchMessageReceipts);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!message || message.id.startsWith("cmsg-")) return;
    let cancelled = false;
    setLoading(true);
    fetchMessageReceipts(message.id).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [message?.id, fetchMessageReceipts]);

  if (!message) return null;

  const readBy = message.readBy || [];
  const readIds = new Set(readBy.map((r) => r.user_id));
  const deliveredOnly = (message.deliveredTo || []).filter(
    (d) => !readIds.has(d.user_id)
  );

  return (
    <div
      data-testid="message-read-by-modal"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={() => setReadByModalMessage(null)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--rc-surface-elevated)",
          borderColor: "var(--rc-border)",
          color: "var(--rc-text-primary)",
        }}
        className="w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[82vh] rc-animate-pop"
      >
        {/* Header */}
        <div
          style={{
            backgroundColor: "var(--rc-header-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="px-4 py-3 border-b flex items-center justify-between"
        >
          <div>
            <h3 className="text-sm font-semibold">Message Info</h3>
            {message.senderKeyVersion && (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-[11px] flex items-center gap-1 mt-0.5"
              >
                <ShieldCheck className="w-3 h-3 text-[#00a884]" />
                Encrypted with Group Sender Key v{message.senderKeyVersion}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setReadByModalMessage(null)}
            style={{ color: "var(--rc-text-secondary)" }}
            className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close message info"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Message Preview */}
        <div
          style={{ backgroundColor: "var(--rc-chat-bg)" }}
          className="px-4 py-3 border-b border-[var(--rc-border)]"
        >
          <div
            style={{
              backgroundColor:
                message.senderId === "me"
                  ? "var(--rc-bubble-out)"
                  : "var(--rc-bubble-in)",
            }}
            className="rounded-lg px-3 py-2 text-xs shadow-xs max-w-[92%] ml-auto"
          >
            <div className="line-clamp-3 break-words">
              {message.text ||
                message.file?.fileName ||
                message.location?.label ||
                "Encrypted attachment"}
            </div>
            <div
              style={{ color: "var(--rc-text-muted)" }}
              className="text-[10px] text-right mt-1"
            >
              {message.timeLabel}
            </div>
          </div>
        </div>

        {/* Read By & Delivered To Lists */}
        <div className="flex-1 overflow-y-auto divide-y divide-[var(--rc-border)]">
          {/* Direct 1:1 Receipt Timestamps */}
          {!message.senderKeyVersion && (
            <div className="p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span style={{ color: "var(--rc-text-secondary)" }}>Sent</span>
                <span className="font-mono">
                  {formatDetailTime(message.timestamp) || message.timeLabel}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: "var(--rc-text-secondary)" }}>
                  Delivered
                </span>
                <span className="font-mono">
                  {message.deliveredAt
                    ? formatDetailTime(message.deliveredAt)
                    : message.status === "delivered" || message.status === "read"
                      ? "Delivered"
                      : "Pending"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#53bdeb] font-medium">Read</span>
                <span className="font-mono">
                  {message.readAt
                    ? formatDetailTime(message.readAt)
                    : message.status === "read"
                      ? "Read"
                      : "—"}
                </span>
              </div>
            </div>
          )}

          {/* Read By Section */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#53bdeb]">
                <CheckCheck className="w-4 h-4" />
                <span>Read by ({readBy.length})</span>
              </div>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
            </div>

            {readBy.length === 0 ? (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-xs italic py-1"
              >
                No one has read this message yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {readBy.map((entry) => (
                  <div
                    key={entry.user_id}
                    className="flex items-center gap-2.5"
                    data-testid="read-by-row"
                  >
                    <Avatar
                      name={entry.display_name}
                      src={entry.avatar_url}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {entry.display_name}
                      </div>
                      <div
                        style={{ color: "var(--rc-text-muted)" }}
                        className="text-[11px] font-mono truncate"
                      >
                        {entry.global_id}
                      </div>
                    </div>
                    <div
                      style={{ color: "var(--rc-text-muted)" }}
                      className="text-[11px] shrink-0"
                    >
                      {formatDetailTime(entry.read_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Delivered To Section */}
          <div className="p-4">
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="flex items-center gap-1.5 text-xs font-semibold mb-2.5"
            >
              <Clock3 className="w-3.5 h-3.5" />
              <span>Delivered to ({deliveredOnly.length})</span>
            </div>

            {deliveredOnly.length === 0 ? (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-xs italic py-1"
              >
                {readBy.length > 0
                  ? "All delivered recipients have read this message."
                  : "Waiting for recipient devices to come online."}
              </p>
            ) : (
              <div className="space-y-2.5">
                {deliveredOnly.map((entry) => (
                  <div key={entry.user_id} className="flex items-center gap-2.5">
                    <Avatar
                      name={entry.display_name}
                      src={entry.avatar_url}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {entry.display_name}
                      </div>
                      <div
                        style={{ color: "var(--rc-text-muted)" }}
                        className="text-[11px] font-mono truncate"
                      >
                        {entry.global_id}
                      </div>
                    </div>
                    <div
                      style={{ color: "var(--rc-text-muted)" }}
                      className="text-[11px] shrink-0"
                    >
                      {formatDetailTime(entry.delivered_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
