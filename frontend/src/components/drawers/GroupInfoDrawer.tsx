"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  Camera,
  Check,
  Copy,
  Crown,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  RefreshCw,
  Shield,
  ShieldCheck,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { LightboxMediaPayload } from "@/components/chat/MessageBubble";
import { Avatar } from "@/components/ui/Avatar";
import { fetchAndDecryptAttachmentBlob } from "@/lib/api/attachments";
import { MockChat, MockMessage } from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

interface GroupInfoDrawerProps {
  open: boolean;
  chat: MockChat | null;
  messages: MockMessage[];
  onClose: () => void;
  onPreviewMedia?: (media: LightboxMediaPayload) => void;
}

const EXTRACT_URLS_REGEX = /https?:\/\/[^\s<>"']+/gi;

export function GroupInfoDrawer({
  open,
  chat,
  messages,
  onClose,
  onPreviewMedia,
}: GroupInfoDrawerProps) {
  const myUserId = useAuthStore((s) => s.user?.id || "");
  const contacts = useChatStore((s) => s.contacts);
  const directoryUsers = useChatStore((s) => s.directoryUsers);
  const toggleMuteChat = useChatStore((s) => s.toggleMuteChat);
  const updateGroupInfoAndSettings = useChatStore((s) => s.updateGroupInfoAndSettings);
  const uploadGroupIcon = useChatStore((s) => s.uploadGroupIcon);
  const addGroupMembers = useChatStore((s) => s.addGroupMembers);
  const removeGroupMember = useChatStore((s) => s.removeGroupMember);
  const setGroupMemberRole = useChatStore((s) => s.setGroupMemberRole);
  const revokeGroupInvite = useChatStore((s) => s.revokeGroupInvite);
  const leaveGroup = useChatStore((s) => s.leaveGroup);

  const [editingInfo, setEditingInfo] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [addingMemberOpen, setAddingMemberOpen] = useState(false);
  const [memberFilter, setMemberFilter] = useState("");
  const [activeAssetTab, setActiveAssetTab] = useState<"media" | "docs" | "links">(
    "media"
  );
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const iconFileRef = useRef<HTMLInputElement | null>(null);

  const sharedAssets = useMemo(() => {
    const mediaItems: MockMessage[] = [];
    const docItems: MockMessage[] = [];
    const linkItems: { url: string; senderName: string; timeLabel: string; msgId: string }[] =
      [];

    for (const m of messages) {
      if (m.deletedForEveryone || m.decryptionError || m.type === "system") continue;
      if (m.type === "image" && m.image) {
        mediaItems.push(m);
      } else if (m.type === "file" && m.file) {
        docItems.push(m);
      }
      if (m.text) {
        const urls = m.text.match(EXTRACT_URLS_REGEX) || [];
        for (const u of urls) {
          linkItems.push({
            url: u,
            senderName: m.senderName,
            timeLabel: m.timeLabel,
            msgId: m.id,
          });
        }
      }
    }
    return {
      mediaItems: mediaItems.reverse(),
      docItems: docItems.reverse(),
      linkItems: linkItems.reverse(),
    };
  }, [messages]);

  if (!open || !chat || !chat.isGroup) return null;

  const isAdmin = chat.myRole === "admin";
  const canEditInfo = !chat.onlyAdminsCanEditInfo || isAdmin;
  const members = chat.groupMembers || [];
  const memberIdSet = new Set(members.map((m) => m.user_id));

  const addableUsers = (() => {
    const map = new Map<string, { id: string; name: string; globalId: string; avatarUrl: string | null }>();
    for (const c of contacts) {
      if (!memberIdSet.has(c.user.id)) {
        map.set(c.user.id, {
          id: c.user.id,
          name: c.user.effective_name,
          globalId: c.user.global_id,
          avatarUrl: c.user.avatar_url,
        });
      }
    }
    for (const u of directoryUsers) {
      if (!memberIdSet.has(u.id) && !map.has(u.id)) {
        map.set(u.id, {
          id: u.id,
          name: u.effective_name,
          globalId: u.global_id,
          avatarUrl: u.avatar_url,
        });
      }
    }
    const q = memberFilter.trim().toLowerCase();
    return Array.from(map.values()).filter(
      (x) =>
        !q ||
        x.name.toLowerCase().includes(q) ||
        x.globalId.toLowerCase().includes(q)
    );
  })();

  const inviteUrl =
    chat.inviteCode && typeof window !== "undefined"
      ? `${window.location.origin}/?join=${chat.inviteCode}`
      : chat.inviteCode
        ? `/?join=${chat.inviteCode}`
        : "";

  const startEditInfo = () => {
    setDraftName(chat.name);
    setDraftDescription(chat.description || chat.about || "");
    setEditingInfo(true);
  };

  const handleSaveInfo = async () => {
    if (!draftName.trim()) return;
    setBusyAction("save-info");
    setFeedback(null);
    try {
      await updateGroupInfoAndSettings(chat.id, {
        name: draftName.trim(),
        description: draftDescription.trim(),
      });
      setEditingInfo(false);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not update group info.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleUploadIcon = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusyAction("icon");
    setFeedback(null);
    try {
      await uploadGroupIcon(chat.id, f);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Failed to update group icon.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleRevokeInvite = async () => {
    setBusyAction("revoke");
    setFeedback(null);
    try {
      await revokeGroupInvite(chat.id);
      setFeedback("Previous invite link revoked and replaced.");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Failed to revoke invite link.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddSingleMember = async (userId: string) => {
    setBusyAction(`add-${userId}`);
    setFeedback(null);
    try {
      await addGroupMembers(chat.id, [userId]);
      setFeedback("Member added & Group Sender Key rotated.");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not add member.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setBusyAction(`rem-${userId}`);
    setFeedback(null);
    try {
      await removeGroupMember(chat.id, userId);
      setFeedback("Member removed & fresh Sender Key rotated for remaining members.");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not remove member.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleAdmin = async (userId: string, currentRole: "admin" | "member") => {
    const nextRole = currentRole === "admin" ? "member" : "admin";
    setBusyAction(`role-${userId}`);
    setFeedback(null);
    try {
      await setGroupMemberRole(chat.id, userId, nextRole);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not change role.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleLeave = async () => {
    setBusyAction("leave");
    try {
      await leaveGroup(chat.id);
      onClose();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not leave group.");
      setBusyAction(null);
    }
  };

  return (
    <aside
      data-testid="group-info-drawer"
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
        color: "var(--rc-text-primary)",
      }}
      className="w-full sm:w-[380px] shrink-0 border-l flex flex-col h-full z-30 overflow-hidden"
    >
      {/* Top Bar */}
      <div
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
          className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Close group info"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="font-semibold text-sm">Group Info</h2>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-[var(--rc-border)]">
        {/* Hero Card: Icon, Name, Description, Key Version */}
        <div className="p-5 flex flex-col items-center text-center">
          <input
            ref={iconFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleUploadIcon}
            className="hidden"
          />
          <div className="relative group mb-3">
            <Avatar
              name={chat.name}
              color={chat.avatarColor}
              src={chat.avatarUrl}
              isGroup
              size="xl"
            />
            {canEditInfo && (
              <button
                type="button"
                onClick={() => iconFileRef.current?.click()}
                className="absolute inset-0 rounded-full bg-black/45 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center transition"
                title="Change group icon"
              >
                {busyAction === "icon" ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Camera className="w-5 h-5" />
                )}
              </button>
            )}
          </div>

          {editingInfo ? (
            <div className="w-full space-y-2 text-left mt-1">
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={120}
                style={{
                  backgroundColor: "var(--rc-input-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full px-3 py-1.5 rounded-lg border text-sm font-semibold focus:outline-none focus:border-[#00a884]"
              />
              <textarea
                rows={2}
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                maxLength={500}
                placeholder="Add group description..."
                style={{
                  backgroundColor: "var(--rc-input-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full px-3 py-1.5 rounded-lg border text-xs resize-none focus:outline-none focus:border-[#00a884]"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingInfo(false)}
                  className="px-3 py-1 rounded-lg text-xs opacity-75 hover:opacity-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveInfo}
                  disabled={busyAction === "save-info"}
                  className="px-3 py-1 rounded-lg bg-[#00a884] text-white text-xs font-semibold"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <h3 className="text-base font-semibold">{chat.name}</h3>
                {canEditInfo && (
                  <button
                    type="button"
                    onClick={startEditInfo}
                    style={{ color: "var(--rc-text-muted)" }}
                    className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
                    title="Edit group name & description"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <p
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-xs mt-0.5"
              >
                Group • {chat.memberCount || members.length} members
              </p>
              {(chat.description || chat.about) && (
                <p
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs mt-2 max-w-xs leading-relaxed"
                >
                  {chat.description || chat.about}
                </p>
              )}
            </>
          )}

          <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00a884]/12 text-[#00a884] text-[11px] font-medium">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Sender Keys E2EE • Key v{chat.keyVersion || 1}</span>
          </div>
        </div>

        {feedback && (
          <div className="px-4 py-2.5 text-xs bg-[#00a884]/10 text-[#00a884] font-medium">
            {feedback}
          </div>
        )}

        {/* Mute & Group Permissions */}
        <div className="p-4 space-y-3 text-xs">
          <button
            type="button"
            onClick={() => toggleMuteChat(chat.id)}
            className="w-full flex items-center justify-between py-1"
          >
            <span className="flex items-center gap-2.5 font-medium">
              {chat.isMuted ? (
                <BellOff className="w-4 h-4 text-amber-500" />
              ) : (
                <Bell className="w-4 h-4 text-[#00a884]" />
              )}
              Mute notifications
            </span>
            <span
              className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                chat.isMuted
                  ? "bg-amber-500/15 text-amber-500"
                  : "bg-black/5 dark:bg-white/10"
              }`}
            >
              {chat.isMuted ? "Muted" : "Off"}
            </span>
          </button>

          <div className="pt-2 border-t border-[var(--rc-border)] space-y-2.5">
            <div
              style={{ color: "var(--rc-text-muted)" }}
              className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
            >
              <Shield className="w-3.5 h-3.5" /> Group Permissions
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <span>Only admins can edit group info</span>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={Boolean(chat.onlyAdminsCanEditInfo)}
                onChange={(e) =>
                  updateGroupInfoAndSettings(chat.id, {
                    only_admins_can_edit_info: e.target.checked,
                  }).catch(() => undefined)
                }
                className="accent-[#00a884] w-4 h-4"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span>Only admins can send messages</span>
              <input
                type="checkbox"
                disabled={!isAdmin}
                data-testid="toggle-only-admins-send"
                checked={Boolean(chat.onlyAdminsCanSend)}
                onChange={(e) =>
                  updateGroupInfoAndSettings(chat.id, {
                    only_admins_can_send: e.target.checked,
                  }).catch(() => undefined)
                }
                className="accent-[#00a884] w-4 h-4"
              />
            </label>
          </div>
        </div>

        {/* Invite Link Section */}
        {chat.inviteCode && (
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-[#00a884]" /> Invite via Link
              </span>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleRevokeInvite}
                  disabled={busyAction === "revoke"}
                  data-testid="revoke-invite-btn"
                  className="text-[11px] text-red-500 hover:underline flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Revoke link
                </button>
              )}
            </div>
            <div
              style={{
                backgroundColor: "var(--rc-input-bg)",
                borderColor: "var(--rc-border)",
              }}
              className="flex items-center gap-2 px-2.5 py-2 rounded-xl border"
            >
              <span className="flex-1 text-[11px] font-mono truncate">{inviteUrl}</span>
              <button
                type="button"
                onClick={handleCopyInvite}
                className="px-2 py-1 rounded-lg bg-[#00a884] text-white text-[11px] font-semibold flex items-center gap-1 shrink-0"
              >
                {copiedInvite ? (
                  <>
                    <Check className="w-3 h-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" /> Copy
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Shared Media, Links, and Docs Tabs */}
        <div className="p-4">
          <div className="grid grid-cols-3 gap-1 rounded-xl p-1 bg-black/5 dark:bg-white/5 text-xs font-semibold mb-3">
            <button
              type="button"
              onClick={() => setActiveAssetTab("media")}
              className={`py-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                activeAssetTab === "media"
                  ? "bg-[#00a884] text-white"
                  : "opacity-75 hover:opacity-100"
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Media ({sharedAssets.mediaItems.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveAssetTab("docs")}
              className={`py-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                activeAssetTab === "docs"
                  ? "bg-[#00a884] text-white"
                  : "opacity-75 hover:opacity-100"
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Docs ({sharedAssets.docItems.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveAssetTab("links")}
              className={`py-1.5 rounded-lg flex items-center justify-center gap-1 transition ${
                activeAssetTab === "links"
                  ? "bg-[#00a884] text-white"
                  : "opacity-75 hover:opacity-100"
              }`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Links ({sharedAssets.linkItems.length})
            </button>
          </div>

          {activeAssetTab === "media" &&
            (sharedAssets.mediaItems.length === 0 ? (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-xs text-center py-3"
              >
                No encrypted photos or videos shared yet.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {sharedAssets.mediaItems.slice(0, 9).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={async () => {
                      if (!m.image || !onPreviewMedia) return;
                      let url = m.image.thumbDataUrl || m.image.dataUrl;
                      if (m.image.encryptedRef) {
                        const res = await fetchAndDecryptAttachmentBlob(
                          m.image.encryptedRef
                        );
                        url = res.url;
                      }
                      if (url) {
                        onPreviewMedia({
                          url,
                          fileName: m.image.fileName || "media",
                          caption: m.image.caption,
                          isVideo: m.image.isVideo,
                          mimeType: m.image.mimeType,
                        });
                      }
                    }}
                    className="aspect-square rounded-lg overflow-hidden bg-black/15 relative"
                  >
                    {(m.image?.thumbDataUrl || m.image?.dataUrl) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.image.thumbDataUrl || m.image.dataUrl}
                        alt={m.image.fileName || "Shared media"}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </button>
                ))}
              </div>
            ))}

          {activeAssetTab === "docs" &&
            (sharedAssets.docItems.length === 0 ? (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-xs text-center py-3"
              >
                No encrypted documents shared yet.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {sharedAssets.docItems.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={async () => {
                      if (!m.file?.encryptedRef) return;
                      const res = await fetchAndDecryptAttachmentBlob(
                        m.file.encryptedRef
                      );
                      const a = document.createElement("a");
                      a.href = res.url;
                      a.download = m.file.fileName;
                      a.click();
                    }}
                    className="w-full px-2.5 py-2 rounded-lg bg-black/5 dark:bg-white/5 flex items-center gap-2 text-left text-xs hover:opacity-85"
                  >
                    <FileText className="w-4 h-4 text-[#00a884] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{m.file?.fileName}</div>
                      <div
                        style={{ color: "var(--rc-text-muted)" }}
                        className="text-[10px]"
                      >
                        {m.file?.fileSize} • {m.senderName}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ))}

          {activeAssetTab === "links" &&
            (sharedAssets.linkItems.length === 0 ? (
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-xs text-center py-3"
              >
                No links shared in this group yet.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {sharedAssets.linkItems.map((item, i) => (
                  <a
                    key={`${item.msgId}-${i}`}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-2.5 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-xs hover:opacity-85"
                  >
                    <div className="text-[#027eb5] dark:text-[#53bdeb] truncate underline">
                      {item.url}
                    </div>
                    <div
                      style={{ color: "var(--rc-text-muted)" }}
                      className="text-[10px] mt-0.5"
                    >
                      Shared by {item.senderName} • {item.timeLabel}
                    </div>
                  </a>
                ))}
              </div>
            ))}
        </div>

        {/* Members Roster */}
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">
              {members.length} {members.length === 1 ? "Member" : "Members"}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setAddingMemberOpen((v) => !v)}
                data-testid="toggle-add-member-btn"
                className="text-xs font-semibold text-[#00a884] flex items-center gap-1 hover:underline"
              >
                <UserPlus className="w-3.5 h-3.5" /> Add member
              </button>
            )}
          </div>

          {isAdmin && addingMemberOpen && (
            <div
              style={{
                backgroundColor: "var(--rc-input-bg)",
                borderColor: "var(--rc-border)",
              }}
              className="rounded-xl border p-2.5 space-y-2"
            >
              <input
                type="text"
                value={memberFilter}
                onChange={(e) => setMemberFilter(e.target.value)}
                placeholder="Filter users to add..."
                className="w-full bg-transparent text-xs px-1.5 py-1 border-b border-[var(--rc-border)] focus:outline-none"
              />
              <div className="max-h-36 overflow-y-auto space-y-1">
                {addableUsers.length === 0 ? (
                  <div
                    style={{ color: "var(--rc-text-muted)" }}
                    className="text-[11px] py-1.5 text-center"
                  >
                    Everyone in directory is already in this group.
                  </div>
                ) : (
                  addableUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between px-1.5 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{u.name}</div>
                        <div
                          style={{ color: "var(--rc-text-muted)" }}
                          className="text-[10px] font-mono truncate"
                        >
                          {u.globalId}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busyAction === `add-${u.id}`}
                        onClick={() => handleAddSingleMember(u.id)}
                        className="px-2 py-1 rounded-lg bg-[#00a884] text-white text-[11px] font-semibold"
                      >
                        Add
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="space-y-2">
            {members.map((m) => {
              const isSelf = m.user_id === myUserId;
              return (
                <div
                  key={m.user_id}
                  data-testid={`group-member-${m.username}`}
                  className="flex items-center gap-2.5 py-1"
                >
                  <Avatar
                    name={m.display_name}
                    color={m.sender_color}
                    src={m.avatar_url}
                    isOnline={m.is_online}
                    showOnlineDot
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-xs font-semibold truncate"
                        style={{ color: isSelf ? undefined : m.sender_color }}
                      >
                        {isSelf ? `${m.display_name} (You)` : m.display_name}
                      </span>
                      {m.role === "admin" && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.2 rounded bg-[#00a884]/15 text-[#00a884] font-semibold">
                          <Crown className="w-2.5 h-2.5" /> Admin
                        </span>
                      )}
                    </div>
                    <div
                      style={{ color: "var(--rc-text-muted)" }}
                      className="text-[11px] font-mono truncate"
                    >
                      {m.global_id}
                    </div>
                  </div>

                  {isAdmin && !isSelf && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleAdmin(m.user_id, m.role)}
                        disabled={busyAction === `role-${m.user_id}`}
                        title={
                          m.role === "admin" ? "Dismiss as admin" : "Make group admin"
                        }
                        className="px-1.5 py-1 rounded text-[10px] font-medium bg-black/5 dark:bg-white/10 hover:opacity-85"
                      >
                        {m.role === "admin" ? "Demote" : "Make Admin"}
                      </button>
                      <button
                        type="button"
                        data-testid={`remove-member-${m.username}`}
                        onClick={() => handleRemoveMember(m.user_id)}
                        disabled={busyAction === `rem-${m.user_id}`}
                        title="Remove from group & rotate keys"
                        className="p-1 rounded text-red-500 hover:bg-red-500/10"
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Exit Group */}
        <div className="p-4">
          <button
            type="button"
            onClick={handleLeave}
            disabled={busyAction === "leave"}
            data-testid="leave-group-btn"
            className="w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/15 text-red-500 font-semibold text-xs flex items-center justify-center gap-2 transition"
          >
            <LogOut className="w-4 h-4" />
            <span>Exit Group</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
