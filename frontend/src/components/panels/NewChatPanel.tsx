"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  ArrowLeft,
  Camera,
  Check,
  Copy,
  Download,
  ImageUp,
  Loader2,
  QrCode,
  ScanLine,
  Search,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

export interface NewChatPanelProps {
  onClose: () => void;
  onChatOpened: () => void;
}

type PanelTab = "contacts" | "add-id" | "qr";
type QrSubMode = "my-qr" | "scan";

export function extractRelayChatIdFromQr(raw: string): string {
  let cleaned = raw.trim();
  for (const prefix of [
    "relaychat://",
    "relaychat:",
    "web+relaychat://",
    "web+relaychat:",
  ]) {
    if (cleaned.toLowerCase().startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).replace(/^\/+/, "");
      break;
    }
  }
  return cleaned.trim().toLowerCase();
}

export function NewChatPanel({ onClose, onChatOpened }: NewChatPanelProps) {
  const { user } = useAuthStore();
  const {
    contacts,
    directoryUsers,
    fetchContacts,
    searchDirectoryUsers,
    addContactById,
    startDirectChat,
  } = useChatStore();

  const [tab, setTab] = useState<PanelTab>("contacts");
  const [search, setSearch] = useState("");

  // Add-by-ID form state
  const [identifierInput, setIdentifierInput] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addFeedback, setAddFeedback] = useState<{
    kind: "ok" | "err";
    text: string;
    addedPeerId?: string;
  } | null>(null);

  // QR state
  const [qrMode, setQrMode] = useState<QrSubMode>("my-qr");
  const [myQrDataUrl, setMyQrDataUrl] = useState<string>("");
  const [copiedId, setCopiedId] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  useEffect(() => {
    fetchContacts().catch(() => undefined);
    searchDirectoryUsers("").catch(() => undefined);
  }, [fetchContacts, searchDirectoryUsers]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      searchDirectoryUsers(search);
    }, 150);
    return () => window.clearTimeout(t);
  }, [search, searchDirectoryUsers]);

  // Generate QR code for my Global ID
  useEffect(() => {
    if (!user) return;
    const qrPayload = `relaychat:${user.global_id}`;
    QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 2,
      color: { dark: "#111b21", light: "#ffffff" },
    })
      .then(setMyQrDataUrl)
      .catch(() => setMyQrDataUrl(""));
  }, [user]);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
  }, []);

  const handleDecodedQrValue = useCallback(
    async (rawValue: string) => {
      const parsedId = extractRelayChatIdFromQr(rawValue);
      if (!parsedId) return;
      stopCamera();
      setScanStatus(`Detected ${parsedId} — adding contact...`);
      try {
        const added = await addContactById(parsedId);
        await startDirectChat({ peerId: added.contact_user_id });
        onChatOpened();
      } catch (err) {
        setCameraError(
          err instanceof Error ? err.message : `Could not add '${parsedId}'.`
        );
      }
    },
    [addContactById, startDirectChat, stopCamera, onChatOpened]
  );

  // Start / stop browser camera QR scanner
  useEffect(() => {
    if (tab !== "qr" || qrMode !== "scan") {
      stopCamera();
      return;
    }

    let cancelled = false;
    setCameraError(null);
    setScanStatus("Point your camera at a RelayChat QR code...");

    const startScanner = async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        setCameraError(
          "Camera access is unavailable in this browser context. You can upload a QR image below."
        );
        return;
      }

      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }

        const offscreen = document.createElement("canvas");
        const ctx = offscreen.getContext("2d", { willReadFrequently: true });

        const scanLoop = () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (
            video &&
            ctx &&
            video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA &&
            video.videoWidth > 0
          ) {
            offscreen.width = video.videoWidth;
            offscreen.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
            const imgData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height);
            if (code?.data) {
              handleDecodedQrValue(code.data);
              return;
            }
          }
          rafRef.current = requestAnimationFrame(scanLoop);
        };

        rafRef.current = requestAnimationFrame(scanLoop);
      } catch {
        setCameraError(
          "Camera permission denied or no camera hardware detected. Use 'Scan QR Image' below."
        );
      }
    };

    startScanner();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [tab, qrMode, stopCamera, handleDecodedQrValue]);

  const handleScanQrImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCameraError(null);
    const url = URL.createObjectURL(f);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Invalid image file."));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable.");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(data.data, data.width, data.height);
      if (!code?.data) {
        setCameraError("No valid QR code found in the selected image.");
        return;
      }
      await handleDecodedQrValue(code.data);
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : "Failed to scan QR image.");
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = "";
    }
  };

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        (c.nickname && c.nickname.toLowerCase().includes(q)) ||
        c.user.display_name.toLowerCase().includes(q) ||
        c.user.global_id.toLowerCase().includes(q)
    );
  }, [contacts, search]);

  const contactIds = useMemo(
    () => new Set(contacts.map((c) => c.contact_user_id)),
    [contacts]
  );

  const nonContactDirectory = useMemo(
    () => directoryUsers.filter((u) => !contactIds.has(u.id)),
    [directoryUsers, contactIds]
  );

  const handleAddByIdSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifierInput.trim()) return;
    setAdding(true);
    setAddFeedback(null);
    try {
      const created = await addContactById(identifierInput, nicknameInput);
      setAddFeedback({
        kind: "ok",
        text: `Added ${created.user.effective_name} (${created.user.global_id}) to your contacts.`,
        addedPeerId: created.contact_user_id,
      });
      setIdentifierInput("");
      setNicknameInput("");
    } catch (err) {
      setAddFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "Failed to add contact.",
      });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="w-full h-full flex flex-col border-r select-none"
      data-testid="new-chat-panel"
    >
      {/* WhatsApp-style Emerald Slide-Over Header */}
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
        <h2 className="text-base font-semibold">New Chat & Contacts</h2>
      </header>

      {/* Mode Tabs */}
      <div
        style={{
          backgroundColor: "var(--rc-header-bg)",
          borderColor: "var(--rc-border)",
        }}
        className="grid grid-cols-3 border-b text-xs font-semibold shrink-0"
      >
        {(
          [
            { id: "contacts", label: "Contacts", icon: <Search className="w-3.5 h-3.5" /> },
            { id: "add-id", label: "Add by ID", icon: <UserPlus className="w-3.5 h-3.5" /> },
            { id: "qr", label: "QR Code", icon: <QrCode className="w-3.5 h-3.5" /> },
          ] as { id: PanelTab; label: string; icon: React.ReactNode }[]
        ).map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              data-testid={`new-chat-tab-${item.id}`}
              style={{
                color: active ? "var(--rc-accent)" : "var(--rc-text-secondary)",
                borderColor: active ? "var(--rc-accent)" : "transparent",
              }}
              className="py-2.5 border-b-2 flex items-center justify-center gap-1.5 transition hover:opacity-90"
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: SEARCH CONTACTS & DIRECTORY */}
      {tab === "contacts" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div
            style={{ borderColor: "var(--rc-border)" }}
            className="p-3 border-b shrink-0"
          >
            <div
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
            >
              <Search
                style={{ color: "var(--rc-text-secondary)" }}
                className="w-4 h-4 shrink-0"
              />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts or username@domain"
                data-testid="new-chat-search-input"
                style={{ color: "var(--rc-text-primary)" }}
                className="w-full bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto rc-scrollbar">
            {/* Quick Action Rows */}
            <div
              style={{ borderColor: "var(--rc-border)" }}
              className="p-2 border-b space-y-0.5"
            >
              <button
                type="button"
                onClick={() => setTab("add-id")}
                className="w-full px-3 py-2.5 rounded-xl flex items-center gap-3 hover:bg-[var(--rc-hover-bg)] transition text-left"
              >
                <span className="w-10 h-10 rounded-full bg-[#00a884] text-white flex items-center justify-center shrink-0">
                  <UserPlus className="w-5 h-5" />
                </span>
                <div>
                  <div className="text-sm font-medium">New contact by ID</div>
                  <div
                    style={{ color: "var(--rc-text-secondary)" }}
                    className="text-xs"
                  >
                    Add username@domain across RelayChat
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTab("qr")}
                className="w-full px-3 py-2.5 rounded-xl flex items-center gap-3 hover:bg-[var(--rc-hover-bg)] transition text-left"
              >
                <span className="w-10 h-10 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center justify-center shrink-0">
                  <QrCode className="w-5 h-5" />
                </span>
                <div>
                  <div className="text-sm font-medium">Share or scan QR code</div>
                  <div
                    style={{ color: "var(--rc-text-secondary)" }}
                    className="text-xs"
                  >
                    Scan a friend&apos;s camera QR to connect
                  </div>
                </div>
              </button>
            </div>

            {/* Saved Contacts Section */}
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[#00a884]">
              My Contacts ({filteredContacts.length})
            </div>

            {filteredContacts.length === 0 ? (
              <div
                style={{ color: "var(--rc-text-secondary)" }}
                className="px-4 py-4 text-xs"
              >
                No saved contacts matching your search yet.
              </div>
            ) : (
              filteredContacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={async () => {
                    await startDirectChat({ peerId: c.contact_user_id });
                    onChatOpened();
                  }}
                  data-testid={`contact-row-${c.user.username}`}
                  className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--rc-hover-bg)] transition text-left"
                >
                  <Avatar
                    name={c.user.effective_name}
                    src={c.user.avatar_url || undefined}
                    size="md"
                    isOnline={c.user.is_online}
                    showOnlineDot
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">
                        {c.user.effective_name}
                      </span>
                      <UserCheck className="w-3.5 h-3.5 text-[#00a884] shrink-0" />
                    </div>
                    <div
                      style={{ color: "var(--rc-text-secondary)" }}
                      className="text-xs font-mono truncate"
                    >
                      {c.user.global_id}
                    </div>
                  </div>
                </button>
              ))
            )}

            {/* Node Directory Section */}
            {nonContactDirectory.length > 0 && (
              <>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider"
                >
                  On This Node ({user?.domain})
                </div>
                {nonContactDirectory.map((peer) => (
                  <button
                    key={peer.id}
                    type="button"
                    onClick={async () => {
                      await startDirectChat({ peerId: peer.id });
                      onChatOpened();
                    }}
                    data-testid={`start-chat-${peer.username}`}
                    className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--rc-hover-bg)] transition text-left"
                  >
                    <Avatar
                      name={peer.effective_name}
                      src={peer.avatar_url || undefined}
                      size="md"
                      isOnline={peer.is_online}
                      showOnlineDot
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {peer.effective_name}
                      </div>
                      <div
                        style={{ color: "var(--rc-text-secondary)" }}
                        className="text-xs font-mono truncate"
                      >
                        {peer.global_id}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: ADD CONTACT BY FULL ID (username@domain) */}
      {tab === "add-id" && (
        <div className="flex-1 overflow-y-auto rc-scrollbar p-4 space-y-4">
          <form onSubmit={handleAddByIdSubmit} className="space-y-3">
            <div>
              <label
                style={{ color: "var(--rc-text-secondary)" }}
                className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              >
                Full RelayChat ID (username@domain)
              </label>
              <input
                type="text"
                autoFocus
                required
                value={identifierInput}
                onChange={(e) => setIdentifierInput(e.target.value)}
                placeholder={`priya@${user?.domain || "chatapp.in"}`}
                data-testid="add-contact-id-input"
                style={{
                  backgroundColor: "var(--rc-header-bg)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full rounded-xl px-3.5 py-2.5 text-sm font-mono border focus:outline-none focus:border-[#00a884]"
              />
              <p
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-[11px] mt-1"
              >
                Local IDs on <span className="font-mono">{user?.domain}</span> resolve
                immediately; external domains route through the federation resolver hook.
              </p>
            </div>

            <div>
              <label
                style={{ color: "var(--rc-text-secondary)" }}
                className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
              >
                Nickname (Optional)
              </label>
              <input
                type="text"
                value={nicknameInput}
                onChange={(e) => setNicknameInput(e.target.value)}
                placeholder="e.g. Priya (Work)"
                data-testid="add-contact-nickname-input"
                style={{
                  backgroundColor: "var(--rc-header-bg)",
                  color: "var(--rc-text-primary)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full rounded-xl px-3.5 py-2.5 text-sm border focus:outline-none focus:border-[#00a884]"
              />
            </div>

            <button
              type="submit"
              disabled={adding || !identifierInput.trim()}
              data-testid="add-contact-submit"
              className="w-full py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white text-sm font-semibold flex items-center justify-center gap-2 transition"
            >
              {adding ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4" />
              )}
              <span>{adding ? "Looking up ID..." : "Save Contact"}</span>
            </button>
          </form>

          {addFeedback && (
            <div
              className={`rounded-xl p-3.5 text-xs space-y-2 border ${
                addFeedback.kind === "ok"
                  ? "bg-[#00a884]/10 border-[#00a884]/40 text-[#00a884]"
                  : "bg-red-500/10 border-red-500/40 text-red-500"
              }`}
            >
              <p className="font-medium">{addFeedback.text}</p>
              {addFeedback.addedPeerId && (
                <button
                  type="button"
                  onClick={async () => {
                    await startDirectChat({ peerId: addFeedback.addedPeerId });
                    onChatOpened();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#00a884] text-white font-semibold"
                >
                  Open Encrypted Chat
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: QR CODE GENERATE + CAMERA SCAN */}
      {tab === "qr" && user && (
        <div className="flex-1 overflow-y-auto rc-scrollbar p-4 space-y-4">
          <div
            style={{ backgroundColor: "var(--rc-header-bg)" }}
            className="grid grid-cols-2 p-1 rounded-xl text-xs font-semibold"
          >
            <button
              type="button"
              onClick={() => setQrMode("my-qr")}
              style={{
                backgroundColor:
                  qrMode === "my-qr" ? "var(--rc-surface-elevated)" : undefined,
              }}
              className="py-2 rounded-lg flex items-center justify-center gap-1.5 transition"
            >
              <QrCode className="w-3.5 h-3.5 text-[#00a884]" /> My Code
            </button>
            <button
              type="button"
              onClick={() => setQrMode("scan")}
              data-testid="qr-scan-mode-button"
              style={{
                backgroundColor:
                  qrMode === "scan" ? "var(--rc-surface-elevated)" : undefined,
              }}
              className="py-2 rounded-lg flex items-center justify-center gap-1.5 transition"
            >
              <Camera className="w-3.5 h-3.5 text-[#00a884]" /> Scan Camera
            </button>
          </div>

          {qrMode === "my-qr" ? (
            <div className="flex flex-col items-center text-center space-y-4 pt-2">
              <div className="bg-white p-4 rounded-2xl shadow-lg border border-slate-200">
                {myQrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={myQrDataUrl}
                    alt={`QR code for ${user.global_id}`}
                    data-testid="my-id-qr-image"
                    className="w-52 h-52"
                  />
                ) : (
                  <div className="w-52 h-52 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 animate-spin text-[#00a884]" />
                  </div>
                )}
              </div>

              <div>
                <div className="text-sm font-semibold">{user.display_name}</div>
                <div className="text-xs font-mono text-[#00a884] mt-0.5">
                  {user.global_id}
                </div>
              </div>

              <div className="flex items-center gap-2 w-full">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(user.global_id);
                    setCopiedId(true);
                    setTimeout(() => setCopiedId(false), 1800);
                  }}
                  style={{
                    backgroundColor: "var(--rc-header-bg)",
                    color: "var(--rc-text-primary)",
                  }}
                  className="flex-1 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 hover:opacity-90 transition"
                >
                  {copiedId ? (
                    <Check className="w-4 h-4 text-[#00a884]" />
                  ) : (
                    <Copy className="w-4 h-4 text-[#00a884]" />
                  )}
                  <span>{copiedId ? "Copied!" : "Copy ID"}</span>
                </button>

                {myQrDataUrl && (
                  <a
                    href={myQrDataUrl}
                    download={`${user.username}-relaychat-qr.png`}
                    className="flex-1 py-2.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                  >
                    <Download className="w-4 h-4" />
                    <span>Save QR</span>
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative rounded-2xl overflow-hidden bg-black aspect-square border border-[var(--rc-border)] flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-8 border-2 border-[#00a884]/80 rounded-2xl pointer-events-none flex items-center justify-center">
                  <ScanLine className="w-8 h-8 text-[#00a884] animate-pulse" />
                </div>
              </div>

              {scanStatus && !cameraError && (
                <p
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs text-center"
                >
                  {scanStatus}
                </p>
              )}

              {cameraError && (
                <div className="rounded-xl p-3 bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs">
                  {cameraError}
                </div>
              )}

              <label
                style={{
                  backgroundColor: "var(--rc-header-bg)",
                  borderColor: "var(--rc-border)",
                }}
                className="w-full py-2.5 px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer hover:opacity-90 transition"
              >
                <ImageUp className="w-4 h-4 text-[#00a884]" />
                <span>Scan QR Code from Image File</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleScanQrImageFile}
                  data-testid="qr-file-upload-input"
                  className="hidden"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
