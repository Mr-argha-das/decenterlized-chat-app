"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  Link2,
  Loader2,
  Lock,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { ApiGroupInvitePreview, PeerProfileView } from "@/lib/api/client";
import { useChatStore } from "@/store/useChatStore";

interface CreateGroupModalProps {
  open: boolean;
  initialMode?: "create" | "join";
  initialInviteCode?: string;
  onClose: () => void;
}

export function CreateGroupModal({
  open,
  initialMode = "create",
  initialInviteCode = "",
  onClose,
}: CreateGroupModalProps) {
  const contacts = useChatStore((s) => s.contacts);
  const directoryUsers = useChatStore((s) => s.directoryUsers);
  const searchDirectoryUsers = useChatStore((s) => s.searchDirectoryUsers);
  const createGroup = useChatStore((s) => s.createGroup);
  const previewGroupInvite = useChatStore((s) => s.previewGroupInvite);
  const joinGroupByInviteCode = useChatStore((s) => s.joinGroupByInviteCode);

  const [mode, setMode] = useState<"create" | "join">(initialMode);
  const [groupName, setGroupName] = useState("");
  const [description, setDescription] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<PeerProfileView[]>([]);
  const [onlyAdminsCanSend, setOnlyAdminsCanSend] = useState(false);
  const [onlyAdminsCanEditInfo, setOnlyAdminsCanEditInfo] = useState(true);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null);

  // Invite link join state
  const [inviteInput, setInviteInput] = useState(initialInviteCode);
  const [invitePreview, setInvitePreview] = useState<ApiGroupInvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iconInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(initialInviteCode ? "join" : initialMode);
    if (initialInviteCode) {
      setInviteInput(initialInviteCode);
    }
    searchDirectoryUsers("").catch(() => undefined);
  }, [open, initialMode, initialInviteCode, searchDirectoryUsers]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      searchDirectoryUsers(memberSearch).catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [memberSearch, open, searchDirectoryUsers]);

  useEffect(() => {
    if (!open || mode !== "join" || !inviteInput.trim()) {
      setInvitePreview(null);
      return;
    }
    const timer = setTimeout(() => {
      previewGroupInvite(inviteInput)
        .then((p) => {
          setInvitePreview(p);
          setError(null);
        })
        .catch(() => setInvitePreview(null));
    }, 260);
    return () => clearTimeout(timer);
  }, [inviteInput, mode, open, previewGroupInvite]);

  const candidateUsers = useMemo(() => {
    const byId = new Map<string, PeerProfileView>();
    for (const c of contacts) {
      byId.set(c.user.id, c.user);
    }
    for (const u of directoryUsers) {
      if (!byId.has(u.id)) byId.set(u.id, u);
    }
    const q = memberSearch.trim().toLowerCase();
    return Array.from(byId.values()).filter((u) => {
      if (!q) return true;
      return (
        u.effective_name.toLowerCase().includes(q) ||
        u.display_name.toLowerCase().includes(q) ||
        u.global_id.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q)
      );
    });
  }, [contacts, directoryUsers, memberSearch]);

  if (!open) return null;

  const toggleSelectUser = (u: PeerProfileView) => {
    setSelectedUsers((prev) =>
      prev.some((x) => x.id === u.id)
        ? prev.filter((x) => x.id !== u.id)
        : [...prev, u]
    );
  };

  const handleIconPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setIconFile(f);
    setIconPreviewUrl(URL.createObjectURL(f));
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      setError("Please enter a group name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createGroup({
        name: groupName.trim(),
        description: description.trim(),
        memberIds: selectedUsers.map((u) => u.id),
        onlyAdminsCanSend,
        onlyAdminsCanEditInfo,
        iconFile,
      });
      setGroupName("");
      setDescription("");
      setSelectedUsers([]);
      setIconFile(null);
      setIconPreviewUrl(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group.");
    } finally {
      setBusy(false);
    }
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) {
      setError("Paste a group invite link or invite code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await joinGroupByInviteCode(inviteInput);
      setInviteInput("");
      setInvitePreview(null);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid or revoked group invite link."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="create-group-modal"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--rc-surface-elevated)",
          borderColor: "var(--rc-border)",
          color: "var(--rc-text-primary)",
        }}
        className="w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[88vh] rc-animate-pop"
      >
        {/* Modal Header */}
        <div
          style={{
            backgroundColor: "var(--rc-header-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="px-5 py-3.5 border-b flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center justify-center">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">End-to-End Encrypted Groups</h2>
              <p
                style={{ color: "var(--rc-text-muted)" }}
                className="text-[11px] flex items-center gap-1"
              >
                <ShieldCheck className="w-3 h-3 text-[#00a884]" />
                Sender Keys + Pairwise ECDH Key Wrapping
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{ color: "var(--rc-text-secondary)" }}
            className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="grid grid-cols-2 border-b border-[var(--rc-border)] text-xs font-semibold">
          <button
            type="button"
            onClick={() => {
              setMode("create");
              setError(null);
            }}
            className={`py-2.5 flex items-center justify-center gap-1.5 border-b-2 transition ${
              mode === "create"
                ? "border-[#00a884] text-[#00a884]"
                : "border-transparent opacity-70 hover:opacity-100"
            }`}
          >
            <Users className="w-3.5 h-3.5" /> Create Group
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("join");
              setError(null);
            }}
            className={`py-2.5 flex items-center justify-center gap-1.5 border-b-2 transition ${
              mode === "join"
                ? "border-[#00a884] text-[#00a884]"
                : "border-transparent opacity-70 hover:opacity-100"
            }`}
          >
            <Link2 className="w-3.5 h-3.5" /> Join via Invite Link
          </button>
        </div>

        {mode === "create" ? (
          <form onSubmit={handleCreateSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Group Icon + Name + Description */}
            <div className="flex items-start gap-3.5">
              <input
                ref={iconInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleIconPicked}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => iconInputRef.current?.click()}
                className="relative w-14 h-14 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center justify-center shrink-0 overflow-hidden border border-[#00a884]/30 hover:opacity-90 transition"
                title="Upload group icon"
              >
                {iconPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={iconPreviewUrl}
                    alt="Group icon"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Camera className="w-5 h-5" />
                )}
              </button>

              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  data-testid="group-name-input"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Group subject (e.g., Jaipur Launch Crew)"
                  maxLength={120}
                  style={{
                    backgroundColor: "var(--rc-input-bg)",
                    borderColor: "var(--rc-border)",
                  }}
                  className="w-full px-3 py-2 rounded-xl border text-sm focus:outline-none focus:border-[#00a884]"
                />
                <input
                  type="text"
                  data-testid="group-description-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional group description"
                  maxLength={500}
                  style={{
                    backgroundColor: "var(--rc-input-bg)",
                    borderColor: "var(--rc-border)",
                  }}
                  className="w-full px-3 py-1.5 rounded-xl border text-xs focus:outline-none focus:border-[#00a884]"
                />
              </div>
            </div>

            {/* Selected Member Chips */}
            {selectedUsers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedUsers.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#00a884]/15 text-[#00a884] text-xs font-medium"
                  >
                    <span>{u.effective_name}</span>
                    <button
                      type="button"
                      onClick={() => toggleSelectUser(u)}
                      className="hover:opacity-75"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Member Picker */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold">
                  Pick Members ({selectedUsers.length} selected)
                </span>
              </div>
              <div
                style={{
                  backgroundColor: "var(--rc-input-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border mb-2"
              >
                <Search className="w-3.5 h-3.5 opacity-60" />
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search contacts or @username..."
                  className="flex-1 bg-transparent text-xs focus:outline-none"
                />
              </div>

              <div
                style={{ borderColor: "var(--rc-border)" }}
                className="max-h-44 overflow-y-auto rounded-xl border divide-y divide-[var(--rc-border)]"
              >
                {candidateUsers.length === 0 ? (
                  <p
                    style={{ color: "var(--rc-text-muted)" }}
                    className="p-3 text-xs text-center"
                  >
                    No matching users found on this node.
                  </p>
                ) : (
                  candidateUsers.map((u) => {
                    const checked = selectedUsers.some((x) => x.id === u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleSelectUser(u)}
                        className={`w-full px-3 py-2 flex items-center gap-2.5 text-left transition ${
                          checked
                            ? "bg-[#00a884]/10"
                            : "hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                      >
                        <Avatar
                          name={u.effective_name}
                          src={u.avatar_url}
                          size="sm"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate">
                            {u.effective_name}
                          </div>
                          <div
                            style={{ color: "var(--rc-text-muted)" }}
                            className="text-[11px] font-mono truncate"
                          >
                            {u.global_id}
                          </div>
                        </div>
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            checked
                              ? "bg-[#00a884] border-[#00a884] text-white"
                              : "border-gray-400"
                          }`}
                        >
                          {checked && <Check className="w-3 h-3" />}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Group Permissions */}
            <div
              style={{
                backgroundColor: "var(--rc-input-bg)",
                borderColor: "var(--rc-border)",
              }}
              className="rounded-xl border p-3 space-y-2.5 text-xs"
            >
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="font-medium">Only admins can edit group info</div>
                  <div style={{ color: "var(--rc-text-muted)" }} className="text-[11px]">
                    Restrict name, icon, and description updates to admins
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={onlyAdminsCanEditInfo}
                  onChange={(e) => setOnlyAdminsCanEditInfo(e.target.checked)}
                  className="accent-[#00a884] w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="font-medium">Only admins can send messages</div>
                  <div style={{ color: "var(--rc-text-muted)" }} className="text-[11px]">
                    Announcement mode — members can read but only admins post
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={onlyAdminsCanSend}
                  onChange={(e) => setOnlyAdminsCanSend(e.target.checked)}
                  className="accent-[#00a884] w-4 h-4"
                />
              </label>
            </div>

            {error && (
              <div className="text-xs text-red-500 bg-red-500/10 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              data-testid="create-group-submit"
              className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#009575] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Lock className="w-4 h-4" />
              )}
              <span>Create Encrypted Group</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoinSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold mb-1.5">
                Paste Group Invite Link or Code
              </label>
              <input
                type="text"
                data-testid="invite-code-input"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                placeholder="https://chatapp.in/?join=... or invite code"
                style={{
                  backgroundColor: "var(--rc-input-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full px-3 py-2.5 rounded-xl border text-xs font-mono focus:outline-none focus:border-[#00a884]"
              />
            </div>

            {invitePreview && (
              <div
                style={{
                  backgroundColor: "var(--rc-input-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="rounded-xl border p-3.5 flex items-center gap-3"
              >
                <Avatar
                  name={invitePreview.name}
                  src={invitePreview.icon_url}
                  isGroup
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {invitePreview.name}
                  </div>
                  <div
                    style={{ color: "var(--rc-text-muted)" }}
                    className="text-xs"
                  >
                    {invitePreview.member_count} members •{" "}
                    {invitePreview.already_member
                      ? "Already a member"
                      : "Key rotation triggered on join"}
                  </div>
                  {invitePreview.description && (
                    <div
                      style={{ color: "var(--rc-text-secondary)" }}
                      className="text-xs mt-1 line-clamp-2"
                    >
                      {invitePreview.description}
                    </div>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="text-xs text-red-500 bg-red-500/10 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              data-testid="join-group-submit"
              className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#009575] disabled:opacity-60 text-white font-semibold text-sm flex items-center justify-center gap-2 transition"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Users className="w-4 h-4" />
              )}
              <span>
                {invitePreview?.already_member ? "Open Group" : "Join Encrypted Group"}
              </span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
