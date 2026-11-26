"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCheck,
  Copy,
  Download,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  MessageSquarePlus,
  Moon,
  MoreVertical,
  Phone,
  Search,
  Settings,
  ShieldCheck,
  Smile,
  Sun,
  Trash2,
  Upload,
  User as UserIcon,
  Video,
} from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { DeviceSession, WellKnownUser, apiFetch } from "@/lib/api/client";
import { useAuthStore } from "@/store/useAuthStore";

type ActiveDrawer = "none" | "profile" | "security" | "devices" | "settings";
type ChatFilter = "all" | "unread" | "groups";

export function WorkspaceShell({ initialOpenSecurity = false }: { initialOpenSecurity?: boolean }) {
  const router = useRouter();
  const {
    user,
    theme,
    setTheme,
    hasLocalPrivateKey,
    keyFingerprint,
    nodeInfo,
    logout,
    updateProfile,
    uploadAvatar,
    exportKeyBackup,
    importKeyBackup,
    fetchDevices,
    unlinkDevice,
  } = useAuthStore();

  const [drawer, setDrawer] = useState<ActiveDrawer>(
    initialOpenSecurity ? "security" : "none"
  );
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Profile form state
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [about, setAbout] = useState(user?.about || "");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);

  // Key backup state
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importFileJson, setImportFileJson] = useState("");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Linked devices state
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Discovery preview state (/.well-known/user/{username})
  const [lookupResult, setLookupResult] = useState<WellKnownUser | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  useEffect(() => {
    if (initialOpenSecurity) {
      setDrawer("security");
    }
  }, [initialOpenSecurity]);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name);
      setAbout(user.about);
    }
  }, [user]);

  useEffect(() => {
    if (drawer === "devices") {
      setDevicesLoading(true);
      fetchDevices()
        .then(setDevices)
        .finally(() => setDevicesLoading(false));
    }
  }, [drawer, fetchDevices]);

  if (!user) return null;

  const initials = (user.display_name || user.username)
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const handleCopyGlobalId = async () => {
    await navigator.clipboard.writeText(user.global_id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1800);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileStatus(null);
    try {
      await updateProfile({ display_name: displayName, about });
      setProfileStatus("Profile updated.");
      setTimeout(() => setProfileStatus(null), 2500);
    } catch (err) {
      setProfileStatus(err instanceof Error ? err.message : "Failed to update profile.");
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setProfileStatus("Uploading avatar...");
    try {
      await uploadAvatar(f);
      setProfileStatus("Avatar updated.");
      setTimeout(() => setProfileStatus(null), 2500);
    } catch (err) {
      setProfileStatus(err instanceof Error ? err.message : "Avatar upload failed.");
    }
  };

  const handleDownloadKeyBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBackupMessage(null);
    try {
      const jsonStr = await exportKeyBackup(exportPassphrase);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${user.username}@${user.domain}.relaykey.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportPassphrase("");
      setBackupMessage({
        type: "ok",
        text: "Encrypted key backup downloaded! Store it safely.",
      });
    } catch (err) {
      setBackupMessage({
        type: "err",
        text: err instanceof Error ? err.message : "Export failed.",
      });
    }
  };

  const handleImportBackupInDrawer = async (e: React.FormEvent) => {
    e.preventDefault();
    setBackupMessage(null);
    try {
      await importKeyBackup(importFileJson, importPassphrase);
      setImportPassphrase("");
      setBackupMessage({
        type: "ok",
        text: "Private key verified and saved to IndexedDB!",
      });
    } catch (err) {
      setBackupMessage({
        type: "err",
        text: err instanceof Error ? err.message : "Import failed.",
      });
    }
  };

  const handleLookupIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) {
      setLookupResult(null);
      setLookupError(null);
      return;
    }
    const targetUsername = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const found = await apiFetch<WellKnownUser>(
        `/.well-known/user/${encodeURIComponent(targetUsername)}`
      );
      setLookupResult(found);
    } catch (err) {
      setLookupResult(null);
      setLookupError(err instanceof Error ? err.message : "User not found.");
    } finally {
      setLookupLoading(false);
    }
  };

  const handleToggleTheme = async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      await updateProfile({ theme: next });
    } catch {
      // local theme still applied
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#d1d7db] dark:bg-[#0c1317] flex items-center justify-center xl:p-4">
      {/* Top green accent strip visible on wide desktop screens (WhatsApp Web style) */}
      <div className="hidden xl:block fixed top-0 inset-x-0 h-32 bg-[#00a884] dark:bg-[#008069]/60 pointer-events-none" />

      <div className="relative z-10 w-full h-full xl:max-w-[1600px] xl:rounded-xl overflow-hidden shadow-2xl flex bg-white dark:bg-[#111b21] border border-slate-300/60 dark:border-slate-800">
        {/* ================= LEFT SIDEBAR ================= */}
        <aside className="w-full md:w-[390px] lg:w-[420px] shrink-0 h-full flex flex-col border-r border-slate-200 dark:border-[#222d34] bg-white dark:bg-[#111b21] relative">
          {/* Sidebar Header */}
          <header className="h-[60px] px-4 bg-[#f0f2f5] dark:bg-[#202c33] flex items-center justify-between shrink-0">
            <button
              type="button"
              onClick={() => setDrawer("profile")}
              className="flex items-center gap-3 group text-left"
              title="Edit Profile"
            >
              <div className="relative w-10 h-10 rounded-full overflow-hidden bg-[#00a884] text-white flex items-center justify-center font-semibold text-sm shrink-0">
                {user.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatar_url}
                    alt={user.display_name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  initials
                )}
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[#f0f2f5] dark:ring-[#202c33]" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {user.display_name}
                </div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  {user.global_id}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-1 text-slate-600 dark:text-[#aebac1] relative">
              <button
                type="button"
                onClick={handleToggleTheme}
                className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
                title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>

              <button
                type="button"
                onClick={() => setDrawer("security")}
                className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition relative"
                title="E2EE Keys & Encrypted Backup"
              >
                <KeyRound className="w-5 h-5" />
                {hasLocalPrivateKey && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#00a884]" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
                aria-label="Menu"
              >
                <MoreVertical className="w-5 h-5" />
              </button>

              {menuOpen && (
                <div
                  onMouseLeave={() => setMenuOpen(false)}
                  className="absolute right-0 top-11 w-52 rounded-xl bg-white dark:bg-[#233138] shadow-xl border border-slate-200 dark:border-slate-700/70 py-1.5 z-30 text-sm text-slate-800 dark:text-slate-200"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setDrawer("profile");
                      setMenuOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-[#182229] flex items-center gap-2.5"
                  >
                    <UserIcon className="w-4 h-4 text-[#00a884]" /> Profile
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDrawer("security");
                      setMenuOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-[#182229] flex items-center gap-2.5"
                  >
                    <KeyRound className="w-4 h-4 text-[#00a884]" /> Key Backup (E2EE)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDrawer("devices");
                      setMenuOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-[#182229] flex items-center gap-2.5"
                  >
                    <Laptop className="w-4 h-4 text-[#00a884]" /> Linked Devices
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDrawer("settings");
                      setMenuOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-[#182229] flex items-center gap-2.5"
                  >
                    <Settings className="w-4 h-4 text-[#00a884]" /> Privacy & Settings
                  </button>
                  <div className="my-1 border-t border-slate-200 dark:border-slate-700/70" />
                  <button
                    type="button"
                    onClick={async () => {
                      await logout();
                      router.replace("/login");
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 flex items-center gap-2.5"
                  >
                    <LogOut className="w-4 h-4" /> Log out
                  </button>
                </div>
              )}
            </div>
          </header>

          {/* Search Bar & Filter Pills */}
          <div className="px-3 pt-2.5 pb-2 border-b border-slate-200 dark:border-[#222d34] space-y-2.5">
            <form onSubmit={handleLookupIdentity} className="relative flex items-center">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value.trim()) {
                    setLookupResult(null);
                    setLookupError(null);
                  }
                }}
                placeholder={`Search or verify username@${user.domain}`}
                className="w-full pl-10 pr-16 py-2 rounded-lg text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-[#8696a0] focus:outline-none"
              />
              {searchQuery.trim() && (
                <button
                  type="submit"
                  className="absolute right-2 px-2.5 py-1 rounded-md text-xs font-medium bg-[#00a884] text-white hover:bg-[#008f6f]"
                >
                  {lookupLoading ? "..." : "Lookup"}
                </button>
              )}
            </form>

            {/* Filter Pills: All / Unread / Groups */}
            <div className="flex items-center gap-2">
              {(["all", "unread", "groups"] as ChatFilter[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition ${
                    filter === item
                      ? "bg-[#e7fce3] text-[#008069] dark:bg-[#0a332c] dark:text-[#00a884]"
                      : "bg-[#f0f2f5] text-slate-600 hover:bg-slate-200/70 dark:bg-[#202c33] dark:text-[#8696a0] dark:hover:bg-[#2a3942]"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          {/* Discovery Preview Result (Phase 1 /.well-known/user/{username} verifier) */}
          {(lookupResult || lookupError) && (
            <div className="mx-3 mt-3 rounded-xl p-3 bg-[#f0f2f5] dark:bg-[#202c33] border border-slate-200 dark:border-slate-700/70 text-xs">
              {lookupResult ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {lookupResult.display_name}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-[#00a884]/15 text-[#00a884] font-mono text-[10px]">
                      ECDH P-256 Verified
                    </span>
                  </div>
                  <div className="font-mono text-slate-600 dark:text-slate-300">
                    {lookupResult.global_id}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 truncate">
                    {lookupResult.about}
                  </div>
                  <div className="pt-1 text-[10px] font-mono text-slate-400 truncate">
                    Public JWK: {lookupResult.public_key}
                  </div>
                </div>
              ) : (
                <div className="text-amber-600 dark:text-amber-400">{lookupError}</div>
              )}
            </div>
          )}

          {/* Chat List Placeholder for Phase 1 */}
          <div className="flex-1 overflow-y-auto px-4 py-8 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#00a884]/10 text-[#00a884] flex items-center justify-center mb-3">
              <MessageSquarePlus className="w-7 h-7" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Identity Ready on {user.domain}
            </h3>
            <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-1 max-w-[260px] leading-relaxed">
              Your ECDH P-256 identity key is active in IndexedDB. Try looking up{" "}
              <code className="font-mono text-[#00a884]">rahul</code> or{" "}
              <code className="font-mono text-[#00a884]">priya</code> in the search bar above!
            </p>
            <button
              type="button"
              onClick={handleCopyGlobalId}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-mono bg-[#f0f2f5] dark:bg-[#202c33] text-slate-700 dark:text-slate-200 hover:border-[#00a884] border border-transparent transition"
            >
              {copiedId ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#00a884]" /> Copied {user.global_id}
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-[#00a884]" /> {user.global_id}
                </>
              )}
            </button>
          </div>

          {/* ================= SLIDE-IN DRAWERS ================= */}
          {drawer !== "none" && (
            <div className="absolute inset-0 z-20 bg-white dark:bg-[#111b21] flex flex-col animate-in slide-in-from-left duration-150">
              <div className="h-[108px] bg-[#008069] dark:bg-[#202c33] px-5 pb-4 flex items-end gap-4 text-white">
                <button
                  type="button"
                  onClick={() => setDrawer("none")}
                  className="p-1.5 rounded-full hover:bg-white/10 transition"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-lg font-semibold">
                  {drawer === "profile" && "Profile"}
                  {drawer === "security" && "E2EE Key Backup"}
                  {drawer === "devices" && "Linked Devices"}
                  {drawer === "settings" && "Privacy & Settings"}
                </h2>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                {/* --- PROFILE DRAWER --- */}
                {drawer === "profile" && (
                  <>
                    <div className="flex flex-col items-center">
                      <label className="relative w-28 h-28 rounded-full overflow-hidden bg-[#00a884] text-white flex items-center justify-center text-2xl font-bold cursor-pointer group shadow-md">
                        {user.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={user.avatar_url}
                            alt={user.display_name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          initials
                        )}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center text-[11px] font-medium">
                          <Camera className="w-5 h-5 mb-1" />
                          Change Photo
                        </div>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={handleAvatarUpload}
                          className="hidden"
                        />
                      </label>
                      <span className="mt-3 text-xs font-mono text-[#00a884]">
                        {user.global_id}
                      </span>
                    </div>

                    <form onSubmit={handleSaveProfile} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-[#008069] dark:text-[#00a884] mb-1">
                          Your Display Name
                        </label>
                        <input
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          maxLength={80}
                          required
                          className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#00a884]"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#008069] dark:text-[#00a884] mb-1">
                          About
                        </label>
                        <input
                          type="text"
                          value={about}
                          onChange={(e) => setAbout(e.target.value)}
                          maxLength={255}
                          className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#00a884]"
                        />
                      </div>

                      {profileStatus && (
                        <div className="text-xs text-[#008069] dark:text-[#00a884]">
                          {profileStatus}
                        </div>
                      )}

                      <button
                        type="submit"
                        className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white text-sm font-medium transition"
                      >
                        Save Profile
                      </button>
                    </form>

                    {keyFingerprint && (
                      <div className="rounded-xl bg-[#f0f2f5] dark:bg-[#202c33] p-4 space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 text-[#00a884]" />
                          Safety Number (P-256 Public Key)
                        </div>
                        <p className="font-mono text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          {keyFingerprint}
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* --- SECURITY / KEY BACKUP DRAWER --- */}
                {drawer === "security" && (
                  <>
                    <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 p-3.5 text-xs text-emerald-900 dark:text-emerald-200 space-y-1">
                      <div className="font-semibold flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-[#00a884]" />
                        {hasLocalPrivateKey
                          ? "Browser IndexedDB Private Key Active"
                          : "Private Key Not Loaded in IndexedDB"}
                      </div>
                      <p className="text-emerald-800/80 dark:text-emerald-300/80 leading-relaxed">
                        Your ECDH P-256 private key never touches the server. Export an AES-256-GCM
                        encrypted backup to sign in on other browsers or devices.
                      </p>
                    </div>

                    <form onSubmit={handleDownloadKeyBackup} className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        Export Encrypted Key Backup
                      </h3>
                      <input
                        type="password"
                        value={exportPassphrase}
                        onChange={(e) => setExportPassphrase(e.target.value)}
                        placeholder="Choose backup passphrase (min 8 chars)"
                        minLength={8}
                        required
                        className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#00a884]"
                      />
                      <button
                        type="submit"
                        disabled={!hasLocalPrivateKey}
                        className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white text-sm font-medium flex items-center justify-center gap-2 transition"
                      >
                        <Download className="w-4 h-4" />
                        Download .relaykey.json Backup
                      </button>
                    </form>

                    <div className="border-t border-slate-200 dark:border-slate-800 pt-5">
                      <form onSubmit={handleImportBackupInDrawer} className="space-y-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          Import Key Backup
                        </h3>
                        <label className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 cursor-pointer text-xs text-slate-600 dark:text-slate-300 hover:border-[#00a884]">
                          <Upload className="w-4 h-4 text-[#00a884]" />
                          <span className="truncate">
                            {importFileName || "Select .relaykey.json file"}
                          </span>
                          <input
                            type="file"
                            accept=".json,application/json"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              setImportFileName(f.name);
                              setImportFileJson(await f.text());
                            }}
                            className="hidden"
                          />
                        </label>
                        <input
                          type="password"
                          value={importPassphrase}
                          onChange={(e) => setImportPassphrase(e.target.value)}
                          placeholder="Enter backup passphrase"
                          required
                          className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#00a884]"
                        />
                        <button
                          type="submit"
                          disabled={!importFileJson}
                          className="w-full py-2.5 rounded-xl bg-slate-800 dark:bg-[#202c33] hover:bg-slate-700 text-white text-sm font-medium transition disabled:opacity-50"
                        >
                          Verify & Restore Key
                        </button>
                      </form>
                    </div>

                    {backupMessage && (
                      <div
                        className={`rounded-xl px-3.5 py-2.5 text-xs ${
                          backupMessage.type === "ok"
                            ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                            : "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                        }`}
                      >
                        {backupMessage.text}
                      </div>
                    )}
                  </>
                )}

                {/* --- LINKED DEVICES DRAWER --- */}
                {drawer === "devices" && (
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Active browser sessions linked to <strong>{user.global_id}</strong>. Unlinking
                      a device immediately revokes its JWT access & refresh tokens.
                    </p>
                    {devicesLoading ? (
                      <div className="space-y-2">
                        {[1, 2].map((n) => (
                          <div
                            key={n}
                            className="h-16 rounded-xl bg-slate-100 dark:bg-[#202c33] animate-pulse"
                          />
                        ))}
                      </div>
                    ) : (
                      devices.map((dev) => (
                        <div
                          key={dev.id}
                          className="rounded-xl p-3.5 bg-[#f0f2f5] dark:bg-[#202c33] flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="p-2.5 rounded-xl bg-[#00a884]/15 text-[#00a884]">
                              <Laptop className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                <span className="truncate">{dev.device_name}</span>
                                {dev.is_current && (
                                  <span className="px-2 py-0.5 text-[10px] rounded-full bg-[#00a884] text-white">
                                    This device
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                                IP {dev.ip_address || "local"} • Active{" "}
                                {new Date(dev.last_active_at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                            </div>
                          </div>
                          {!dev.is_current && (
                            <button
                              type="button"
                              onClick={async () => {
                                await unlinkDevice(dev.id);
                                setDevices((prev) => prev.filter((d) => d.id !== dev.id));
                              }}
                              className="p-2 rounded-lg text-red-500 hover:bg-red-500/10 transition"
                              title="Unlink device"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* --- SETTINGS & PRIVACY DRAWER --- */}
                {drawer === "settings" && (
                  <div className="space-y-5">
                    <div>
                      <label className="block text-xs font-semibold text-[#008069] dark:text-[#00a884] mb-1.5">
                        Who can see my Last Seen & Online status
                      </label>
                      <select
                        value={user.privacy_last_seen}
                        onChange={(e) =>
                          updateProfile({
                            privacy_last_seen: e.target.value as
                              | "everyone"
                              | "contacts"
                              | "nobody",
                          })
                        }
                        className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#f0f2f5] dark:bg-[#202c33] text-slate-900 dark:text-slate-100 focus:outline-none"
                      >
                        <option value="everyone">Everyone</option>
                        <option value="contacts">My Contacts</option>
                        <option value="nobody">Nobody</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between rounded-xl p-3.5 bg-[#f0f2f5] dark:bg-[#202c33]">
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          Read Receipts
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Send blue double-ticks when reading 1:1 messages
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={user.privacy_read_receipts}
                        onChange={(e) =>
                          updateProfile({ privacy_read_receipts: e.target.checked })
                        }
                        className="w-4 h-4 accent-[#00a884]"
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-xl p-3.5 bg-[#f0f2f5] dark:bg-[#202c33]">
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          Theme Appearance
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Switch between Light and Dark chat wallpaper
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleToggleTheme}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#00a884] text-white"
                      >
                        {theme === "dark" ? "Dark" : "Light"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* ================= RIGHT CHAT PANE (Phase 1 Shell & Wallpaper Preview) ================= */}
        <section className="hidden md:flex flex-1 flex-col h-full bg-[#efeae2] dark:bg-[#0b141a] relative">
          {/* Top Chat Header Preview */}
          <div className="h-[60px] px-4 bg-[#f0f2f5] dark:bg-[#202c33] border-b border-slate-200 dark:border-[#222d34] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrandLogo className="w-10 h-10" />
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  RelayChat Federated Node ({user.domain})
                </div>
                <div className="text-xs text-[#00a884] flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  <span>
                    Ed25519 S2S Ready • {nodeInfo?.public_key.slice(0, 18) || "Active"}...
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 text-slate-500 dark:text-[#aebac1]">
              <span title="Voice Call (Phase 4)" className="p-2 rounded-full opacity-60">
                <Phone className="w-5 h-5" />
              </span>
              <span title="Video Call (Phase 4)" className="p-2 rounded-full opacity-60">
                <Video className="w-5 h-5" />
              </span>
              <span title="Search" className="p-2 rounded-full opacity-60">
                <Search className="w-5 h-5" />
              </span>
            </div>
          </div>

          {/* Subtle WhatsApp-inspired wallpaper canvas */}
          <div className="flex-1 overflow-y-auto rc-chat-wallpaper p-6 flex flex-col justify-center items-center">
            <div className="max-w-lg w-full space-y-4">
              {/* Date separator pill */}
              <div className="flex justify-center">
                <span className="px-3 py-1 rounded-lg text-[11px] font-medium bg-white/90 dark:bg-[#182229] text-slate-600 dark:text-[#8696a0] shadow-sm">
                  TODAY
                </span>
              </div>

              {/* Yellow/amber E2EE encryption notice banner */}
              <div className="mx-auto max-w-md rounded-xl px-4 py-2.5 bg-[#ffeecd] dark:bg-[#182229] text-[#54656f] dark:text-[#ffd279] text-[11.5px] text-center shadow-sm flex items-center justify-center gap-2">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span>
                  Messages and calls are end-to-end encrypted. No one outside of this chat, not even
                  this {user.domain} server, can read or listen to them.
                </span>
              </div>

              {/* Sample Incoming Bubble with left tail */}
              <div className="flex justify-start">
                <div className="relative max-w-[82%] rounded-lg rounded-tl-none px-3.5 py-2 bg-white dark:bg-[#202c33] text-slate-900 dark:text-slate-100 shadow-sm text-sm">
                  <span className="absolute -left-2 top-0 w-0 h-0 border-t-[10px] border-t-white dark:border-t-[#202c33] border-l-[10px] border-l-transparent" />
                  <p className="leading-relaxed">
                    Welcome to <strong>RelayChat</strong>, {user.display_name}! Your federated ID{" "}
                    <code className="font-mono text-xs text-[#00a884]">{user.global_id}</code> is
                    live and discoverable via <code className="font-mono text-xs">/.well-known/user/{user.username}</code>.
                  </p>
                  <div className="text-[10px] text-slate-400 text-right mt-1">10:42</div>
                </div>
              </div>

              {/* Sample Outgoing Green Bubble with right tail + read ticks */}
              <div className="flex justify-end">
                <div className="relative max-w-[82%] rounded-lg rounded-tr-none px-3.5 py-2 bg-[#d9fdd3] dark:bg-[#005c4b] text-slate-900 dark:text-slate-100 shadow-sm text-sm">
                  <span className="absolute -right-2 top-0 w-0 h-0 border-t-[10px] border-t-[#d9fdd3] dark:border-t-[#005c4b] border-r-[10px] border-r-transparent" />
                  <p className="leading-relaxed">
                    ECDH P-256 private key stored strictly in IndexedDB — ready for Phase 2
                    realtime federated E2EE messaging!
                  </p>
                  <div className="flex items-center justify-end gap-1 text-[10px] text-slate-500 dark:text-emerald-200/80 mt-1">
                    <span>10:42</span>
                    <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Composer Bar Preview */}
          <div className="h-[62px] px-4 bg-[#f0f2f5] dark:bg-[#202c33] flex items-center gap-3">
            <Smile className="w-6 h-6 text-slate-500 dark:text-[#8696a0]" />
            <div className="flex-1 rounded-lg px-4 py-2.5 text-sm bg-white dark:bg-[#2a3942] text-slate-400 dark:text-[#8696a0] select-none">
              Select or add a contact in Phase 2 to start an encrypted conversation...
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
