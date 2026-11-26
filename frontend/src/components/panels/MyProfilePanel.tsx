"use client";

import React, { useState } from "react";
import {
  ArrowLeft,
  Camera,
  Check,
  Copy,
  KeyRound,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import { AvatarCropModal } from "@/components/panels/AvatarCropModal";
import { Avatar } from "@/components/ui/Avatar";
import { useAuthStore } from "@/store/useAuthStore";

export interface MyProfilePanelProps {
  onClose: () => void;
}

export function MyProfilePanel({ onClose }: MyProfilePanelProps) {
  const { user, keyFingerprint, updateProfile, uploadAvatar } = useAuthStore();

  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingAbout, setEditingAbout] = useState(false);
  const [nameVal, setNameVal] = useState(user?.display_name || "");
  const [aboutVal, setAboutVal] = useState(user?.about || "");
  const [copiedId, setCopiedId] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  if (!user) return null;

  const saveName = async () => {
    const trimmed = nameVal.trim();
    if (!trimmed) return;
    await updateProfile({ display_name: trimmed });
    setEditingName(false);
    setStatusMsg("Display name updated.");
    setTimeout(() => setStatusMsg(null), 2000);
  };

  const saveAbout = async () => {
    await updateProfile({ about: aboutVal.trim() });
    setEditingAbout(false);
    setStatusMsg("About status updated.");
    setTimeout(() => setStatusMsg(null), 2000);
  };

  return (
    <div
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="w-full h-full flex flex-col border-r select-none"
      data-testid="my-profile-panel"
    >
      <AvatarCropModal
        file={pendingAvatarFile}
        onClose={() => setPendingAvatarFile(null)}
        onConfirmCrop={async (blob) => {
          await uploadAvatar(blob);
          setStatusMsg("Profile photo cropped & updated.");
          setTimeout(() => setStatusMsg(null), 2200);
        }}
      />

      <header
        style={{ backgroundColor: "var(--rc-ribbon)" }}
        className="h-[60px] px-4 flex items-center gap-3 text-white shrink-0"
      >
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 -ml-1 rounded-full hover:bg-white/15 transition"
          aria-label="Back to chats"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-base font-semibold">Profile</h2>
      </header>

      <div className="flex-1 overflow-y-auto rc-scrollbar p-5 space-y-5">
        {/* Avatar with Camera Overlay */}
        <div className="flex flex-col items-center pt-2">
          <label className="relative group cursor-pointer rounded-full overflow-hidden">
            <Avatar
              name={user.display_name}
              src={user.avatar_url || undefined}
              color="#00a884"
              size="xl"
            />
            <div className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center text-white text-[10px] font-semibold text-center px-2">
              <Camera className="w-5 h-5 mb-0.5" />
              <span>CHANGE PHOTO</span>
            </div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setPendingAvatarFile(f);
                e.target.value = "";
              }}
              data-testid="profile-avatar-file-input"
              className="hidden"
            />
          </label>
          <span
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px] mt-2"
          >
            Click photo to resize &amp; square-crop before uploading
          </span>
        </div>

        {/* Display Name Card */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-1.5"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00a884]">
            Your Name
          </div>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                maxLength={80}
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                }}
                style={{ color: "var(--rc-text-primary)" }}
                className="flex-1 bg-transparent border-b-2 border-[#00a884] py-1 text-sm focus:outline-none"
              />
              <button
                type="button"
                onClick={saveName}
                className="p-1.5 rounded-full text-[#00a884] hover:bg-[#00a884]/10"
                aria-label="Save display name"
              >
                <Check className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{user.display_name}</span>
              <button
                type="button"
                onClick={() => {
                  setNameVal(user.display_name);
                  setEditingName(true);
                }}
                style={{ color: "var(--rc-text-secondary)" }}
                className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
                aria-label="Edit display name"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* About Card */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-1.5"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00a884]">
            About
          </div>
          {editingAbout ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                maxLength={255}
                value={aboutVal}
                onChange={(e) => setAboutVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveAbout();
                }}
                style={{ color: "var(--rc-text-primary)" }}
                className="flex-1 bg-transparent border-b-2 border-[#00a884] py-1 text-sm focus:outline-none"
              />
              <button
                type="button"
                onClick={saveAbout}
                className="p-1.5 rounded-full text-[#00a884] hover:bg-[#00a884]/10"
                aria-label="Save about"
              >
                <Check className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm break-words">{user.about}</span>
              <button
                type="button"
                onClick={() => {
                  setAboutVal(user.about);
                  setEditingAbout(true);
                }}
                style={{ color: "var(--rc-text-secondary)" }}
                className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 shrink-0"
                aria-label="Edit about"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Federated ID Card */}
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="rounded-xl p-3.5 space-y-1.5"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00a884]">
            RelayChat Address
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono truncate">{user.global_id}</span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(user.global_id);
                setCopiedId(true);
                setTimeout(() => setCopiedId(false), 1800);
              }}
              style={{ color: "var(--rc-text-secondary)" }}
              className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
              aria-label="Copy RelayChat ID"
            >
              {copiedId ? (
                <Check className="w-4 h-4 text-[#00a884]" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* E2EE Safety Number */}
        {keyFingerprint && (
          <div
            style={{ backgroundColor: "var(--rc-header-bg)" }}
            className="rounded-xl p-3.5 space-y-1.5"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00a884] flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> ECDH P-256 Safety Number
            </div>
            <div className="text-xs font-mono tracking-wider leading-relaxed">
              {keyFingerprint}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[11px] flex items-center gap-1 pt-1"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#00a884]" />
              <span>Private key stays strictly in your browser IndexedDB</span>
            </div>
          </div>
        )}

        {statusMsg && (
          <p className="text-xs text-center font-medium text-[#00a884]">
            {statusMsg}
          </p>
        )}
      </div>
    </div>
  );
}
