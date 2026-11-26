"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Eye,
  Image as ImageIcon,
  Loader2,
  Lock,
  Palette,
  Send,
  Shield,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import {
  encryptAndUploadAttachment,
  fetchAndDecryptAttachmentBlob,
} from "@/lib/api/attachments";
import {
  ApiStatusFeed,
  ApiStatusItem,
  ApiStatusRecipientCandidate,
  ApiStatusViewer,
  StatusFontFamily,
  StatusPrivacyMode,
} from "@/lib/api/client";
import {
  DecryptedStatusPayload,
  decryptStatusForViewer,
  encryptStatusForRecipients,
} from "@/lib/crypto/statusEncryption";
import { loadIdentityKeyFromIndexedDB } from "@/lib/crypto/keystore";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

const STATUS_BACKGROUNDS = [
  "linear-gradient(135deg, #00a884 0%, #0f172a 100%)",
  "linear-gradient(135deg, #2563eb 0%, #1e1b4b 100%)",
  "linear-gradient(135deg, #7c3aed 0%, #3b0764 100%)",
  "linear-gradient(135deg, #e11d48 0%, #4c0519 100%)",
  "linear-gradient(135deg, #ea580c 0%, #431407 100%)",
  "linear-gradient(135deg, #0d9488 0%, #042f2e 100%)",
  "#111b21",
];

const FONT_FAMILIES: { id: StatusFontFamily; label: string; cssClass: string }[] = [
  { id: "sans", label: "Sans", cssClass: "font-sans" },
  { id: "serif", label: "Serif", cssClass: "font-serif" },
  { id: "mono", label: "Mono", cssClass: "font-mono" },
  { id: "display", label: "Bold", cssClass: "font-sans font-extrabold tracking-tight" },
];

function fontClassFor(font?: string | null): string {
  return FONT_FAMILIES.find((f) => f.id === font)?.cssClass || "font-sans";
}

function relativeTimeLabel(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

export interface StatusPanelProps {
  onBack: () => void;
  onOpenedChatFromReply?: (chatId: string) => void;
}

export function StatusPanel({ onBack, onOpenedChatFromReply }: StatusPanelProps) {
  const { user, authedRequest } = useAuthStore();
  const { statusFeedVersion, sendStatusReplyMessage, selectChat } = useChatStore();

  const [feed, setFeed] = useState<ApiStatusFeed | null>(null);
  const [candidates, setCandidates] = useState<ApiStatusRecipientCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMutedSection, setShowMutedSection] = useState(false);

  // Privacy modal state
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [privacyMode, setPrivacyMode] = useState<StatusPrivacyMode>("contacts");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [savingPrivacy, setSavingPrivacy] = useState(false);

  // Composer state
  const [composerMode, setComposerMode] = useState<"none" | "text" | "media">("none");
  const [textDraft, setTextDraft] = useState("");
  const [bgIndex, setBgIndex] = useState(0);
  const [fontIndex, setFontIndex] = useState(0);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaCaption, setMediaCaption] = useState("");
  const [posting, setPosting] = useState(false);

  // Story Viewer state
  const [viewerItems, setViewerItems] = useState<ApiStatusItem[] | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [decryptedItem, setDecryptedItem] = useState<DecryptedStatusPayload | null>(null);
  const [decryptedMediaUrl, setDecryptedMediaUrl] = useState<string | null>(null);
  const [decryptingStory, setDecryptingStory] = useState(false);
  const [showViewersDrawer, setShowViewersDrawer] = useState(false);
  const [liveViewers, setLiveViewers] = useState<ApiStatusViewer[]>([]);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadFeed = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const [feedData, rcpts] = await Promise.all([
        authedRequest<ApiStatusFeed>("/statuses"),
        authedRequest<ApiStatusRecipientCandidate[]>("/statuses/recipients"),
      ]);
      setFeed(feedData);
      setCandidates(rcpts);
      setPrivacyMode(feedData.privacy.mode);
      setSelectedIds(
        feedData.privacy.mode === "except"
          ? feedData.privacy.except_user_ids
          : feedData.privacy.mode === "only"
            ? feedData.privacy.only_user_ids
            : []
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status updates.");
    } finally {
      setLoading(false);
    }
  }, [user, authedRequest]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed, statusFeedVersion]);

  const chosenRecipients = useMemo(() => {
    if (privacyMode === "except") {
      const excluded = new Set(selectedIds);
      return candidates.filter((c) => !excluded.has(c.user_id));
    }
    if (privacyMode === "only") {
      const allowed = new Set(selectedIds);
      return candidates.filter((c) => allowed.has(c.user_id));
    }
    return candidates;
  }, [candidates, privacyMode, selectedIds]);

  const handleSavePrivacy = async () => {
    setSavingPrivacy(true);
    setError(null);
    try {
      await authedRequest("/statuses/privacy", {
        method: "PUT",
        body: JSON.stringify({
          mode: privacyMode,
          except_user_ids: privacyMode === "except" ? selectedIds : [],
          only_user_ids: privacyMode === "only" ? selectedIds : [],
        }),
      });
      setPrivacyOpen(false);
      await loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save status privacy.");
    } finally {
      setSavingPrivacy(false);
    }
  };

  const handleSelectMediaFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    setMediaFile(f);
    setMediaPreviewUrl(URL.createObjectURL(f));
    setMediaCaption("");
    setComposerMode("media");
  };

  const handlePublishStatus = async () => {
    if (!user) return;
    const storedKey = await loadIdentityKeyFromIndexedDB(user.global_id);
    if (!storedKey?.privateKeyJwk) {
      setError("Restore your E2EE private key before posting an encrypted status.");
      return;
    }

    setPosting(true);
    setError(null);
    try {
      const bgStyle = STATUS_BACKGROUNDS[bgIndex % STATUS_BACKGROUNDS.length];
      const fontId = FONT_FAMILIES[fontIndex % FONT_FAMILIES.length].id;

      if (composerMode === "text") {
        if (!textDraft.trim()) return;
        const enc = await encryptStatusForRecipients({
          authorUserId: user.id,
          authorPrivateKeyJwk: storedKey.privateKeyJwk,
          authorPublicKeyJwk: user.public_key,
          recipients: chosenRecipients.map((r) => ({
            userId: r.user_id,
            publicKey: r.public_key,
          })),
          payload: {
            kind: "text",
            text: textDraft.trim(),
            fontFamily: fontId,
            backgroundStyle: bgStyle,
          },
        });

        await authedRequest("/statuses", {
          method: "POST",
          body: JSON.stringify({
            media_type: "text",
            ciphertext: enc.ciphertext,
            nonce: enc.nonce,
            key_envelopes: enc.keyEnvelopes,
            background_style: bgStyle,
            font_family: fontId,
            privacy_mode: privacyMode,
            target_user_ids:
              privacyMode === "contacts" ? [] : selectedIds,
          }),
        });
        setTextDraft("");
        setComposerMode("none");
      } else if (composerMode === "media" && mediaFile) {
        const isVideo = mediaFile.type.startsWith("video/");
        const abortCtrl = new AbortController();
        const uploaded = await encryptAndUploadAttachment({
          conversationId: null,
          blob: mediaFile,
          fileName: mediaFile.name,
          mimeType: mediaFile.type || (isVideo ? "video/mp4" : "image/jpeg"),
          signal: abortCtrl.signal,
        });

        const enc = await encryptStatusForRecipients({
          authorUserId: user.id,
          authorPrivateKeyJwk: storedKey.privateKeyJwk,
          authorPublicKeyJwk: user.public_key,
          recipients: chosenRecipients.map((r) => ({
            userId: r.user_id,
            publicKey: r.public_key,
          })),
          payload: {
            kind: isVideo ? "video" : "image",
            caption: mediaCaption.trim(),
            encryptedRef: {
              attachmentId: uploaded.attachmentId,
              fileKeyB64: uploaded.fileKeyB64,
              baseNonceB64: uploaded.baseNonceB64,
              chunkSize: uploaded.chunkSize,
              chunkCount: uploaded.chunkCount,
              encryptedChunkLengths: uploaded.encryptedChunkLengths,
              totalSizeBytes: uploaded.totalSizeBytes,
              mimeType: uploaded.mimeType,
              downloadUrl: uploaded.downloadUrl,
            },
          },
        });

        await authedRequest("/statuses", {
          method: "POST",
          body: JSON.stringify({
            media_type: isVideo ? "video" : "image",
            ciphertext: enc.ciphertext,
            nonce: enc.nonce,
            key_envelopes: enc.keyEnvelopes,
            attachment_id: uploaded.attachmentId,
            privacy_mode: privacyMode,
            target_user_ids:
              privacyMode === "contacts" ? [] : selectedIds,
          }),
        });
        if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
        setMediaFile(null);
        setMediaPreviewUrl(null);
        setMediaCaption("");
        setComposerMode("none");
      }

      await loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish status.");
    } finally {
      setPosting(false);
    }
  };

  // Decrypt & mark viewed whenever viewer opens or advances a story
  const currentStory = viewerItems ? viewerItems[viewerIndex] || null : null;

  useEffect(() => {
    let cancelled = false;
    if (!currentStory || !user) {
      setDecryptedItem(null);
      setDecryptedMediaUrl(null);
      return;
    }

    (async () => {
      setDecryptingStory(true);
      setDecryptedItem(null);
      setDecryptedMediaUrl(null);
      setShowViewersDrawer(false);

      try {
        const stored = await loadIdentityKeyFromIndexedDB(user.global_id);
        if (stored?.privateKeyJwk && currentStory.my_key_envelope) {
          const payload = await decryptStatusForViewer({
            viewerUserId: user.id,
            viewerPrivateKeyJwk: stored.privateKeyJwk,
            authorPublicKey: currentStory.author_public_key,
            ciphertext: currentStory.ciphertext,
            nonce: currentStory.nonce,
            myKeyEnvelope: currentStory.my_key_envelope,
          });
          if (cancelled) return;
          setDecryptedItem(payload);

          if (payload.encryptedRef) {
            const mediaBlob = await fetchAndDecryptAttachmentBlob(payload.encryptedRef);
            if (!cancelled) {
              setDecryptedMediaUrl(mediaBlob.url);
            }
          }
        }

        if (currentStory.user_id !== user.id) {
          await authedRequest(`/statuses/${currentStory.id}/view`, {
            method: "POST",
          }).catch(() => undefined);
        } else {
          const vList = await authedRequest<ApiStatusViewer[]>(
            `/statuses/${currentStory.id}/viewers`
          ).catch(() => currentStory.viewers || []);
          if (!cancelled) setLiveViewers(vList);
        }
      } catch {
        // Decryption error handled in UI
      } finally {
        if (!cancelled) setDecryptingStory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentStory, user, authedRequest]);

  const handleDeleteCurrentStatus = async () => {
    if (!currentStory) return;
    await authedRequest(`/statuses/${currentStory.id}`, { method: "DELETE" });
    setViewerItems(null);
    await loadFeed();
  };

  const handleToggleMuteAuthor = async (authorUserId: string, currentlyMuted: boolean) => {
    await authedRequest(`/statuses/mute/${encodeURIComponent(authorUserId)}`, {
      method: currentlyMuted ? "DELETE" : "POST",
    });
    await loadFeed();
  };

  const handleSendStatusReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentStory || !replyText.trim()) return;
    setSendingReply(true);
    try {
      const preview =
        decryptedItem?.text ||
        decryptedItem?.caption ||
        (currentStory.media_type === "video" ? "Video story" : "Photo story");
      const chatId = await sendStatusReplyMessage({
        authorUserId: currentStory.user_id,
        authorGlobalId: currentStory.author_global_id,
        statusId: currentStory.id,
        mediaType: currentStory.media_type,
        previewText: preview.slice(0, 100),
        backgroundStyle: currentStory.background_style,
        replyText: replyText.trim(),
      });
      setReplyText("");
      setViewerItems(null);
      if (chatId) {
        await selectChat(chatId);
        onOpenedChatFromReply?.(chatId);
      }
    } finally {
      setSendingReply(false);
    }
  };

  return (
    <aside
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="w-full h-full flex flex-col border-r select-none relative"
      data-testid="status-panel"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={handleSelectMediaFile}
      />

      {/* Header */}
      <header
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="h-[60px] px-4 flex items-center justify-between shrink-0"
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            style={{ color: "var(--rc-text-primary)" }}
            className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            aria-label="Back to chats"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2
              style={{ color: "var(--rc-text-primary)" }}
              className="text-base font-semibold leading-tight"
            >
              Status (24h Stories)
            </h2>
            <p
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[11px] flex items-center gap-1"
            >
              <Lock className="w-3 h-3 text-[#00a884]" /> End-to-end encrypted
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPrivacyOpen((v) => !v)}
          data-testid="status-privacy-button"
          className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#00a884]/15 text-[#00a884] hover:bg-[#00a884]/25 flex items-center gap-1.5 transition"
        >
          <Shield className="w-3.5 h-3.5" />
          Privacy
        </button>
      </header>

      {error && (
        <div className="mx-3 mt-2 p-2.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-xs text-rose-400 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Privacy Drawer */}
      {privacyOpen && (
        <div
          style={{
            backgroundColor: "var(--rc-panel-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="mx-3 mt-3 p-3.5 rounded-xl border space-y-3"
        >
          <div className="flex items-center justify-between">
            <span
              style={{ color: "var(--rc-text-primary)" }}
              className="text-xs font-semibold"
            >
              Who can see my status updates
            </span>
            <button
              type="button"
              onClick={() => setPrivacyOpen(false)}
              style={{ color: "var(--rc-text-secondary)" }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { id: "contacts", label: "My contacts" },
                { id: "except", label: "Contacts except..." },
                { id: "only", label: "Only share with..." },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setPrivacyMode(opt.id);
                  if (opt.id === "contacts") setSelectedIds([]);
                }}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium border transition ${
                  privacyMode === opt.id
                    ? "border-[#00a884] bg-[#00a884]/15 text-[#00a884]"
                    : "border-white/10 text-slate-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {privacyMode !== "contacts" && (
            <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
              {candidates.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  Add contacts first to customize per-contact status sharing.
                </p>
              ) : (
                candidates.map((c) => {
                  const checked = selectedIds.includes(c.user_id);
                  return (
                    <label
                      key={c.user_id}
                      className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer text-xs"
                    >
                      <span style={{ color: "var(--rc-text-primary)" }}>
                        {c.display_name}{" "}
                        <span className="text-[10px] font-mono text-slate-400">
                          ({c.global_id})
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedIds((prev) =>
                            checked
                              ? prev.filter((x) => x !== c.user_id)
                              : [...prev, c.user_id]
                          )
                        }
                        className="accent-[#00a884]"
                      />
                    </label>
                  );
                })
              )}
            </div>
          )}

          <button
            type="button"
            disabled={savingPrivacy}
            onClick={handleSavePrivacy}
            className="w-full py-1.5 rounded-lg bg-[#00a884] hover:bg-[#009675] text-white text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            {savingPrivacy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            Save Status Privacy ({chosenRecipients.length} eligible contacts)
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* My Status Card */}
        <div
          style={{
            backgroundColor: "var(--rc-panel-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="p-3 rounded-xl border space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                if (feed?.my_statuses && feed.my_statuses.length > 0) {
                  setViewerItems(feed.my_statuses);
                  setViewerIndex(0);
                } else {
                  setComposerMode("text");
                }
              }}
              className="flex items-center gap-3 min-w-0 text-left"
            >
              <div
                className={`p-0.5 rounded-full ${
                  feed?.my_statuses?.length
                    ? "ring-2 ring-[#00a884]"
                    : "ring-1 ring-slate-500/40"
                }`}
              >
                <Avatar
                  name={user?.display_name || "Me"}
                  src={user?.avatar_url || undefined}
                  size="md"
                />
              </div>
              <div className="min-w-0">
                <div
                  style={{ color: "var(--rc-text-primary)" }}
                  className="text-sm font-semibold truncate"
                >
                  My Status
                </div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-xs truncate"
                >
                  {feed?.my_statuses?.length
                    ? `${feed.my_statuses.length} active • Tap to view viewers`
                    : "Disappears automatically after 24 hours"}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setComposerMode("text")}
                data-testid="compose-text-status-btn"
                className="p-2 rounded-full bg-[#00a884]/15 text-[#00a884] hover:bg-[#00a884]/25 transition"
                title="Post text status"
              >
                <Type className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                data-testid="compose-media-status-btn"
                className="p-2 rounded-full bg-[#00a884] text-white hover:bg-[#009675] transition"
                title="Post encrypted photo or video status"
              >
                <ImageIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Inline Status Composer */}
        {composerMode !== "none" && (
          <div className="rounded-2xl overflow-hidden border border-white/15 shadow-xl">
            {composerMode === "text" ? (
              <div
                style={{
                  background:
                    STATUS_BACKGROUNDS[bgIndex % STATUS_BACKGROUNDS.length],
                }}
                className="p-4 min-h-[210px] flex flex-col justify-between text-white"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setBgIndex((i) => i + 1)}
                      className="px-2.5 py-1 rounded-full bg-black/30 hover:bg-black/45 text-xs flex items-center gap-1"
                    >
                      <Palette className="w-3.5 h-3.5" /> Color
                    </button>
                    <button
                      type="button"
                      onClick={() => setFontIndex((i) => i + 1)}
                      className="px-2.5 py-1 rounded-full bg-black/30 hover:bg-black/45 text-xs flex items-center gap-1"
                    >
                      <Type className="w-3.5 h-3.5" />{" "}
                      {FONT_FAMILIES[fontIndex % FONT_FAMILIES.length].label}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setComposerMode("none")}
                    className="p-1 rounded-full bg-black/30 hover:bg-black/45"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <textarea
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  placeholder="Type a 24-hour status..."
                  rows={3}
                  maxLength={500}
                  data-testid="status-text-input"
                  className={`w-full bg-transparent resize-none text-center text-lg placeholder-white/60 focus:outline-none my-4 ${
                    FONT_FAMILIES[fontIndex % FONT_FAMILIES.length].cssClass
                  }`}
                />

                <div className="flex items-center justify-between text-[11px] text-white/80">
                  <span>
                    Encrypted for {chosenRecipients.length} contact
                    {chosenRecipients.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    disabled={posting || !textDraft.trim()}
                    onClick={handlePublishStatus}
                    data-testid="publish-status-btn"
                    className="px-3.5 py-1.5 rounded-full bg-white text-slate-900 font-semibold flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {posting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Share
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-slate-950 p-3 space-y-3 text-white">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300 truncate">
                    {mediaFile?.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
                      setMediaFile(null);
                      setMediaPreviewUrl(null);
                      setComposerMode("none");
                    }}
                  >
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>

                {mediaPreviewUrl &&
                  (mediaFile?.type.startsWith("video/") ? (
                    <video
                      src={mediaPreviewUrl}
                      controls
                      className="w-full max-h-48 rounded-lg object-contain bg-black"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={mediaPreviewUrl}
                      alt="Preview"
                      className="w-full max-h-48 rounded-lg object-contain bg-black"
                    />
                  ))}

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={mediaCaption}
                    onChange={(e) => setMediaCaption(e.target.value)}
                    placeholder="Add an encrypted caption..."
                    className="flex-1 px-3 py-1.5 rounded-full bg-white/10 text-xs text-white placeholder-slate-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={posting}
                    onClick={handlePublishStatus}
                    className="px-3.5 py-1.5 rounded-full bg-[#00a884] text-white text-xs font-semibold flex items-center gap-1"
                  >
                    {posting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Post
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent Updates */}
        {loading ? (
          <div className="py-10 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-[#00a884]" />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <h3
                style={{ color: "var(--rc-text-secondary)" }}
                className="px-1 text-[11px] font-semibold uppercase tracking-wider"
              >
                Recent updates ({feed?.recent_updates.length || 0})
              </h3>
              {!feed?.recent_updates.length ? (
                <div
                  style={{ color: "var(--rc-text-muted)" }}
                  className="py-6 text-center text-xs flex flex-col items-center gap-2"
                >
                  <CircleDashed className="w-7 h-7 opacity-50" />
                  <span>No active contact stories in the last 24 hours.</span>
                </div>
              ) : (
                feed.recent_updates.map((bundle) => (
                  <div
                    key={bundle.user_id}
                    className="px-2.5 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-between gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setViewerItems(bundle.statuses);
                        setViewerIndex(0);
                      }}
                      className="flex items-center gap-3 min-w-0 flex-1 text-left"
                    >
                      <div
                        className={`p-0.5 rounded-full ${
                          bundle.all_viewed
                            ? "ring-2 ring-slate-400/50"
                            : "ring-2 ring-[#00a884]"
                        }`}
                      >
                        <Avatar
                          name={bundle.display_name}
                          src={bundle.avatar_url || undefined}
                          size="md"
                        />
                      </div>
                      <div className="min-w-0">
                        <div
                          style={{ color: "var(--rc-text-primary)" }}
                          className="text-sm font-medium truncate"
                        >
                          {bundle.display_name}
                        </div>
                        <div
                          style={{ color: "var(--rc-text-secondary)" }}
                          className="text-xs truncate"
                        >
                          {bundle.statuses.length} story •{" "}
                          {relativeTimeLabel(bundle.latest_at)}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleToggleMuteAuthor(bundle.user_id, false)}
                      style={{ color: "var(--rc-text-muted)" }}
                      className="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                      title="Mute status updates"
                    >
                      <VolumeX className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Muted Updates */}
            {feed?.muted_updates && feed.muted_updates.length > 0 && (
              <div className="pt-2 border-t border-white/10 space-y-1.5">
                <button
                  type="button"
                  onClick={() => setShowMutedSection((v) => !v)}
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="w-full px-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider"
                >
                  <span>Muted updates ({feed.muted_updates.length})</span>
                  <ChevronDown
                    className={`w-4 h-4 transition ${showMutedSection ? "rotate-180" : ""}`}
                  />
                </button>
                {showMutedSection &&
                  feed.muted_updates.map((bundle) => (
                    <div
                      key={bundle.user_id}
                      className="px-2.5 py-2 rounded-xl opacity-75 hover:opacity-100 flex items-center justify-between gap-2"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setViewerItems(bundle.statuses);
                          setViewerIndex(0);
                        }}
                        className="flex items-center gap-3 min-w-0 flex-1 text-left"
                      >
                        <Avatar
                          name={bundle.display_name}
                          src={bundle.avatar_url || undefined}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div
                            style={{ color: "var(--rc-text-primary)" }}
                            className="text-xs font-medium truncate"
                          >
                            {bundle.display_name}
                          </div>
                          <div
                            style={{ color: "var(--rc-text-secondary)" }}
                            className="text-[11px]"
                          >
                            {relativeTimeLabel(bundle.latest_at)}
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleToggleMuteAuthor(bundle.user_id, true)}
                        className="px-2 py-1 rounded-md text-[11px] text-[#00a884] hover:bg-[#00a884]/15 flex items-center gap-1"
                      >
                        <Volume2 className="w-3.5 h-3.5" /> Unmute
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Fullscreen Story Viewer Modal */}
      {viewerItems && currentStory && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col justify-between text-white">
          {/* Segmented Progress Bars */}
          <div className="p-3 space-y-2.5 max-w-lg w-full mx-auto">
            <div className="flex gap-1">
              {viewerItems.map((st, idx) => (
                <div
                  key={st.id}
                  className="h-1 flex-1 rounded-full bg-white/25 overflow-hidden"
                >
                  <div
                    className={`h-full bg-white transition-all ${
                      idx <= viewerIndex ? "w-full" : "w-0"
                    }`}
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Avatar
                  name={currentStory.author_display_name}
                  src={currentStory.author_avatar_url || undefined}
                  size="sm"
                />
                <div>
                  <div className="text-sm font-semibold">
                    {currentStory.user_id === user?.id
                      ? "My Status"
                      : currentStory.author_display_name}
                  </div>
                  <div className="text-[11px] text-white/70">
                    {relativeTimeLabel(currentStory.created_at)} • E2EE
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {currentStory.user_id === user?.id && (
                  <button
                    type="button"
                    onClick={handleDeleteCurrentStatus}
                    className="p-2 rounded-full bg-white/10 hover:bg-rose-500/30 text-rose-300"
                    title="Delete status"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setViewerItems(null)}
                  className="p-2 rounded-full bg-white/10 hover:bg-white/20"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>

          {/* Main Story Canvas */}
          <div className="flex-1 flex items-center justify-center relative px-4 max-w-lg w-full mx-auto">
            {viewerIndex > 0 && (
              <button
                type="button"
                onClick={() => setViewerIndex((i) => Math.max(0, i - 1))}
                className="absolute left-2 z-10 p-2 rounded-full bg-black/40 hover:bg-black/70"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {viewerIndex < viewerItems.length - 1 && (
              <button
                type="button"
                onClick={() =>
                  setViewerIndex((i) => Math.min(viewerItems.length - 1, i + 1))
                }
                className="absolute right-2 z-10 p-2 rounded-full bg-black/40 hover:bg-black/70"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            )}

            {decryptingStory ? (
              <Loader2 className="w-8 h-8 animate-spin text-[#00a884]" />
            ) : currentStory.media_type === "text" ? (
              <div
                style={{
                  background:
                    decryptedItem?.backgroundStyle ||
                    currentStory.background_style ||
                    STATUS_BACKGROUNDS[0],
                }}
                className="w-full aspect-[9/14] max-h-[68vh] rounded-2xl p-8 flex items-center justify-center text-center shadow-2xl"
              >
                <p
                  className={`text-xl sm:text-2xl leading-relaxed break-words ${fontClassFor(
                    decryptedItem?.fontFamily || currentStory.font_family
                  )}`}
                >
                  {decryptedItem?.text || "🔒 Encrypted status"}
                </p>
              </div>
            ) : (
              <div className="w-full max-h-[68vh] flex flex-col items-center gap-3">
                {decryptedMediaUrl ? (
                  currentStory.media_type === "video" ? (
                    <video
                      src={decryptedMediaUrl}
                      controls
                      autoPlay
                      className="max-h-[58vh] rounded-2xl object-contain"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={decryptedMediaUrl}
                      alt="Encrypted story"
                      className="max-h-[58vh] rounded-2xl object-contain"
                    />
                  )
                ) : (
                  <div className="py-12 text-sm text-white/70">
                    Decrypting media story...
                  </div>
                )}
                {decryptedItem?.caption && (
                  <p className="text-sm text-center bg-black/60 px-4 py-2 rounded-xl">
                    {decryptedItem.caption}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Bottom Bar: Author Viewers OR Contact Encrypted Reply */}
          <div className="p-4 max-w-lg w-full mx-auto">
            {currentStory.user_id === user?.id ? (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowViewersDrawer((v) => !v)}
                  className="mx-auto px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 text-xs font-medium flex items-center gap-2"
                >
                  <Eye className="w-4 h-4 text-[#00a884]" />
                  Viewed by {liveViewers.length}
                </button>
                {showViewersDrawer && (
                  <div className="bg-slate-900/95 border border-white/15 rounded-xl p-3 max-h-44 overflow-y-auto space-y-2">
                    {liveViewers.length === 0 ? (
                      <p className="text-xs text-slate-400 text-center">
                        No views yet.
                      </p>
                    ) : (
                      liveViewers.map((v) => (
                        <div
                          key={v.user_id}
                          className="flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <Avatar
                              name={v.display_name}
                              src={v.avatar_url || undefined}
                              size="sm"
                            />
                            <div>
                              <div className="font-medium">{v.display_name}</div>
                              <div className="text-[10px] font-mono text-slate-400">
                                {v.global_id}
                              </div>
                            </div>
                          </div>
                          <span className="text-[11px] text-slate-400">
                            {relativeTimeLabel(v.viewed_at)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={handleSendStatusReply} className="flex gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder={`Reply privately to ${currentStory.author_display_name}...`}
                  className="flex-1 px-4 py-2.5 rounded-full bg-white/15 text-sm text-white placeholder-white/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sendingReply || !replyText.trim()}
                  className="px-4 py-2.5 rounded-full bg-[#00a884] hover:bg-[#009675] text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5"
                >
                  {sendingReply ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Reply
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
