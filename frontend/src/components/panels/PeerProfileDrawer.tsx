"use client";

import React, { useEffect, useState } from "react";
import {
  Ban,
  Check,
  Globe,
  Lock,
  Pencil,
  ShieldCheck,
  Trash2,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { PeerProfileView } from "@/lib/api/client";
import { computeKeyFingerprint } from "@/lib/crypto/e2ee";
import { MockChat } from "@/mocks";
import { formatLastSeenLabel, useChatStore } from "@/store/useChatStore";

export interface PeerProfileDrawerProps {
  chat: MockChat;
  onClose: () => void;
}

export function PeerProfileDrawer({ chat, onClose }: PeerProfileDrawerProps) {
  const {
    fetchPeerProfile,
    addContactById,
    updateContactNickname,
    removeContact,
    blockUser,
    unblockUser,
    toggleMuteChat,
  } = useChatStore();

  const [profile, setProfile] = useState<PeerProfileView | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [editingNick, setEditingNick] = useState(false);
  const [nickVal, setNickVal] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const target = chat.peerUserId || chat.globalId;
    fetchPeerProfile(target)
      .then((p) => {
        if (!active) return;
        setProfile(p);
        setNickVal(p.nickname || "");
      })
      .catch(() => undefined);

    if (chat.peerPublicKey) {
      computeKeyFingerprint(chat.peerPublicKey)
        .then((fp) => {
          if (active) setFingerprint(fp);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [chat.peerUserId, chat.globalId, chat.peerPublicKey, fetchPeerProfile]);

  const reloadProfile = async () => {
    const target = chat.peerUserId || chat.globalId;
    const fresh = await fetchPeerProfile(target);
    setProfile(fresh);
    setNickVal(fresh.nickname || "");
  };

  const handleAddContact = async () => {
    setBusy(true);
    try {
      await addContactById(chat.globalId, nickVal.trim() || undefined);
      await reloadProfile();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveNickname = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      await updateContactNickname(profile.id, nickVal.trim() || null);
      setEditingNick(false);
      await reloadProfile();
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveContact = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      await removeContact(profile.id);
      await reloadProfile();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleBlock = async () => {
    const targetId = profile?.id || chat.peerUserId;
    if (!targetId) return;
    setBusy(true);
    try {
      if (profile?.is_blocked_by_me ?? chat.isBlockedByMe) {
        await unblockUser(targetId);
      } else {
        await blockUser({ targetUserId: targetId });
      }
      await reloadProfile();
    } finally {
      setBusy(false);
    }
  };

  const isBlocked = profile?.is_blocked_by_me ?? chat.isBlockedByMe ?? false;
  const isContact = profile?.is_contact ?? chat.isContact ?? false;
  const effectiveName = profile?.effective_name || chat.name;
  const rawDisplayName = profile?.display_name || chat.rawDisplayName || chat.name;
  const shownAvatar = profile ? profile.avatar_url || undefined : chat.avatarUrl;
  const isOnline = profile ? profile.is_online : chat.isOnline;
  const lastSeenLabel = profile
    ? formatLastSeenLabel(profile.last_seen_at)
    : chat.lastSeen;

  return (
    <aside
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      data-testid="peer-profile-drawer"
      className="w-full sm:w-[360px] h-full border-l flex flex-col shrink-0 select-none z-20"
    >
      <header
        style={{
          backgroundColor: "var(--rc-header-bg)",
          borderColor: "var(--rc-border)",
        }}
        className="h-[60px] px-4 border-b flex items-center gap-3 shrink-0"
      >
        <button
          type="button"
          onClick={onClose}
          style={{ color: "var(--rc-text-secondary)" }}
          className="p-1.5 -ml-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
          aria-label="Close contact info"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-sm font-semibold">Contact Info</h2>
      </header>

      <div className="flex-1 overflow-y-auto rc-scrollbar p-4 space-y-4">
        {/* Identity Hero */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-2xl p-5 flex flex-col items-center text-center"
        >
          <Avatar
            name={effectiveName}
            src={shownAvatar}
            color={chat.avatarColor}
            size="xl"
            isOnline={isOnline}
            showOnlineDot
          />
          <h3 className="text-lg font-semibold mt-3">{effectiveName}</h3>
          {profile?.nickname && (
            <span
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-xs"
            >
              ~ {rawDisplayName}
            </span>
          )}
          <span className="text-xs font-mono text-[#00a884] inline-flex items-center gap-1 mt-1">
            <Globe className="w-3.5 h-3.5" /> {chat.globalId}
          </span>
          <span
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-xs mt-1"
            data-testid="drawer-presence-label"
          >
            {isOnline ? "online" : lastSeenLabel || "last seen hidden"}
          </span>
        </div>

        {/* About */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-1"
        >
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px] font-semibold uppercase tracking-wider"
          >
            About
          </div>
          <p className="text-sm break-words">
            {(profile ? profile.about : chat.about) || "—"}
          </p>
        </div>

        {/* Contact & Nickname Management */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-2.5"
        >
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px] font-semibold uppercase tracking-wider"
          >
            Address Book
          </div>

          {isContact ? (
            <div className="space-y-2">
              {editingNick ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={nickVal}
                    onChange={(e) => setNickVal(e.target.value)}
                    placeholder="Custom nickname"
                    style={{ color: "var(--rc-text-primary)" }}
                    className="flex-1 bg-transparent border-b-2 border-[#00a884] py-1 text-sm focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleSaveNickname}
                    className="p-1.5 rounded-full text-[#00a884] hover:bg-[#00a884]/10"
                    aria-label="Save nickname"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between text-xs">
                  <span>
                    Nickname:{" "}
                    <strong>{profile?.nickname || "None set"}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingNick(true)}
                    className="text-[#00a884] inline-flex items-center gap-1 font-semibold"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={handleRemoveContact}
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-xs inline-flex items-center gap-1.5 hover:text-red-500 transition"
              >
                <Trash2 className="w-3.5 h-3.5" /> Remove from contacts
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={nickVal}
                onChange={(e) => setNickVal(e.target.value)}
                placeholder="Optional nickname..."
                style={{
                  backgroundColor: "var(--rc-surface-elevated)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:outline-none"
              />
              <button
                type="button"
                disabled={busy}
                onClick={handleAddContact}
                data-testid="drawer-add-contact-button"
                className="w-full py-2 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
              >
                <UserPlus className="w-4 h-4" /> Add to Contacts
              </button>
            </div>
          )}
        </div>

        {/* E2EE Safety Number */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-1.5"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00a884] flex items-center gap-1">
            <Lock className="w-3.5 h-3.5" /> Encryption
          </div>
          <p
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-xs leading-relaxed"
          >
            Messages are end-to-end encrypted. Compare this safety number with{" "}
            {effectiveName}:
          </p>
          {fingerprint && (
            <div className="font-mono text-[11.5px] tracking-wider pt-1 flex items-start gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[#00a884] shrink-0 mt-0.5" />
              <span>{fingerprint}</span>
            </div>
          )}
        </div>

        {/* Mute & Block Actions */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl overflow-hidden divide-y divide-[var(--rc-border)]"
        >
          <button
            type="button"
            onClick={() => toggleMuteChat(chat.id)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-black/5 dark:hover:bg-white/5 transition"
          >
            <span className="flex items-center gap-2.5">
              {chat.isMuted ? (
                <VolumeX className="w-4 h-4 text-amber-500" />
              ) : (
                <Volume2 className="w-4 h-4 text-[#00a884]" />
              )}
              <span>Mute notifications</span>
            </span>
            <span className="text-xs font-semibold text-[#00a884]">
              {chat.isMuted ? "Muted" : "Off"}
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleToggleBlock}
            data-testid="drawer-block-toggle-button"
            className={`w-full px-4 py-3 flex items-center gap-2.5 text-sm font-medium transition ${
              isBlocked
                ? "text-[#00a884] hover:bg-[#00a884]/10"
                : "text-red-500 hover:bg-red-500/10"
            }`}
          >
            <Ban className="w-4 h-4" />
            <span>
              {isBlocked ? `Unblock ${effectiveName}` : `Block ${effectiveName}`}
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
