"use client";

import React, { useMemo, useState } from "react";
import { CornerUpRight, Loader2, Lock, Search } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { useChatStore } from "@/store/useChatStore";

export function ForwardMessageModal() {
  const {
    chats,
    forwardModalMessage,
    setForwardModalMessage,
    forwardMessageToChat,
    selectChat,
  } = useChatStore();

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chats.filter((c) => {
      if (c.isBlockedByMe || c.removedFromGroup) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) || c.globalId.toLowerCase().includes(q)
      );
    });
  }, [chats, query]);

  if (!forwardModalMessage) return null;

  const handleForward = async (targetChatId: string) => {
    setBusyId(targetChatId);
    try {
      await forwardMessageToChat(forwardModalMessage, targetChatId);
      await selectChat(targetChatId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      open={!!forwardModalMessage}
      onClose={() => setForwardModalMessage(null)}
      title="Forward Encrypted Message"
    >
      <div className="space-y-3">
        <p
          style={{ color: "var(--rc-text-secondary)" }}
          className="text-xs flex items-center gap-1.5"
        >
          <Lock className="w-3.5 h-3.5 text-[#00a884] shrink-0" />
          Re-encrypted freshly on your device for the selected recipient or group.
        </p>

        <div
          style={{ backgroundColor: "var(--rc-input-bg)" }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <Search
            style={{ color: "var(--rc-text-muted)" }}
            className="w-4 h-4 shrink-0"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats or groups..."
            style={{ color: "var(--rc-text-primary)" }}
            className="w-full bg-transparent text-sm focus:outline-none"
          />
        </div>

        <div className="max-h-64 overflow-y-auto space-y-1">
          {candidates.map((c) => (
            <div
              key={c.id}
              className="px-2.5 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar
                  name={c.name}
                  src={c.avatarUrl}
                  color={c.avatarColor}
                  isGroup={c.isGroup}
                  size="sm"
                />
                <div className="min-w-0">
                  <div
                    style={{ color: "var(--rc-text-primary)" }}
                    className="text-sm font-medium truncate"
                  >
                    {c.name}
                  </div>
                  <div
                    style={{ color: "var(--rc-text-secondary)" }}
                    className="text-[11px] font-mono truncate"
                  >
                    {c.globalId}
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => handleForward(c.id)}
                className="px-3 py-1.5 rounded-lg bg-[#00a884] hover:bg-[#009675] text-white text-xs font-semibold flex items-center gap-1 shrink-0 disabled:opacity-50"
              >
                {busyId === c.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CornerUpRight className="w-3.5 h-3.5" />
                )}
                Send
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
