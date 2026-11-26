"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  CheckCheck,
  Clock3,
  CornerUpLeft,
  Download,
  FileText,
  Lock,
  MapPin,
  Mic,
  MoreHorizontal,
  Navigation,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import {
  DeliveryStatus,
  ImageAttachmentMock,
  LocationAttachmentMock,
  MockMessage,
} from "@/mocks";

export interface MessageBubbleProps {
  message: MockMessage;
  isGroupChat: boolean;
  showTail: boolean;
  highlighted?: boolean;
  peerAvatarColor?: string;
  onReply: (message: MockMessage) => void;
  onEdit?: (message: MockMessage) => void;
  onDelete?: (messageId: string, scope: "me" | "everyone") => void;
  onJumpToMessage?: (messageId: string) => void;
  onPreviewImage?: (img: ImageAttachmentMock) => void;
  onPreviewLocation?: (loc: LocationAttachmentMock) => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function DeliveryTicks({ status }: { status?: DeliveryStatus }) {
  if (!status) return null;
  if (status === "pending") {
    return (
      <Clock3
        style={{ color: "var(--rc-tick-unread)" }}
        className="w-3.5 h-3.5 shrink-0"
        aria-label="Pending"
      />
    );
  }
  if (status === "sent") {
    return (
      <Check
        style={{ color: "var(--rc-tick-unread)" }}
        className="w-3.5 h-3.5 shrink-0"
        aria-label="Sent"
      />
    );
  }
  return (
    <CheckCheck
      style={{
        color: status === "read" ? "var(--rc-tick-read)" : "var(--rc-tick-unread)",
      }}
      className="w-4 h-4 shrink-0"
      aria-label={status === "read" ? "Read" : "Delivered"}
    />
  );
}

function VoiceNotePlayer({
  durationSeconds,
  waveform,
  outgoing,
  senderName,
  avatarColor,
}: {
  durationSeconds: number;
  waveform: number[];
  outgoing: boolean;
  senderName: string;
  avatarColor: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);

  useEffect(() => {
    if (!playing) return;
    const stepMs = 80;
    const increment = (stepMs / 1000 / Math.max(1, durationSeconds)) * speed;
    const id = window.setInterval(() => {
      setProgress((prev) => {
        if (prev + increment >= 1) {
          setPlaying(false);
          return 0;
        }
        return prev + increment;
      });
    }, stepMs);
    return () => window.clearInterval(id);
  }, [playing, durationSeconds, speed]);

  const cycleSpeed = () => {
    setSpeed((s) => (s === 1 ? 1.5 : s === 1.5 ? 2 : 1));
  };

  const displaySeconds = playing
    ? Math.max(0, Math.round(progress * durationSeconds))
    : durationSeconds;

  return (
    <div className="flex items-center gap-2.5 min-w-[245px] sm:min-w-[285px] py-1">
      <div className="relative shrink-0">
        <Avatar name={senderName} color={avatarColor} size="md" />
        <span
          style={{ backgroundColor: "var(--rc-bubble-in)" }}
          className="absolute -bottom-0.5 -right-0.5 p-0.5 rounded-full shadow"
        >
          <Mic className="w-3 h-3 text-[#00a884]" />
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        style={{ color: "var(--rc-text-secondary)" }}
        className="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition shrink-0"
        aria-label={playing ? "Pause voice message" : "Play voice message"}
      >
        {playing ? (
          <Pause className="w-5 h-5 fill-current" />
        ) : (
          <Play className="w-5 h-5 fill-current ml-0.5" />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="h-7 flex items-center gap-[2.5px]">
          {waveform.map((heightRatio, idx) => {
            const barProgress = idx / waveform.length;
            const active = barProgress <= progress;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => setProgress(barProgress)}
                style={{
                  height: `${Math.max(4, Math.round(heightRatio * 24))}px`,
                  backgroundColor: active
                    ? "#00a884"
                    : outgoing
                      ? "rgba(134, 150, 160, 0.55)"
                      : "rgba(134, 150, 160, 0.45)",
                }}
                className="w-[3px] rounded-full transition-colors"
                aria-label={`Seek waveform ${Math.round(barProgress * 100)}%`}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between text-[11px] mt-0.5">
          <span style={{ color: "var(--rc-text-secondary)" }}>
            {formatDuration(displaySeconds)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            className="px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-black/10 dark:bg-white/10 hover:bg-black/15"
          >
            {speed}x
          </button>
        </div>
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  isGroupChat,
  showTail,
  highlighted = false,
  peerAvatarColor = "#00a884",
  onReply,
  onEdit,
  onDelete,
  onJumpToMessage,
  onPreviewImage,
  onPreviewLocation,
}: MessageBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  if (message.type === "system") {
    return (
      <div className="flex justify-center my-2 px-4">
        <div
          style={{
            backgroundColor: "var(--rc-system-bg)",
            color: "var(--rc-system-text)",
          }}
          className="max-w-md rounded-lg px-3.5 py-1.5 text-[12px] text-center shadow-sm flex items-center justify-center gap-1.5"
        >
          <Lock className="w-3 h-3 shrink-0 opacity-80" />
          <span>{message.text}</span>
        </div>
      </div>
    );
  }

  const outgoing = message.senderId === "me";
  const bubbleBg = outgoing ? "var(--rc-bubble-out)" : "var(--rc-bubble-in)";
  const isServerPersisted = !message.id.startsWith("cmsg-");
  const canEdit =
    outgoing &&
    isServerPersisted &&
    message.type === "text" &&
    !message.deletedForEveryone &&
    !message.decryptionError &&
    Date.now() - new Date(message.timestamp).getTime() <= 15 * 60 * 1000;

  return (
    <div
      className={`group flex w-full px-4 sm:px-10 ${
        outgoing ? "justify-end" : "justify-start"
      } ${showTail ? "mt-2" : "mt-0.5"}`}
    >
      <div
        style={{
          backgroundColor: bubbleBg,
          color: "var(--rc-text-primary)",
        }}
        className={`relative max-w-[86%] sm:max-w-[68%] rounded-lg px-2.5 py-1.5 shadow-sm transition-all ${
          outgoing && showTail ? "rounded-tr-none" : ""
        } ${!outgoing && showTail ? "rounded-tl-none" : ""} ${
          highlighted ? "ring-2 ring-[#00a884] scale-[1.01]" : ""
        }`}
      >
        {/* Crisp SVG Bubble Tail */}
        {showTail && outgoing && (
          <svg
            viewBox="0 0 8 13"
            width="8"
            height="13"
            className="absolute -right-[7px] top-0 pointer-events-none"
            style={{ color: bubbleBg }}
          >
            <path
              fill="currentColor"
              d="M5.188 1H0v11.193l6.467-8.625C7.526 2.156 6.958 1 5.188 1z"
            />
          </svg>
        )}
        {showTail && !outgoing && (
          <svg
            viewBox="0 0 8 13"
            width="8"
            height="13"
            className="absolute -left-[7px] top-0 pointer-events-none"
            style={{ color: bubbleBg }}
          >
            <path
              fill="currentColor"
              d="M2.812 1H8v11.193L1.533 3.568C.474 2.156 1.042 1 2.812 1z"
            />
          </svg>
        )}

        {/* Quick Hover Actions (Reply + Edit / Delete Menu) */}
        {!message.deletedForEveryone && (
          <div
            ref={menuRef}
            className={`${
              menuOpen
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            } transition-opacity absolute top-1 ${
              outgoing ? "-left-[68px]" : "-right-[68px]"
            } flex items-center gap-1 z-20`}
          >
            <button
              type="button"
              onClick={() => onReply(message)}
              style={{
                backgroundColor: "var(--rc-surface-elevated)",
                color: "var(--rc-text-secondary)",
                borderColor: "var(--rc-border)",
              }}
              className="p-1.5 rounded-full border shadow-sm hover:text-[#00a884]"
              title="Reply"
              aria-label="Reply to message"
            >
              <CornerUpLeft className="w-3.5 h-3.5" />
            </button>

            {isServerPersisted && (onEdit || onDelete) && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  style={{
                    backgroundColor: "var(--rc-surface-elevated)",
                    color: "var(--rc-text-secondary)",
                    borderColor: "var(--rc-border)",
                  }}
                  className="p-1.5 rounded-full border shadow-sm hover:text-[#00a884]"
                  title="Message options"
                  aria-label="Message options"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>

                {menuOpen && (
                  <div
                    style={{
                      backgroundColor: "var(--rc-surface-elevated)",
                      borderColor: "var(--rc-border)",
                      color: "var(--rc-text-primary)",
                    }}
                    className={`absolute top-8 ${
                      outgoing ? "right-0" : "left-0"
                    } w-44 rounded-xl border shadow-xl py-1 text-xs z-30 rc-animate-pop`}
                  >
                    {canEdit && onEdit && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onEdit(message);
                        }}
                        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        <Pencil className="w-3.5 h-3.5 text-[#00a884]" />
                        <span>Edit message</span>
                      </button>
                    )}

                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onDelete(message.id, "me");
                        }}
                        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete for me</span>
                      </button>
                    )}

                    {outgoing && onDelete && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onDelete(message.id, "everyone");
                        }}
                        className="w-full px-3 py-2 flex items-center gap-2 text-left text-red-500 hover:bg-red-500/10"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Delete for everyone</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Group Sender Name Header */}
        {isGroupChat && !outgoing && showTail && (
          <div
            style={{ color: message.senderColor || "#00a884" }}
            className="text-xs font-semibold mb-0.5 leading-tight"
          >
            {message.senderName}
          </div>
        )}

        {/* Quoted Reply Preview */}
        {message.replyTo && (
          <button
            type="button"
            onClick={() => onJumpToMessage?.(message.replyTo!.messageId)}
            style={{ backgroundColor: "var(--rc-bubble-quote)" }}
            className="w-full text-left mb-1.5 rounded-md border-l-4 border-[#00a884] px-2.5 py-1.5 block hover:opacity-90 transition"
          >
            <div className="text-[11.5px] font-semibold text-[#00a884] truncate">
              {message.replyTo.senderName}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-xs truncate"
            >
              {message.replyTo.previewText}
            </div>
          </button>
        )}

        {/* --- VARIANT 1: IMAGE --- */}
        {message.type === "image" && message.image && (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => onPreviewImage?.(message.image!)}
              className="block rounded-md overflow-hidden w-full max-w-[330px] focus:outline-none group/img relative"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={message.image.dataUrl}
                alt={message.image.caption || "Shared image"}
                className="w-full h-auto object-cover max-h-[230px] group-hover/img:brightness-95 transition"
              />
            </button>
            {message.image.caption && (
              <p className="text-[14px] leading-snug px-0.5">{message.image.caption}</p>
            )}
          </div>
        )}

        {/* --- VARIANT 2: FILE / DOCUMENT --- */}
        {message.type === "file" && message.file && (
          <div
            style={{ backgroundColor: "var(--rc-bubble-quote)" }}
            className="rounded-lg p-2.5 flex items-center gap-3 min-w-[240px] sm:min-w-[280px]"
          >
            <div className="w-10 h-11 rounded-lg bg-[#00a884]/15 text-[#00a884] flex flex-col items-center justify-center shrink-0">
              <FileText className="w-5 h-5" />
              <span className="text-[9px] font-bold uppercase tracking-tighter">
                {message.file.extension}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{message.file.fileName}</div>
              <div
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-[11px] flex items-center gap-1.5"
              >
                {message.file.pageCount && <span>{message.file.pageCount} pages •</span>}
                <span>{message.file.fileSize}</span>
                <span>• {message.file.extension}</span>
              </div>
            </div>
            <span
              style={{ color: "var(--rc-text-secondary)" }}
              className="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition cursor-pointer"
              title="Encrypted client-side file"
            >
              <Download className="w-4 h-4" />
            </span>
          </div>
        )}

        {/* --- VARIANT 3: VOICE MESSAGE --- */}
        {message.type === "voice" && message.voice && (
          <VoiceNotePlayer
            durationSeconds={message.voice.durationSeconds}
            waveform={message.voice.waveform}
            outgoing={outgoing}
            senderName={outgoing ? "You" : message.senderName}
            avatarColor={outgoing ? "#00a884" : peerAvatarColor}
          />
        )}

        {/* --- VARIANT 4: LOCATION / LIVE LOCATION --- */}
        {message.type === "location" && message.location && (
          <button
            type="button"
            onClick={() => onPreviewLocation?.(message.location!)}
            className="block text-left w-[255px] sm:w-[295px] rounded-lg overflow-hidden border border-black/5 dark:border-white/10 hover:brightness-95 transition"
          >
            {/* Stylized Street Map Tile Preview */}
            <div className="relative h-32 w-full bg-[#e5e3df] dark:bg-[#1b2832] overflow-hidden">
              <svg
                viewBox="0 0 300 130"
                className="w-full h-full object-cover"
                aria-hidden="true"
              >
                <rect width="300" height="130" fill="currentColor" className="text-[#eae6de] dark:text-[#192630]" />
                {/* Park & water geometry */}
                <rect x="18" y="14" width="82" height="48" rx="8" className="fill-[#cdeac0] dark:fill-[#163a2c]" />
                <path
                  d="M0 98 Q95 72 185 104 T300 88 L300 130 L0 130 Z"
                  className="fill-[#aadaff] dark:fill-[#14364d]"
                />
                {/* Road network */}
                <g className="stroke-white dark:stroke-[#2b3c47]" strokeWidth="6" fill="none">
                  <path d="M0 42 L300 58" />
                  <path d="M72 0 L98 130" />
                  <path d="M205 0 L175 130" />
                  <path d="M0 85 L300 22" strokeWidth="4" />
                </g>
              </svg>

              {/* Pulsing Map Pin */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative flex items-center justify-center">
                  <span className="absolute w-9 h-9 rounded-full bg-red-500/30 animate-ping" />
                  <div className="p-1.5 rounded-full bg-red-500 text-white shadow-lg">
                    <MapPin className="w-4 h-4" />
                  </div>
                </div>
              </div>

              {message.location.isLive && (
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-[#00a884] text-white text-[10px] font-semibold inline-flex items-center gap-1 shadow">
                  <Navigation className="w-2.5 h-2.5" />
                  {message.location.liveExpiresLabel || "Live location"}
                </span>
              )}
            </div>

            <div
              style={{ backgroundColor: "var(--rc-bubble-quote)" }}
              className="px-2.5 py-2"
            >
              <div className="text-xs font-semibold truncate">{message.location.label}</div>
              <div
                style={{ color: "var(--rc-text-secondary)" }}
                className="text-[11px] truncate"
              >
                {message.location.address}
              </div>
            </div>
          </button>
        )}

        {/* --- VARIANT 5: TEXT + FOOTER TIMESTAMP / TICKS --- */}
        {message.deletedForEveryone ? (
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[13.5px] italic flex items-center gap-1.5 py-0.5"
          >
            <Ban className="w-3.5 h-3.5 shrink-0 opacity-75" />
            <span>This message was deleted</span>
            <span className="text-[11px] not-italic ml-2">{message.timeLabel}</span>
          </div>
        ) : message.type === "text" ? (
          <div className="text-[14.2px] leading-[19px] whitespace-pre-wrap break-words">
            <span>{message.text}</span>
            <span className="inline-flex items-center gap-1 float-right ml-2.5 mt-1.5 text-[11px] select-none">
              {message.edited && (
                <span style={{ color: "var(--rc-text-secondary)" }}>Edited</span>
              )}
              <span style={{ color: "var(--rc-text-secondary)" }}>
                {message.timeLabel}
              </span>
              {outgoing && <DeliveryTicks status={message.status} />}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1 mt-1 text-[11px] select-none">
            <span style={{ color: "var(--rc-text-secondary)" }}>
              {message.timeLabel}
            </span>
            {outgoing && <DeliveryTicks status={message.status} />}
          </div>
        )}
      </div>
    </div>
  );
}
