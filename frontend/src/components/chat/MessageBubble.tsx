"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  CornerUpLeft,
  CornerUpRight,
  Download,
  ExternalLink,
  FileText,
  Film,
  Info,
  Loader2,
  Lock,
  MapPin,
  Pause,
  Pencil,
  Play,
  Radio,
  Square,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { LeafletLocationMap } from "@/components/chat/LeafletLocationMap";
import { fetchAndDecryptAttachmentBlob } from "@/lib/api/attachments";
import {
  EncryptedBlobRef,
  FileAttachmentMock,
  ImageAttachmentMock,
  LocationAttachmentMock,
  MessageStatus,
  MockMessage,
  VoiceAttachmentMock,
} from "@/mocks";
import { useChatStore } from "@/store/useChatStore";

export interface LightboxMediaPayload {
  url: string;
  fileName: string;
  caption?: string;
  isVideo?: boolean;
  mimeType?: string;
}

export interface MessageBubbleProps {
  message: MockMessage;
  isGroupChat: boolean;
  showTail: boolean;
  highlighted?: boolean;
  peerAvatarColor?: string;
  onReply: (msg: MockMessage) => void;
  onEdit?: (msg: MockMessage) => void;
  onDelete?: (messageId: string, scope: "me" | "everyone") => void;
  onJumpToMessage: (messageId: string) => void;
  onPreviewImage: (media: LightboxMediaPayload) => void;
  onPreviewLocation: (loc: LocationAttachmentMock) => void;
  onStopLiveLocation?: (messageId: string) => void;
}

const TOKEN_SPLIT_REGEX = /(https?:\/\/[^\s<>"']+|@[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9.-]+)?)/gi;

function renderTextWithLinks(text: string): React.ReactNode {
  const parts = text.split(TOKEN_SPLIT_REGEX);
  return parts.map((part, idx) => {
    if (/^https?:\/\//i.test(part)) {
      return (
        <a
          key={idx}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#027eb5] dark:text-[#53bdeb] underline break-all hover:opacity-85"
          onClick={(e) => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    if (/^@[a-zA-Z0-9_.-]+/.test(part)) {
      return (
        <span
          key={idx}
          data-testid="mention-chip"
          className="inline-block px-1 py-0.2 rounded bg-[#00a884]/15 text-[#00a884] font-semibold"
        >
          {part}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function ReceiptIcon({ status }: { status?: MessageStatus }) {
  if (!status) return null;
  if (status === "pending") {
    return (
      <Clock3
        style={{ color: "var(--rc-tick-unread)" }}
        className="w-3.5 h-3.5 inline-block shrink-0"
      />
    );
  }
  if (status === "sent") {
    return (
      <Check
        style={{ color: "var(--rc-tick-unread)" }}
        className="w-4 h-4 inline-block shrink-0 -mr-0.5"
      />
    );
  }
  if (status === "delivered") {
    return (
      <CheckCheck
        style={{ color: "var(--rc-tick-unread)" }}
        className="w-4 h-4 inline-block shrink-0 -mr-0.5"
      />
    );
  }
  return (
    <CheckCheck
      style={{ color: "var(--rc-tick-read)" }}
      className="w-4 h-4 inline-block shrink-0 -mr-0.5"
    />
  );
}

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function decryptAttachmentRef(ref: EncryptedBlobRef) {
  const res = await fetchAndDecryptAttachmentBlob(ref);
  return { objectUrl: res.url, blob: res.blob };
}

function triggerBrowserDownload(objectUrl: string, fileName: string) {
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function VoiceNotePlayer({
  voice,
  outgoing,
  avatarColor,
}: {
  voice: VoiceAttachmentMock;
  outgoing: boolean;
  avatarColor?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fallback animation timer when playing synthetic/mock voice without audio element
  useEffect(() => {
    if (!playing || audioUrl) return;
    const stepMs = 80;
    const totalMs = (voice.durationSeconds * 1000) / speed;
    const delta = stepMs / totalMs;
    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev + delta >= 1) {
          setPlaying(false);
          return 0;
        }
        return prev + delta;
      });
    }, stepMs);
    return () => clearInterval(timer);
  }, [playing, audioUrl, voice.durationSeconds, speed]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  const handleTogglePlay = async () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }

    if (voice.encryptedRef && !audioUrl) {
      setDecrypting(true);
      try {
        const res = await decryptAttachmentRef(voice.encryptedRef);
        setAudioUrl(res.objectUrl);
        setTimeout(() => {
          if (audioRef.current) {
            audioRef.current.playbackRate = speed;
            audioRef.current
              .play()
              .then(() => setPlaying(true))
              .catch(() => setPlaying(true));
          } else {
            setPlaying(true);
          }
        }, 30);
      } catch {
        setPlaying(true);
      } finally {
        setDecrypting(false);
      }
      return;
    }

    if (audioRef.current && audioUrl) {
      audioRef.current.playbackRate = speed;
      try {
        await audioRef.current.play();
        setPlaying(true);
      } catch {
        setPlaying(true);
      }
    } else {
      setPlaying(true);
    }
  };

  const cycleSpeed = () => {
    setSpeed((s) => (s === 1 ? 1.5 : s === 1.5 ? 2 : 1));
  };

  const handleSeek = (barIndex: number) => {
    const ratio = (barIndex + 0.5) / voice.waveform.length;
    setProgress(ratio);
    if (audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
      audioRef.current.currentTime = ratio * audioRef.current.duration;
    }
  };

  const elapsedSeconds = Math.round(progress * voice.durationSeconds);

  return (
    <div
      data-testid="voice-note-player"
      className="flex items-center gap-2.5 min-w-[245px] sm:min-w-[285px] py-1 pr-1"
    >
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            const dur =
              Number.isFinite(el.duration) && el.duration > 0
                ? el.duration
                : voice.durationSeconds;
            setProgress(Math.min(1, el.currentTime / dur));
          }}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
        />
      )}

      <button
        type="button"
        onClick={handleTogglePlay}
        disabled={decrypting}
        data-testid="voice-play-toggle"
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white shadow-sm transition transform active:scale-95"
        style={{ backgroundColor: outgoing ? "#00a884" : avatarColor || "#00a884" }}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
      >
        {decrypting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : playing ? (
          <Pause className="w-4 h-4 fill-current" />
        ) : (
          <Play className="w-4 h-4 fill-current ml-0.5" />
        )}
      </button>

      <div className="flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-[2px] h-7 cursor-pointer">
          {voice.waveform.map((amp, i) => {
            const ratio = i / voice.waveform.length;
            const active = ratio <= progress;
            return (
              <span
                key={i}
                onClick={() => handleSeek(i)}
                style={{
                  height: `${Math.max(18, Math.round(amp * 100))}%`,
                  backgroundColor: active
                    ? "#00a884"
                    : "rgba(134, 150, 160, 0.45)",
                }}
                className="w-[3px] rounded-full transition-colors"
              />
            );
          })}
        </div>

        <div
          style={{ color: "var(--rc-text-secondary)" }}
          className="flex items-center justify-between text-[11px]"
        >
          <span>
            {playing || progress > 0
              ? formatDuration(elapsedSeconds)
              : formatDuration(voice.durationSeconds)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            data-testid="voice-speed-toggle"
            className="px-1.5 py-0.2 rounded-full bg-black/10 dark:bg-white/10 text-[10px] font-semibold"
          >
            {speed}x
          </button>
        </div>
      </div>
    </div>
  );
}

function EncryptedMediaCard({
  media,
  onPreview,
}: {
  media: ImageAttachmentMock;
  onPreview: (payload: LightboxMediaPayload) => void;
}) {
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!media.encryptedRef) return;
    setDecrypting(true);
    decryptAttachmentRef(media.encryptedRef)
      .then((res) => {
        if (!cancelled) setDecryptedUrl(res.objectUrl);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDecrypting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [media.encryptedRef]);

  const displaySrc = decryptedUrl || media.thumbDataUrl || media.dataUrl;
  const isVideo = !!media.isVideo;

  const handleOpenLightbox = async () => {
    let url = decryptedUrl || media.dataUrl;
    if (!decryptedUrl && media.encryptedRef) {
      setDecrypting(true);
      try {
        const res = await decryptAttachmentRef(media.encryptedRef);
        url = res.objectUrl;
        setDecryptedUrl(res.objectUrl);
      } finally {
        setDecrypting(false);
      }
    }
    if (!url) return;
    onPreview({
      url,
      fileName: media.fileName || (isVideo ? "video.mp4" : "photo.jpg"),
      caption: media.caption,
      isVideo,
      mimeType: media.mimeType,
    });
  };

  return (
    <div className="pt-0.5 pb-1">
      <button
        type="button"
        onClick={handleOpenLightbox}
        data-testid={isVideo ? "video-bubble-preview" : "image-bubble-preview"}
        className="block relative rounded-md overflow-hidden group focus:outline-none w-full text-left bg-black/10 min-w-[230px]"
      >
        {isVideo ? (
          media.thumbDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media.thumbDataUrl}
              alt={media.caption || media.fileName || "Encrypted video"}
              className="w-full max-w-[330px] max-h-[250px] object-cover rounded-md group-hover:brightness-95 transition"
            />
          ) : decryptedUrl ? (
            <video
              src={decryptedUrl}
              muted
              playsInline
              preload="metadata"
              className="w-full max-w-[330px] max-h-[250px] object-cover rounded-md"
            />
          ) : (
            <div className="w-[260px] h-[165px] flex flex-col items-center justify-center gap-2 bg-[#111b21]/85 text-white">
              <Film className="w-8 h-8 text-[#00a884]" />
              <span className="text-xs font-medium">{media.fileName || "Encrypted video"}</span>
            </div>
          )
        ) : displaySrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displaySrc}
            alt={media.caption || "Shared photo"}
            className="w-full max-w-[330px] max-h-[250px] object-cover rounded-md group-hover:brightness-95 transition"
          />
        ) : (
          <div className="w-[260px] h-[165px] flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-[#00a884]" />
          </div>
        )}

        {(isVideo || decrypting) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-12 h-12 rounded-full bg-black/65 text-white flex items-center justify-center shadow-lg group-hover:scale-105 transition">
              {decrypting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-0.5" />
              )}
            </div>
          </div>
        )}

        {isVideo && (
          <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/65 text-white text-[10px] font-medium flex items-center gap-1">
            <Film className="w-3 h-3" />
            {media.durationSeconds
              ? formatDuration(media.durationSeconds)
              : media.fileSize || "Video"}
          </span>
        )}
      </button>

      {media.caption && (
        <p className="text-[14.2px] leading-[19px] pt-1.5 px-1 whitespace-pre-wrap break-words">
          {renderTextWithLinks(media.caption)}
        </p>
      )}
    </div>
  );
}

function EncryptedDocumentCard({ file }: { file: FileAttachmentMock }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownloadAndDecrypt = async () => {
    if (!file.encryptedRef) {
      // Fallback blob download for synthetic non-attachment file cards
      const synthetic = new Blob([`RelayChat document: ${file.fileName}`], {
        type: "application/octet-stream",
      });
      const url = URL.createObjectURL(synthetic);
      triggerBrowserDownload(url, file.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    setDownloading(true);
    try {
      const { objectUrl } = await decryptAttachmentRef(file.encryptedRef);
      triggerBrowserDownload(objectUrl, file.fileName);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      style={{ backgroundColor: "var(--rc-bubble-quote)" }}
      data-testid="document-card"
      className="flex items-center gap-3 p-2.5 rounded-lg min-w-[245px] sm:min-w-[285px] my-0.5"
    >
      <div className="w-10 h-11 rounded-lg bg-[#00a884]/15 text-[#00a884] flex flex-col items-center justify-center shrink-0">
        <FileText className="w-4 h-4" />
        <span className="text-[9px] font-bold uppercase tracking-tight">
          {file.extension.slice(0, 4)}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium truncate">{file.fileName}</div>
        <div
          style={{ color: "var(--rc-text-secondary)" }}
          className="text-[11px] flex items-center gap-1"
        >
          <span>{file.fileSize}</span>
          <span>•</span>
          <span>{file.extension}</span>
          {file.encryptedRef && (
            <>
              <span>•</span>
              <Lock className="w-2.5 h-2.5 text-[#00a884] inline" />
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDownloadAndDecrypt}
        disabled={downloading}
        data-testid="document-download-btn"
        style={{ color: "var(--rc-text-secondary)" }}
        className="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition shrink-0"
        aria-label={`Decrypt and download ${file.fileName}`}
        title="Decrypt & download in browser"
      >
        {downloading ? (
          <Loader2 className="w-4 h-4 animate-spin text-[#00a884]" />
        ) : (
          <Download className="w-4 h-4" />
        )}
      </button>
    </div>
  );
}

function LocationBubbleCard({
  location,
  outgoing,
  messageId,
  onPreviewLocation,
  onStopLiveLocation,
}: {
  location: LocationAttachmentMock;
  outgoing: boolean;
  messageId: string;
  onPreviewLocation: (loc: LocationAttachmentMock) => void;
  onStopLiveLocation?: (messageId: string) => void;
}) {
  const [, setTick] = useState(0);

  // Re-evaluate auto-expiry countdown every 15s for live location cards
  useEffect(() => {
    if (!location.isLive || location.liveStopped) return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [location.isLive, location.liveStopped, location.expiresAt]);

  const isExpiredByClock =
    location.isLive &&
    location.expiresAt &&
    Date.now() >= new Date(location.expiresAt).getTime();
  const isStopped = !!location.liveStopped || !!isExpiredByClock;

  let liveBadgeText = location.liveExpiresLabel || "Live";
  if (location.isLive) {
    if (isStopped) {
      liveBadgeText = "Live location ended";
    } else if (location.expiresAt) {
      const remMin = Math.max(
        1,
        Math.ceil((new Date(location.expiresAt).getTime() - Date.now()) / 60_000)
      );
      liveBadgeText =
        remMin >= 60
          ? `Live • ${Math.floor(remMin / 60)}h ${remMin % 60}m left`
          : `Live • ${remMin}m left`;
    }
  }

  const osmUrl = `https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`;

  return (
    <div
      data-testid={location.isLive ? "live-location-card" : "static-location-card"}
      className="w-[265px] sm:w-[295px] rounded-md overflow-hidden my-0.5 border border-black/10 dark:border-white/10"
    >
      <div
        onClick={() => onPreviewLocation(location)}
        className="relative cursor-pointer"
      >
        <LeafletLocationMap
          latitude={location.latitude}
          longitude={location.longitude}
          isLive={location.isLive && !isStopped}
          interactive={false}
          heightClass="h-32"
        />

        {location.isLive && (
          <span
            className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-white text-[10px] font-semibold flex items-center gap-1 shadow ${
              isStopped ? "bg-slate-600/90" : "bg-[#00a884]"
            }`}
          >
            <Radio className={`w-3 h-3 ${isStopped ? "" : "animate-pulse"}`} />
            {liveBadgeText}
          </span>
        )}
      </div>

      <div
        style={{ backgroundColor: "var(--rc-bubble-quote)" }}
        className="px-2.5 py-2 space-y-1.5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span className="truncate">{location.label}</span>
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[11.5px] truncate"
            >
              {location.address}
            </div>
            <div
              style={{ color: "var(--rc-text-muted)" }}
              className="text-[10px] font-mono"
            >
              {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-black/5 dark:border-white/5">
          <a
            href={osmUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="open-in-maps-link"
            onClick={(e) => e.stopPropagation()}
            className="text-[11px] font-semibold text-[#00a884] hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            <span>Open in Maps</span>
          </a>

          {location.isLive && !isStopped && outgoing && onStopLiveLocation && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStopLiveLocation(messageId);
              }}
              data-testid="stop-live-location-btn"
              className="px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-500 text-[11px] font-semibold inline-flex items-center gap-1 transition"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>Stop sharing</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  isGroupChat,
  showTail,
  highlighted,
  peerAvatarColor,
  onReply,
  onEdit,
  onDelete,
  onJumpToMessage,
  onPreviewImage,
  onPreviewLocation,
  onStopLiveLocation,
}: MessageBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (message.type === "system") {
    const isSecurityBanner = message.id.startsWith("sys-e2ee-");
    return (
      <div className="flex justify-center my-2 px-4" data-testid="system-message-pill">
        <div
          style={{
            backgroundColor: "var(--rc-system-bg)",
            color: "var(--rc-system-text)",
          }}
          className="max-w-md text-center text-[12px] leading-relaxed px-3.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1.5"
        >
          {isSecurityBanner ? (
            <Lock className="w-3.5 h-3.5 shrink-0 opacity-80" />
          ) : (
            <Users className="w-3.5 h-3.5 shrink-0 opacity-75" />
          )}
          <span>{message.text}</span>
        </div>
      </div>
    );
  }

  const outgoing = message.senderId === "me";
  const canEdit =
    outgoing &&
    message.type === "text" &&
    !message.deletedForEveryone &&
    !message.decryptionError &&
    !message.id.startsWith("cmsg-");
  const canDelete = !message.id.startsWith("cmsg-");

  return (
    <div
      className={`group relative flex px-4 sm:px-10 ${
        outgoing ? "justify-end" : "justify-start"
      } ${showTail ? "mt-2" : "mt-[2px]"} ${
        highlighted ? "rc-highlight-flash rounded-lg" : ""
      }`}
    >
      {/* Quick Reply Hover Action (Left of outgoing) */}
      {outgoing && !message.deletedForEveryone && (
        <button
          type="button"
          onClick={() => onReply(message)}
          style={{ color: "var(--rc-text-muted)" }}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 self-center mr-1.5 p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
          title="Reply"
          aria-label="Reply to message"
        >
          <CornerUpLeft className="w-4 h-4" />
        </button>
      )}

      <div
        onMouseLeave={() => setMenuOpen(false)}
        style={{
          backgroundColor: outgoing
            ? "var(--rc-bubble-out)"
            : "var(--rc-bubble-in)",
          color: "var(--rc-text-primary)",
        }}
        className={`relative max-w-[85%] sm:max-w-[65%] rounded-lg px-2.5 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] ${
          showTail
            ? outgoing
              ? "rounded-tr-none"
              : "rounded-tl-none"
            : ""
        }`}
      >
        {/* Action menu chevron */}
        {canDelete && (
          <div className="absolute top-1 right-1 z-20">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              style={{
                backgroundColor: outgoing
                  ? "var(--rc-bubble-out)"
                  : "var(--rc-bubble-in)",
                color: "var(--rc-text-muted)",
              }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded-full shadow-sm transition"
              aria-label="Message actions"
            >
              <ChevronDown className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div
                style={{
                  backgroundColor: "var(--rc-surface-elevated)",
                  borderColor: "var(--rc-border)",
                }}
                className={`absolute ${
                  outgoing ? "right-0" : "left-0"
                } mt-1 w-44 rounded-xl border shadow-xl py-1 text-xs z-30`}
              >
                {!message.deletedForEveryone && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onReply(message);
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <CornerUpLeft className="w-3.5 h-3.5" /> Reply
                  </button>
                )}
                {!message.deletedForEveryone && !message.id.startsWith("cmsg-") && (
                  <button
                    type="button"
                    data-testid="star-message-btn"
                    onClick={() => {
                      setMenuOpen(false);
                      useChatStore
                        .getState()
                        .toggleStarMessage(message.chatId, message.id);
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <Star
                      className={`w-3.5 h-3.5 ${
                        message.isStarred ? "fill-amber-400 text-amber-400" : ""
                      }`}
                    />
                    {message.isStarred ? "Unstar message" : "Star message"}
                  </button>
                )}
                {!message.deletedForEveryone && !message.decryptionError && (
                  <button
                    type="button"
                    data-testid="forward-message-btn"
                    onClick={() => {
                      setMenuOpen(false);
                      useChatStore.getState().setForwardModalMessage(message);
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <CornerUpRight className="w-3.5 h-3.5" /> Forward
                  </button>
                )}
                {!message.deletedForEveryone && (
                  <button
                    type="button"
                    data-testid="message-info-btn"
                    onClick={() => {
                      setMenuOpen(false);
                      useChatStore.getState().setReadByModalMessage(message);
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <Info className="w-3.5 h-3.5" /> Message info
                  </button>
                )}
                {canEdit && onEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit(message);
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit message
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete(message.id, "me");
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete for me
                  </button>
                )}
                {outgoing && !message.deletedForEveryone && onDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete(message.id, "everyone");
                    }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
                  >
                    <Ban className="w-3.5 h-3.5" /> Delete for everyone
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Classic Messenger Bubble Tail */}
        {showTail && outgoing && (
          <svg
            viewBox="0 0 8 13"
            width="8"
            height="13"
            className="absolute -right-[7px] top-0 pointer-events-none"
            style={{ color: "var(--rc-bubble-out)" }}
          >
            <path
              fill="currentColor"
              d="M5.188 1H0v11.193l6.467-8.625C7.526 1.156 6.958 1 5.188 1z"
            />
          </svg>
        )}
        {showTail && !outgoing && (
          <svg
            viewBox="0 0 8 13"
            width="8"
            height="13"
            className="absolute -left-[7px] top-0 pointer-events-none"
            style={{ color: "var(--rc-bubble-in)" }}
          >
            <path
              fill="currentColor"
              d="M1.533 3.568L8 12.193V1H2.812C1.042 1 .474 2.156 1.533 3.568z"
            />
          </svg>
        )}

        {/* Group Sender Name */}
        {isGroupChat && !outgoing && showTail && (
          <div
            className="text-[12.5px] font-semibold leading-tight mb-0.5"
            style={{ color: message.senderColor || "#00a884" }}
          >
            {message.senderName}
          </div>
        )}

        {/* Forwarded Label */}
        {message.isForwarded && !message.deletedForEveryone && (
          <div
            style={{ color: "var(--rc-text-muted)" }}
            className="text-[11px] italic flex items-center gap-1 mb-0.5"
          >
            <CornerUpRight className="w-3 h-3 shrink-0" />
            <span>Forwarded</span>
          </div>
        )}

        {/* Status Story Reply Card */}
        {message.statusReply && !message.deletedForEveryone && (
          <div
            style={{ backgroundColor: "var(--rc-bubble-quote)" }}
            className="w-full text-left mb-1.5 rounded-md border-l-4 border-[#00a884] px-2.5 py-1.5"
          >
            <div className="text-[11px] font-semibold text-[#00a884] truncate">
              {message.statusReply.authorName} • Status (24h)
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[12px] truncate"
            >
              {message.statusReply.previewText}
            </div>
          </div>
        )}

        {/* Quoted Reply Reference */}
        {message.replyTo && !message.deletedForEveryone && (
          <button
            type="button"
            onClick={() => onJumpToMessage(message.replyTo!.messageId)}
            style={{ backgroundColor: "var(--rc-bubble-quote)" }}
            className="w-full text-left mb-1.5 rounded-md border-l-4 border-[#00a884] px-2.5 py-1.5 block hover:opacity-90 transition"
          >
            <div className="text-[12px] font-semibold text-[#00a884] truncate">
              {message.replyTo.senderName}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[12px] truncate"
            >
              {message.replyTo.previewText}
            </div>
          </button>
        )}

        {/* Deleted Message Tombstone */}
        {message.deletedForEveryone ? (
          <div
            style={{ color: "var(--rc-text-muted)" }}
            className="text-[13.5px] italic flex items-center gap-1.5 pr-12 py-0.5"
          >
            <Ban className="w-3.5 h-3.5 shrink-0" />
            <span>This message was deleted</span>
          </div>
        ) : (
          <>
            {/* Text Payload */}
            {message.type === "text" && message.text && (
              <div
                className={`text-[14.2px] leading-[19px] whitespace-pre-wrap break-words pr-12 ${
                  message.decryptionError ? "italic opacity-80" : ""
                }`}
              >
                {renderTextWithLinks(message.text)}
              </div>
            )}

            {/* Image or Video Payload */}
            {message.type === "image" && message.image && (
              <EncryptedMediaCard
                media={message.image}
                onPreview={onPreviewImage}
              />
            )}

            {/* Voice Note Payload */}
            {message.type === "voice" && message.voice && (
              <VoiceNotePlayer
                voice={message.voice}
                outgoing={outgoing}
                avatarColor={peerAvatarColor}
              />
            )}

            {/* Document / File Payload */}
            {message.type === "file" && message.file && (
              <EncryptedDocumentCard file={message.file} />
            )}

            {/* Static or Live Location Payload */}
            {message.type === "location" && message.location && (
              <LocationBubbleCard
                location={message.location}
                outgoing={outgoing}
                messageId={message.id}
                onPreviewLocation={onPreviewLocation}
                onStopLiveLocation={onStopLiveLocation}
              />
            )}
          </>
        )}

        {/* Timestamp + Edited + Receipt Footer */}
        <div
          style={{ color: "var(--rc-text-muted)" }}
          className="flex items-center justify-end gap-1 text-[11px] leading-none mt-0.5 select-none"
        >
          {message.expiresAt && !message.deletedForEveryone && (
            <span title={`Disappears ${new Date(message.expiresAt).toLocaleString()}`}>
              <Clock3 className="w-3 h-3 text-amber-400 mr-0.5" />
            </span>
          )}
          {message.isStarred && !message.deletedForEveryone && (
            <Star className="w-3 h-3 fill-amber-400 text-amber-400 mr-0.5" />
          )}
          {message.edited && !message.deletedForEveryone && (
            <span className="italic mr-0.5">edited</span>
          )}
          <span>{message.timeLabel}</span>
          {outgoing && isGroupChat && !message.id.startsWith("cmsg-") ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                useChatStore.getState().setReadByModalMessage(message);
              }}
              data-testid="group-read-by-trigger"
              title="View Read by & Delivered to list"
              className="inline-flex items-center gap-1 hover:opacity-80 transition px-1 py-0.5 -mr-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
            >
              {message.readBy && message.readBy.length > 0 && (
                <span className="text-[10px] font-medium text-[#00a884]">
                  Read by {message.readBy.length}
                </span>
              )}
              <ReceiptIcon status={message.status} />
            </button>
          ) : (
            outgoing && <ReceiptIcon status={message.status} />
          )}
        </div>
      </div>

      {/* Quick Reply Hover Action (Right of incoming) */}
      {!outgoing && !message.deletedForEveryone && (
        <button
          type="button"
          onClick={() => onReply(message)}
          style={{ color: "var(--rc-text-muted)" }}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 self-center ml-1.5 p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
          title="Reply"
          aria-label="Reply to message"
        >
          <CornerUpLeft className="w-4 h-4" />
        </button>
      )}
    </div>
  );
});
