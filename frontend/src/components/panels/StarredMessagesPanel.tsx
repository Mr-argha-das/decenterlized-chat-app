"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Search, Star, StarOff } from "lucide-react";
import { DecryptedStarredEntry, useChatStore } from "@/store/useChatStore";

export interface StarredMessagesPanelProps {
  onBack: () => void;
  onJumpToChatMessage: (chatId: string, messageId: string) => void;
}

export function StarredMessagesPanel({
  onBack,
  onJumpToChatMessage,
}: StarredMessagesPanelProps) {
  const { fetchStarredMessages, toggleStarMessage } = useChatStore();
  const [items, setItems] = useState<DecryptedStarredEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchStarredMessages();
      setItems(list);
    } finally {
      setLoading(false);
    }
  }, [fetchStarredMessages]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        (it.message.text || "").toLowerCase().includes(q) ||
        it.chatName.toLowerCase().includes(q) ||
        it.message.senderName.toLowerCase().includes(q)
    );
  }, [items, query]);

  const handleUnstar = async (chatId: string, messageId: string) => {
    await toggleStarMessage(chatId, messageId);
    setItems((prev) => prev.filter((x) => x.message.id !== messageId));
  };

  return (
    <aside
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="w-full h-full flex flex-col border-r select-none"
      data-testid="starred-messages-panel"
    >
      <header
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="h-[60px] px-4 flex items-center gap-3 shrink-0"
      >
        <button
          type="button"
          onClick={onBack}
          style={{ color: "var(--rc-text-primary)" }}
          className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2
            style={{ color: "var(--rc-text-primary)" }}
            className="text-base font-semibold leading-tight"
          >
            Starred Messages
          </h2>
          <p
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px]"
          >
            Decrypted locally on your device
          </p>
        </div>
      </header>

      <div className="p-3 border-b" style={{ borderColor: "var(--rc-border)" }}>
        <div
          style={{ backgroundColor: "var(--rc-input-bg)" }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
        >
          <Search
            style={{ color: "var(--rc-text-muted)" }}
            className="w-4 h-4 shrink-0"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search starred messages..."
            style={{ color: "var(--rc-text-primary)" }}
            className="w-full bg-transparent text-xs focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {loading ? (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-[#00a884]" />
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{ color: "var(--rc-text-muted)" }}
            className="py-16 text-center text-xs flex flex-col items-center gap-2"
          >
            <Star className="w-8 h-8 opacity-40" />
            <span>No starred messages found.</span>
          </div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.message.id}
              style={{
                backgroundColor: "var(--rc-panel-bg)",
                borderColor: "var(--rc-border)",
              }}
              className="p-3 rounded-xl border space-y-1.5 hover:border-[#00a884]/40 transition"
            >
              <div className="flex items-center justify-between text-[11px]">
                <span
                  style={{ color: "var(--rc-text-primary)" }}
                  className="font-semibold truncate"
                >
                  {entry.message.senderName} → {entry.chatName}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span style={{ color: "var(--rc-text-muted)" }}>
                    {entry.message.timeLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleUnstar(entry.chatId, entry.message.id)}
                    className="text-amber-400 hover:text-rose-400"
                    title="Unstar"
                  >
                    <StarOff className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  onJumpToChatMessage(entry.chatId, entry.message.id)
                }
                style={{ color: "var(--rc-text-secondary)" }}
                className="w-full text-left text-xs line-clamp-3 break-words"
              >
                {entry.message.text ||
                  (entry.message.file
                    ? `📄 ${entry.message.file.fileName}`
                    : entry.message.image
                      ? `📷 ${entry.message.image.fileName}`
                      : "Encrypted media")}
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
