"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  FileText,
  Headphones,
  Image as ImageIcon,
  Lock,
  MapPin,
  Mic,
  Pencil,
  Plus,
  SendHorizontal,
  Smile,
  Trash2,
  Unlock,
  UserRound,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { GroupMemberInfo, MockMessage } from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

export type AttachMenuKind =
  | "document"
  | "photos"
  | "camera"
  | "audio"
  | "location"
  | "contact";

export interface ComposerProps {
  replyingTo: MockMessage | null;
  editingMessage?: MockMessage | null;
  onCancelReply: () => void;
  onCancelEdit?: () => void;
  onSendMessage: (text: string, explicitMentionIds?: string[]) => void;
  onSubmitEdit?: (messageId: string, newText: string) => void;
  onTypingChange?: (isTyping: boolean) => void;
  onSendVoiceNote: (durationSeconds: number) => void;
  onSendRecordedVoice?: (
    audioBlob: Blob,
    durationSeconds: number,
    waveform: number[]
  ) => void;
  onStageFile?: (file: File) => void;
  onSelectAttachOption: (kind: AttachMenuKind) => void;
}

const EMOJI_CATEGORIES: { id: string; label: string; emojis: string[] }[] = [
  {
    id: "smileys",
    label: "😀",
    emojis: [
      "😀", "😂", "🥹", "😍", "🤩", "😎", "🥳", "🤔",
      "😇", "🙌", "🤝", "🙏", "👍", "👎", "👏", "🫶",
    ],
  },
  {
    id: "symbols",
    label: "🔥",
    emojis: [
      "🔥", "✨", "🎉", "🚀", "💯", "❤️", "💚", "⚡",
      "🌟", "🎯", "🏆", "✅", "❌", "⚠️", "💬", "🇮🇳",
    ],
  },
  {
    id: "security",
    label: "🔐",
    emojis: [
      "🔐", "🛡️", "🔑", "🔒", "📡", "🌍", "📍", "📎",
      "📷", "🎙️", "📄", "🕒", "⭐", "📦", "🔔", "💻",
    ],
  },
];

const ATTACH_MENU_ITEMS: {
  id: AttachMenuKind;
  label: string;
  color: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "document",
    label: "Document",
    color: "#7f66ff",
    icon: <FileText className="w-5 h-5 text-white" />,
  },
  {
    id: "photos",
    label: "Photos & Videos",
    color: "#007bfc",
    icon: <ImageIcon className="w-5 h-5 text-white" />,
  },
  {
    id: "camera",
    label: "Camera",
    color: "#ff2e74",
    icon: <Camera className="w-5 h-5 text-white" />,
  },
  {
    id: "audio",
    label: "Audio",
    color: "#f97316",
    icon: <Headphones className="w-5 h-5 text-white" />,
  },
  {
    id: "location",
    label: "Location",
    color: "#00a884",
    icon: <MapPin className="w-5 h-5 text-white" />,
  },
  {
    id: "contact",
    label: "Contact",
    color: "#029be5",
    icon: <UserRound className="w-5 h-5 text-white" />,
  },
];

const WAVEFORM_BARS = 32;

function pickSupportedRecorderMime(): string {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return "";
}

export function Composer({
  replyingTo,
  editingMessage = null,
  onCancelReply,
  onCancelEdit,
  onSendMessage,
  onSubmitEdit,
  onTypingChange,
  onSendVoiceNote,
  onSendRecordedVoice,
  onStageFile,
  onSelectAttachOption,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState("smileys");
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const activeChat = useChatStore((s) =>
    s.chats.find((c) => c.id === s.activeChatId) || null
  );
  const myUserId = useAuthStore((s) => s.user?.id || "");
  const isAdminOnlyLocked = Boolean(
    activeChat?.isGroup &&
      activeChat.onlyAdminsCanSend &&
      activeChat.myRole !== "admin"
  );

  // Detect active @mention query right before end of text
  const mentionMatch =
    activeChat?.isGroup && activeChat.groupMembers
      ? text.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/)
      : null;
  const mentionQuery = mentionMatch ? mentionMatch[1].toLowerCase() : null;
  const mentionCandidates: GroupMemberInfo[] =
    mentionQuery !== null && activeChat?.groupMembers
      ? activeChat.groupMembers
          .filter(
            (m) =>
              m.user_id !== myUserId &&
              (m.username.toLowerCase().includes(mentionQuery) ||
                m.display_name.toLowerCase().includes(mentionQuery))
          )
          .slice(0, 6)
      : [];

  // Voice recording state (supports hold-to-record + click-to-record + lock)
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingLocked, setIsRecordingLocked] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState<number[]>(
    () => Array.from({ length: WAVEFORM_BARS }, () => 0.25)
  );

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const popoversRef = useRef<HTMLDivElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recordStartMsRef = useRef<number>(0);
  const pressDownMsRef = useRef<number>(0);
  const waveformHistoryRef = useRef<number[]>([]);

  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.text || "");
      textareaRef.current?.focus();
    }
  }, [editingMessage]);

  useEffect(() => {
    if (!attachOpen && !emojiOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (popoversRef.current && !popoversRef.current.contains(e.target as Node)) {
        setAttachOpen(false);
        setEmojiOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setAttachOpen(false);
        setEmojiOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [attachOpen, emojiOpen]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const cleanupRecordingResources = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => {
    return () => cleanupRecordingResources();
  }, [cleanupRecordingResources]);

  const startVoiceRecording = async (lockImmediately = false) => {
    if (isRecording) return;
    setAttachOpen(false);
    setEmojiOpen(false);
    setRecordSeconds(0);
    setIsRecordingLocked(lockImmediately);
    setIsRecording(true);
    recordStartMsRef.current = Date.now();
    audioChunksRef.current = [];
    waveformHistoryRef.current = [];

    if (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined"
    ) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const mimeType = pickSupportedRecorderMime();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            audioChunksRef.current.push(ev.data);
          }
        };
        recorder.start(150);
        mediaRecorderRef.current = recorder;

        // Live Web Audio AnalyserNode for real-time waveform bars
        const AudioContextCtor =
          window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioContextCtor) {
          const ctx = new AudioContextCtor();
          audioCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          src.connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);

          const sampleLoop = () => {
            analyser.getByteFrequencyData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i];
            const avg = Math.min(1, Math.max(0.18, sum / (buf.length * 185)));
            waveformHistoryRef.current.push(Number(avg.toFixed(2)));
            setLiveWaveform((prev) => [...prev.slice(1), Number(avg.toFixed(2))]);
            rafRef.current = requestAnimationFrame(sampleLoop);
          };
          rafRef.current = requestAnimationFrame(sampleLoop);
        }
        return;
      } catch {
        // Microphone unavailable (e.g. headless browser) -> animate synthetic live waveform
      }
    }

    // Fallback animated waveform when mic isn't granted
    const tick = () => {
      const amp = Number((0.22 + Math.abs(Math.sin(Date.now() / 160)) * 0.68).toFixed(2));
      waveformHistoryRef.current.push(amp);
      setLiveWaveform((prev) => [...prev.slice(1), amp]);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const finishAndSendRecording = useCallback(() => {
    const elapsedSec = Math.max(
      1,
      Math.round((Date.now() - recordStartMsRef.current) / 1000) || recordSeconds || 1
    );
    const sampled =
      waveformHistoryRef.current.length >= 8
        ? Array.from({ length: 34 }, (_, idx) => {
            const pos = Math.floor(
              (idx / 34) * waveformHistoryRef.current.length
            );
            return waveformHistoryRef.current[pos] ?? 0.35;
          })
        : liveWaveform;

    const recorder = mediaRecorderRef.current;
    setIsRecording(false);
    setIsRecordingLocked(false);
    setRecordSeconds(0);

    if (recorder && recorder.state !== "inactive") {
      const recMime = (recorder.mimeType || "audio/webm").split(";")[0];
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recMime });
        cleanupRecordingResources();
        if (blob.size > 0 && onSendRecordedVoice) {
          onSendRecordedVoice(blob, elapsedSec, sampled);
        } else {
          onSendVoiceNote(elapsedSec);
        }
      };
      recorder.stop();
      return;
    }

    cleanupRecordingResources();
    onSendVoiceNote(elapsedSec);
  }, [
    cleanupRecordingResources,
    liveWaveform,
    onSendRecordedVoice,
    onSendVoiceNote,
    recordSeconds,
  ]);

  const discardRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    cleanupRecordingResources();
    setIsRecording(false);
    setIsRecordingLocked(false);
    setRecordSeconds(0);
  }, [cleanupRecordingResources]);

  const applyMentionCandidate = (member: GroupMemberInfo) => {
    setText((prev) =>
      prev.replace(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/, (full) => {
        const leadingSpace = full.startsWith(" ") ? " " : "";
        return `${leadingSpace}@${member.username} `;
      })
    );
    setSelectedMentionIds((prev) =>
      prev.includes(member.user_id) ? prev : [...prev, member.user_id]
    );
    setMentionIndex(0);
    textareaRef.current?.focus();
  };

  const handleSubmitText = () => {
    if (!text.trim()) return;
    if (editingMessage && onSubmitEdit) {
      onSubmitEdit(editingMessage.id, text);
    } else {
      onSendMessage(text, selectedMentionIds);
    }
    setText("");
    setSelectedMentionIds([]);
    onTypingChange?.(false);
    setEmojiOpen(false);
    setAttachOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyMentionCandidate(
          mentionCandidates[mentionIndex] || mentionCandidates[0]
        );
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmitText();
    }
  };

  const handleClipboardPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !onStageFile) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const namedFile =
            file.name && file.name !== "image.png"
              ? file
              : new File(
                  [file],
                  `pasted-${Date.now()}.${
                    (file.type.split("/")[1] || "png").split(";")[0]
                  }`,
                  { type: file.type || "image/png" }
                );
          onStageFile(namedFile);
          return;
        }
      }
    }
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    onStageFile?.(picked);
  };

  const handleAttachChoice = (kind: AttachMenuKind) => {
    setAttachOpen(false);
    if (kind === "document") {
      docInputRef.current?.click();
      return;
    }
    if (kind === "photos") {
      mediaInputRef.current?.click();
      return;
    }
    if (kind === "audio") {
      audioInputRef.current?.click();
      return;
    }
    onSelectAttachOption(kind);
  };

  const hasText = text.trim().length > 0;

  if (isAdminOnlyLocked) {
    return (
      <div
        data-testid="admin-only-send-banner"
        style={{
          backgroundColor: "var(--rc-composer-bg)",
          borderColor: "var(--rc-border)",
          color: "var(--rc-text-secondary)",
        }}
        className="shrink-0 border-t px-4 py-3.5 text-center text-xs font-medium flex items-center justify-center gap-2 select-none"
      >
        <Lock className="w-3.5 h-3.5 text-[#00a884]" />
        <span>Only <strong className="font-semibold">admins</strong> can send messages in this group</span>
      </div>
    );
  }

  return (
    <div
      ref={popoversRef}
      style={{
        backgroundColor: "var(--rc-composer-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="relative shrink-0 border-t"
    >
      {/* @Mention Member Autocomplete Popover */}
      {mentionCandidates.length > 0 && (
        <div
          data-testid="mention-autocomplete-popover"
          style={{
            backgroundColor: "var(--rc-surface-elevated)",
            borderColor: "var(--rc-border)",
          }}
          className="absolute bottom-full left-14 right-14 mb-2 max-w-md rounded-2xl border shadow-2xl py-1.5 z-40 rc-animate-pop overflow-hidden"
        >
          <div
            style={{ color: "var(--rc-text-muted)" }}
            className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider"
          >
            Mention Group Member
          </div>
          {mentionCandidates.map((m, idx) => (
            <button
              key={m.user_id}
              type="button"
              onClick={() => applyMentionCandidate(m)}
              className={`w-full px-3 py-2 flex items-center gap-2.5 text-left transition ${
                idx === mentionIndex
                  ? "bg-[#00a884]/15"
                  : "hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              <Avatar
                name={m.display_name}
                color={m.sender_color}
                src={m.avatar_url}
                size="sm"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold truncate">{m.display_name}</div>
                <div
                  style={{ color: "var(--rc-text-muted)" }}
                  className="text-[11px] font-mono truncate"
                >
                  @{m.username}
                </div>
              </div>
              {m.role === "admin" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00a884]/15 text-[#00a884] font-semibold">
                  Admin
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {/* Hidden Native File Inputs */}
      <input
        ref={docInputRef}
        type="file"
        data-testid="file-input-document"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json,.md,.zip,application/pdf"
        onChange={handleFilePicked}
        className="hidden"
      />
      <input
        ref={mediaInputRef}
        type="file"
        data-testid="file-input-media"
        accept="image/*,video/*"
        onChange={handleFilePicked}
        className="hidden"
      />
      <input
        ref={audioInputRef}
        type="file"
        data-testid="file-input-audio"
        accept="audio/*"
        onChange={handleFilePicked}
        className="hidden"
      />

      {/* Editing Message Banner */}
      {editingMessage && (
        <div
          style={{
            backgroundColor: "var(--rc-header-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="px-4 py-2 border-b flex items-center gap-3 rc-animate-pop"
        >
          <div
            style={{ backgroundColor: "var(--rc-input-bg)" }}
            className="flex-1 min-w-0 rounded-lg border-l-4 border-[#00a884] px-3 py-1.5"
          >
            <div className="text-xs font-semibold text-[#00a884] flex items-center gap-1.5">
              <Pencil className="w-3 h-3" /> Editing message (within 15m window)
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-xs truncate"
            >
              {editingMessage.text}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setText("");
              onCancelEdit?.();
            }}
            style={{ color: "var(--rc-text-secondary)" }}
            className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Cancel edit"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Reply-To Banner */}
      {replyingTo && (
        <div
          style={{
            backgroundColor: "var(--rc-header-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="px-4 py-2 border-b flex items-center gap-3 rc-animate-pop"
        >
          <div
            style={{ backgroundColor: "var(--rc-input-bg)" }}
            className="flex-1 min-w-0 rounded-lg border-l-4 border-[#00a884] px-3 py-1.5"
          >
            <div className="text-xs font-semibold text-[#00a884]">
              {replyingTo.senderId === "me" ? "You" : replyingTo.senderName}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-xs truncate"
            >
              {replyingTo.text ||
                replyingTo.image?.caption ||
                replyingTo.file?.fileName ||
                replyingTo.location?.label ||
                "Voice message"}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            style={{ color: "var(--rc-text-secondary)" }}
            className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Cancel reply"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Emoji Popover */}
      {emojiOpen && (
        <div
          style={{
            backgroundColor: "var(--rc-surface-elevated)",
            borderColor: "var(--rc-border)",
          }}
          data-testid="emoji-picker-popover"
          className="absolute bottom-[68px] left-3 w-76 rounded-2xl border shadow-2xl p-3 z-30 rc-animate-pop"
        >
          <div className="flex items-center justify-between mb-2 px-1">
            <span
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[11px] font-semibold uppercase tracking-wider"
            >
              Emoji Picker
            </span>
            <div className="flex gap-1">
              {EMOJI_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setEmojiCategory(cat.id)}
                  className={`px-2 py-0.5 rounded-md text-xs transition ${
                    emojiCategory === cat.id
                      ? "bg-[#00a884]/20 ring-1 ring-[#00a884]"
                      : "opacity-60 hover:opacity-100"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-8 gap-1">
            {(
              EMOJI_CATEGORIES.find((c) => c.id === emojiCategory)?.emojis ||
              EMOJI_CATEGORIES[0].emojis
            ).map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => {
                  setText((prev) => prev + em);
                  textareaRef.current?.focus();
                }}
                className="h-8 w-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-lg flex items-center justify-center transition"
              >
                {em}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Attach Menu Popup */}
      {attachOpen && (
        <div
          data-testid="attach-menu-popup"
          style={{
            backgroundColor: "var(--rc-surface-elevated)",
            borderColor: "var(--rc-border)",
            color: "var(--rc-text-primary)",
          }}
          className="absolute bottom-[68px] left-12 w-56 rounded-2xl border shadow-2xl py-2 px-1.5 z-30 rc-animate-pop"
        >
          {ATTACH_MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`attach-option-${item.id}`}
              onClick={() => handleAttachChoice(item.id)}
              className="w-full px-3 py-2 rounded-xl flex items-center gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition text-sm font-medium"
            >
              <span
                style={{ backgroundColor: item.color }}
                className="w-9 h-9 rounded-full flex items-center justify-center shadow-sm shrink-0"
              >
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Main Composer Row */}
      {isRecording ? (
        <div
          data-testid="voice-recording-bar"
          onPointerUp={() => {
            // If user held down > 400ms and didn't lock, release sends voice note!
            if (!isRecordingLocked && Date.now() - pressDownMsRef.current > 400) {
              finishAndSendRecording();
            }
          }}
          className="h-[62px] px-3 sm:px-4 flex items-center justify-between gap-2.5 rc-animate-pop"
        >
          <button
            type="button"
            onClick={discardRecording}
            data-testid="voice-discard-button"
            className="p-2 rounded-full text-red-500 hover:bg-red-500/10 transition shrink-0"
            title="Discard voice message"
            aria-label="Discard voice message"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 shrink-0 text-sm font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono text-xs sm:text-sm">
              {Math.floor(recordSeconds / 60)}:
              {(recordSeconds % 60).toString().padStart(2, "0")}
            </span>
          </div>

          {/* Live Waveform Preview */}
          <div
            data-testid="voice-live-waveform"
            className="flex-1 flex items-center justify-center gap-[2px] h-7 overflow-hidden px-2"
          >
            {liveWaveform.map((amp, idx) => (
              <span
                key={idx}
                style={{ height: `${Math.max(18, Math.round(amp * 100))}%` }}
                className="w-[3px] rounded-full bg-[#00a884] transition-all duration-75"
              />
            ))}
          </div>

          {/* Lock Hands-Free Recording Toggle */}
          <button
            type="button"
            onClick={() => setIsRecordingLocked((v) => !v)}
            data-testid="voice-lock-button"
            style={{
              backgroundColor: isRecordingLocked
                ? "var(--rc-accent-soft)"
                : "var(--rc-input-bg)",
              color: isRecordingLocked
                ? "var(--rc-accent-strong)"
                : "var(--rc-text-secondary)",
            }}
            className="px-2.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1 transition shrink-0 border border-[var(--rc-border)]"
            title={isRecordingLocked ? "Recording locked" : "Lock recording"}
          >
            {isRecordingLocked ? (
              <>
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Locked</span>
              </>
            ) : (
              <>
                <Unlock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={finishAndSendRecording}
            data-testid="voice-send-button"
            className="w-10 h-10 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white flex items-center justify-center shadow transition shrink-0"
            aria-label="Send voice note"
          >
            <SendHorizontal className="w-5 h-5" />
          </button>
        </div>
      ) : (
        <div className="min-h-[62px] px-3 sm:px-4 py-2 flex items-end gap-2">
          {/* Emoji Button */}
          <button
            type="button"
            onClick={() => {
              setEmojiOpen((v) => !v);
              setAttachOpen(false);
            }}
            style={{
              color: emojiOpen ? "var(--rc-accent)" : "var(--rc-text-secondary)",
            }}
            className="p-2 mb-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition shrink-0"
            title="Emoji"
            aria-label="Emoji picker"
          >
            <Smile className="w-6 h-6" />
          </button>

          {/* Attach Menu Trigger */}
          <button
            type="button"
            onClick={() => {
              setAttachOpen((v) => !v);
              setEmojiOpen(false);
            }}
            data-testid="attach-menu-trigger"
            style={{
              color: attachOpen ? "var(--rc-accent)" : "var(--rc-text-secondary)",
            }}
            className="p-2 mb-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition shrink-0"
            title="Attach"
            aria-label="Attach menu"
          >
            <Plus
              className={`w-6 h-6 transition-transform duration-200 ${
                attachOpen ? "rotate-45" : ""
              }`}
            />
          </button>

          {/* Text Input (with Clipboard Paste File Support) */}
          <div
            style={{ backgroundColor: "var(--rc-input-bg)" }}
            className="flex-1 rounded-xl px-3.5 py-2 shadow-sm"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onPaste={handleClipboardPaste}
              onChange={(e) => {
                const val = e.target.value;
                setText(val);
                if (!editingMessage) {
                  onTypingChange?.(val.trim().length > 0);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                editingMessage
                  ? "Edit your encrypted message"
                  : "Type a message (or paste/drop media)"
              }
              data-testid="composer-input"
              style={{ color: "var(--rc-text-primary)" }}
              className="w-full max-h-28 bg-transparent resize-none text-[14.5px] leading-5 placeholder:text-[var(--rc-text-secondary)] focus:outline-none rc-scrollbar"
            />
          </div>

          {/* Dynamic Mic / Send / Save Edit Toggle */}
          {hasText ? (
            <button
              type="button"
              onClick={handleSubmitText}
              data-testid="composer-send-button"
              className="w-10 h-10 mb-0.5 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white flex items-center justify-center shadow-sm transition shrink-0"
              title={
                editingMessage ? "Save edit (Enter)" : "Send message (Enter)"
              }
              aria-label={
                editingMessage ? "Save edited message" : "Send message"
              }
            >
              {editingMessage ? (
                <Check className="w-5 h-5" />
              ) : (
                <SendHorizontal className="w-5 h-5" />
              )}
            </button>
          ) : (
            <button
              type="button"
              onPointerDown={() => {
                pressDownMsRef.current = Date.now();
                startVoiceRecording(false);
              }}
              data-testid="composer-mic-button"
              style={{ color: "var(--rc-text-secondary)" }}
              className="w-10 h-10 mb-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition shrink-0 select-none"
              title="Click or hold to record voice message"
              aria-label="Record voice message"
            >
              <Mic className="w-6 h-6" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
