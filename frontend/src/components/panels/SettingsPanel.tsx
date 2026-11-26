"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bell,
  Check,
  Download,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Moon,
  Palette,
  Shield,
  Sun,
  Trash2,
  Volume2,
} from "lucide-react";
import { FederationStatusSection } from "@/components/panels/FederationStatusSection";
import { WebPushSection } from "@/components/panels/WebPushSection";
import { Avatar } from "@/components/ui/Avatar";
import {
  DeviceSession,
  PrivacyScope,
  WallpaperChoice,
} from "@/lib/api/client";
import { useAuthStore } from "@/store/useAuthStore";
import {
  playMessageNotificationChime,
  useChatStore,
} from "@/store/useChatStore";

export interface SettingsPanelProps {
  onClose: () => void;
}

type SettingsSection =
  | "menu"
  | "account"
  | "privacy"
  | "notifications"
  | "appearance"
  | "devices"
  | "federation"
  | "delete";

const WALLPAPER_SWATCHES: {
  id: WallpaperChoice;
  label: string;
  previewLight: string;
  previewDark: string;
}[] = [
  { id: "default", label: "Default Doodle", previewLight: "#efeae2", previewDark: "#0b141a" },
  { id: "emerald", label: "Emerald Mist", previewLight: "#d7f2e8", previewDark: "#0b231e" },
  { id: "midnight", label: "Midnight Blue", previewLight: "#dbe7f6", previewDark: "#0b1929" },
  { id: "sand", label: "Warm Sand", previewLight: "#f3ead8", previewDark: "#211c15" },
  { id: "rose", label: "Rose Quartz", previewLight: "#f6e2e8", previewDark: "#24131a" },
  { id: "slate", label: "Clean Slate", previewLight: "#e4e8ec", previewDark: "#131c21" },
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const router = useRouter();
  const {
    user,
    keyFingerprint,
    updateProfile,
    exportKeyBackup,
    fetchDevices,
    unlinkDevice,
    logoutAllOtherDevices,
    deleteAccount,
  } = useAuthStore();

  const {
    theme,
    setTheme,
    blocks,
    fetchBlocks,
    unblockUser,
    teardownRealtimeSession,
  } = useChatStore();

  const [section, setSection] = useState<SettingsSection>("menu");
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (section === "privacy") {
      fetchBlocks().catch(() => undefined);
    } else if (section === "devices") {
      setLoadingDevices(true);
      fetchDevices()
        .then(setDevices)
        .catch(() => undefined)
        .finally(() => setLoadingDevices(false));
    }
  }, [section, fetchBlocks, fetchDevices]);

  if (!user) return null;

  const handleBack = () => {
    if (section === "menu") onClose();
    else setSection("menu");
  };

  const sectionTitle: Record<SettingsSection, string> = {
    menu: "Settings",
    account: "Account & Key Backup",
    privacy: "Privacy & Blocked Users",
    notifications: "Notifications",
    appearance: "Theme & Chat Wallpaper",
    devices: "Linked Devices",
    federation: "Federation & Peer Nodes",
    delete: "Delete My Account",
  };

  const handleExportBackup = async () => {
    if (backupPassphrase.length < 8) {
      setNotice("Enter at least 8 characters to encrypt your backup.");
      return;
    }
    try {
      const jsonStr = await exportKeyBackup(backupPassphrase);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${user.username}.relaykey.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupPassphrase("");
      setNotice("Encrypted key backup downloaded.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Export failed.");
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      teardownRealtimeSession();
      await deleteAccount(deletePassword || undefined);
      router.replace("/signup");
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Account deletion failed."
      );
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      data-testid="settings-panel"
      className="w-full h-full flex flex-col border-r select-none"
    >
      <header
        style={{ backgroundColor: "var(--rc-ribbon)" }}
        className="h-[60px] px-4 flex items-center gap-3 text-white shrink-0"
      >
        <button
          type="button"
          onClick={handleBack}
          className="p-1.5 -ml-1 rounded-full hover:bg-white/15 transition"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-base font-semibold">{sectionTitle[section]}</h2>
      </header>

      <div className="flex-1 overflow-y-auto rc-scrollbar p-4 space-y-4">
        {/* MAIN MENU */}
        {section === "menu" && (
          <div className="space-y-3">
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-2xl p-3.5 flex items-center gap-3"
            >
              <Avatar
                name={user.display_name}
                src={user.avatar_url || undefined}
                color="#00a884"
                size="lg"
                isOnline
                showOnlineDot
              />
              <div className="min-w-0">
                <div className="text-base font-semibold truncate">
                  {user.display_name}
                </div>
                <div className="text-xs font-mono text-[#00a884] truncate">
                  {user.global_id}
                </div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs truncate mt-0.5"
                >
                  {user.about}
                </div>
              </div>
            </div>

            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-2xl overflow-hidden divide-y divide-[var(--rc-border)]"
            >
              {[
                {
                  id: "account" as const,
                  icon: <KeyRound className="w-5 h-5 text-[#00a884]" />,
                  title: "Account",
                  desc: "Security, E2EE safety number, key backup",
                },
                {
                  id: "privacy" as const,
                  icon: <Lock className="w-5 h-5 text-[#00a884]" />,
                  title: "Privacy",
                  desc: "Last seen, profile photo, read receipts, blocked users",
                },
                {
                  id: "notifications" as const,
                  icon: <Bell className="w-5 h-5 text-[#00a884]" />,
                  title: "Notifications",
                  desc: "Message alerts & incoming chime",
                },
                {
                  id: "appearance" as const,
                  icon: <Palette className="w-5 h-5 text-[#00a884]" />,
                  title: "Theme & Wallpaper",
                  desc: "Light / Dark mode & chat wallpaper colors",
                },
                {
                  id: "devices" as const,
                  icon: <Laptop className="w-5 h-5 text-[#00a884]" />,
                  title: "Linked Devices",
                  desc: "Manage active browser sessions & remote logout",
                },
                {
                  id: "federation" as const,
                  icon: <Globe className="w-5 h-5 text-[#00a884]" />,
                  title: "Federation & Peer Nodes",
                  desc: "Peer status, domain allow/block policy & outbox queue",
                },
                {
                  id: "delete" as const,
                  icon: <Trash2 className="w-5 h-5 text-red-500" />,
                  title: "Delete Account",
                  desc: "Permanently erase your account from this node",
                  danger: true,
                },
              ].map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setSection(row.id);
                  }}
                  data-testid={`settings-nav-${row.id}`}
                  className="w-full px-4 py-3.5 flex items-center gap-3.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition"
                >
                  <div className="shrink-0">{row.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-medium ${
                        row.danger ? "text-red-500" : ""
                      }`}
                    >
                      {row.title}
                    </div>
                    <div
                      style={{ color: "var(--rc-text-secondary)" }}
                      className="text-xs truncate"
                    >
                      {row.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 1. ACCOUNT */}
        {section === "account" && (
          <div className="space-y-4">
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 space-y-2"
            >
              <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
                <Shield className="w-4 h-4" /> Federated Node Identity
              </div>
              <div className="text-sm font-mono">{user.global_id}</div>
              {keyFingerprint && (
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs font-mono pt-1"
                >
                  Safety number: {keyFingerprint}
                </div>
              )}
            </div>

            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 space-y-2.5"
            >
              <div className="text-sm font-semibold">
                Encrypted Private Key Backup (.relaykey.json)
              </div>
              <p
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-xs"
              >
                Derived via PBKDF2-SHA256 (250,000 iterations) + AES-256-GCM so
                you can restore your E2EE messages on a second browser.
              </p>
              <div className="flex gap-2 pt-1">
                <input
                  type="password"
                  value={backupPassphrase}
                  onChange={(e) => setBackupPassphrase(e.target.value)}
                  placeholder="Backup passphrase (8+ chars)"
                  style={{
                    backgroundColor: "var(--rc-surface-elevated)",
                    color: "var(--rc-text-primary)",
                    borderColor: "var(--rc-border)",
                  }}
                  className="flex-1 rounded-lg px-3 py-2 text-xs border focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleExportBackup}
                  className="px-3.5 py-2 rounded-lg bg-[#00a884] text-white text-xs font-semibold inline-flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" /> Export
                </button>
              </div>
              {notice && (
                <p className="text-xs text-[#00a884] font-medium">{notice}</p>
              )}
            </div>
          </div>
        )}

        {/* 2. PRIVACY (Server-enforced: everyone / contacts / nobody + Blocked list) */}
        {section === "privacy" && (
          <div className="space-y-4">
            {(
              [
                {
                  key: "privacy_last_seen",
                  label: "Who can see my last seen & online",
                  value: user.privacy_last_seen,
                  onChange: (val: PrivacyScope) =>
                    updateProfile({ privacy_last_seen: val }),
                },
                {
                  key: "privacy_profile_photo",
                  label: "Who can see my profile photo",
                  value: user.privacy_profile_photo || "everyone",
                  onChange: (val: PrivacyScope) =>
                    updateProfile({ privacy_profile_photo: val }),
                },
                {
                  key: "privacy_read_receipts_visibility",
                  label: "Send read receipts to",
                  value: user.privacy_read_receipts_visibility || "everyone",
                  onChange: (val: PrivacyScope) =>
                    updateProfile({ privacy_read_receipts_visibility: val }),
                },
              ] as const
            ).map((item) => (
              <div
                key={item.key}
                style={{ backgroundColor: "var(--rc-header-bg)" }}
                className="rounded-xl p-3.5 space-y-2"
              >
                <label className="block text-xs font-semibold">
                  {item.label}
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["everyone", "contacts", "nobody"] as PrivacyScope[]).map(
                    (opt) => {
                      const active = item.value === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => item.onChange(opt)}
                          data-testid={`${item.key}-${opt}`}
                          style={{
                            backgroundColor: active
                              ? "var(--rc-accent-soft)"
                              : "var(--rc-surface-elevated)",
                            color: active
                              ? "var(--rc-accent-strong)"
                              : "var(--rc-text-secondary)",
                            borderColor: active
                              ? "var(--rc-accent)"
                              : "var(--rc-border)",
                          }}
                          className="py-2 px-2 rounded-lg border text-xs font-semibold capitalize transition"
                        >
                          {opt === "contacts" ? "My Contacts" : opt}
                        </button>
                      );
                    }
                  )}
                </div>
              </div>
            ))}

            {/* Blocked Users List */}
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-3.5 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold flex items-center gap-1.5">
                  <Ban className="w-3.5 h-3.5 text-red-500" /> Blocked Contacts
                </span>
                <span className="text-xs font-mono text-[#00a884]">
                  {blocks.length}
                </span>
              </div>

              {blocks.length === 0 ? (
                <p
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs"
                >
                  No blocked users. Blocked accounts cannot message you or see
                  your last seen.
                </p>
              ) : (
                <div className="divide-y divide-[var(--rc-border)]">
                  {blocks.map((blk) => (
                    <div
                      key={blk.id}
                      className="py-2 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">
                          {blk.user.effective_name}
                        </div>
                        <div
                          style={{ color: "var(--rc-text-secondary)" }}
                          className="text-[11px] font-mono truncate"
                        >
                          {blk.user.global_id}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => unblockUser(blk.blocked_user_id)}
                        className="px-2.5 py-1 rounded-lg bg-[#00a884]/15 text-[#00a884] text-xs font-semibold hover:bg-[#00a884]/25 transition"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. NOTIFICATIONS */}
        {section === "notifications" && (
          <div className="space-y-3">
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 flex items-center justify-between gap-3"
            >
              <div>
                <div className="text-sm font-medium">Message Notifications</div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs"
                >
                  Show desktop alerts for new encrypted messages
                </div>
              </div>
              <input
                type="checkbox"
                checked={user.notifications_enabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (
                    next &&
                    typeof window !== "undefined" &&
                    "Notification" in window &&
                    Notification.permission === "default"
                  ) {
                    Notification.requestPermission().catch(() => undefined);
                  }
                  updateProfile({ notifications_enabled: next });
                }}
                className="w-4 h-4 accent-[#00a884]"
              />
            </div>

            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 flex items-center justify-between gap-3"
            >
              <div>
                <div className="text-sm font-medium">Incoming Message Sounds</div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs"
                >
                  Play subtle chime on incoming unmuted messages
                </div>
              </div>
              <input
                type="checkbox"
                checked={user.notification_sound}
                onChange={(e) =>
                  updateProfile({ notification_sound: e.target.checked })
                }
                className="w-4 h-4 accent-[#00a884]"
              />
            </div>

            <button
              type="button"
              onClick={() => playMessageNotificationChime()}
              style={{
                backgroundColor: "var(--rc-header-bg)",
                color: "var(--rc-text-primary)",
              }}
              className="w-full py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition"
            >
              <Volume2 className="w-4 h-4 text-[#00a884]" /> Test Notification Chime
            </button>

            <WebPushSection />
          </div>
        )}

        {/* 4. THEME & WALLPAPER */}
        {section === "appearance" && (
          <div className="space-y-4">
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 space-y-2.5"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-[#00a884]">
                Theme Mode
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setTheme("light")}
                  data-testid="theme-light-button"
                  style={{
                    borderColor:
                      theme === "light" ? "var(--rc-accent)" : "var(--rc-border)",
                  }}
                  className="rounded-xl border-2 p-3 flex items-center justify-between bg-[#f0f2f5] text-[#111b21]"
                >
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <Sun className="w-4 h-4 text-amber-500" /> Light
                  </span>
                  {theme === "light" && (
                    <Check className="w-4 h-4 text-[#00a884]" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setTheme("dark")}
                  data-testid="theme-dark-button"
                  style={{
                    borderColor:
                      theme === "dark" ? "var(--rc-accent)" : "var(--rc-border)",
                  }}
                  className="rounded-xl border-2 p-3 flex items-center justify-between bg-[#111b21] text-[#e9edef]"
                >
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <Moon className="w-4 h-4 text-[#00a884]" /> Dark
                  </span>
                  {theme === "dark" && (
                    <Check className="w-4 h-4 text-[#00a884]" />
                  )}
                </button>
              </div>
            </div>

            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl p-4 space-y-2.5"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-[#00a884]">
                Chat Wallpaper
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                {WALLPAPER_SWATCHES.map((sw) => {
                  const selected =
                    (user.chat_wallpaper || "default") === sw.id;
                  return (
                    <button
                      key={sw.id}
                      type="button"
                      onClick={() => updateProfile({ chat_wallpaper: sw.id })}
                      style={{
                        borderColor: selected
                          ? "var(--rc-accent)"
                          : "var(--rc-border)",
                      }}
                      className="rounded-xl border-2 p-2.5 text-left space-y-1.5 transition hover:opacity-95"
                    >
                      <div
                        style={{
                          backgroundColor:
                            theme === "dark" ? sw.previewDark : sw.previewLight,
                        }}
                        className="h-10 rounded-lg border border-black/10 dark:border-white/10"
                      />
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span>{sw.label}</span>
                        {selected && (
                          <Check className="w-3.5 h-3.5 text-[#00a884]" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* 5. LINKED DEVICES */}
        {section === "devices" && (
          <div className="space-y-3">
            {devices.some((d) => !d.is_current) && (
              <button
                type="button"
                onClick={async () => {
                  await logoutAllOtherDevices();
                  setDevices(await fetchDevices());
                }}
                data-testid="logout-all-other-devices"
                className="w-full py-2.5 rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
              >
                <LogOut className="w-4 h-4" /> Log Out All Other Devices
              </button>
            )}

            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="rounded-xl divide-y divide-[var(--rc-border)]"
            >
              {loadingDevices ? (
                <div className="p-5 text-xs text-center">Loading sessions...</div>
              ) : (
                devices.map((dev) => (
                  <div
                    key={dev.id}
                    className="p-3.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {dev.device_name}
                        </span>
                        {dev.is_current && (
                          <span className="px-2 py-0.5 rounded-full bg-[#00a884]/15 text-[#00a884] text-[10px] font-bold">
                            THIS DEVICE
                          </span>
                        )}
                      </div>
                      <div
                        style={{ color: "var(--rc-text-secondary)" }}
                        className="text-[11px] truncate"
                      >
                        {dev.ip_address ? `${dev.ip_address} • ` : ""}
                        Active {new Date(dev.last_active).toLocaleString()}
                      </div>
                    </div>

                    {!dev.is_current && (
                      <button
                        type="button"
                        onClick={async () => {
                          await unlinkDevice(dev.id);
                          setDevices(await fetchDevices());
                        }}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-500 hover:bg-red-500/10 shrink-0"
                      >
                        Log out
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* 5b. FEDERATION & PEER NODES */}
        {section === "federation" && <FederationStatusSection />}

        {/* 6. DELETE ACCOUNT */}
        {section === "delete" && (
          <form onSubmit={handleDeleteAccount} className="space-y-4">
            <div className="rounded-xl p-4 bg-red-500/10 border border-red-500/30 space-y-2">
              <div className="flex items-center gap-2 text-red-500 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Deleting your account is permanent</span>
              </div>
              <ul
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-xs list-disc pl-4 space-y-1"
              >
                <li>Erases {user.global_id} from this node</li>
                <li>Deletes your 1:1 chat history &amp; linked devices</li>
                <li>Wipes your E2EE private key from browser IndexedDB</li>
              </ul>
            </div>

            <div>
              <label
                style={{ color: "var(--rc-text-secondary)" }}
                className="block text-xs font-semibold uppercase mb-1.5"
              >
                Confirm Your Password
              </label>
              <input
                type="password"
                required
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Enter your account password"
                data-testid="delete-account-password"
                style={{
                  backgroundColor: "var(--rc-header-bg)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full rounded-xl px-3.5 py-2.5 text-sm border focus:outline-none focus:border-red-500"
              />
            </div>

            {deleteError && (
              <p className="text-xs text-red-500 font-medium">{deleteError}</p>
            )}

            <button
              type="submit"
              disabled={deleting || !deletePassword}
              data-testid="confirm-delete-account"
              className="w-full py-2.5 rounded-xl bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold transition"
            >
              {deleting ? "Deleting Account..." : "Permanently Delete My Account"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
