"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  FileText,
  Headphones,
  Image as ImageIcon,
  MapPin,
  Mic,
  Pencil,
  Plus,
  SendHorizontal,
  Smile,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { MockMessage } from "@/mocks";

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
  onSendMessage: (text: string) => void;
  onSubmitEdit?: (messageId: string, newText: string) => void;
  onTypingChange?: (isTyping: boolean) => void;
  onSendVoiceNote: (durationSeconds: number) => void;
  onSelectAttachOption: (kind: AttachMenuKind) => void;
}

const QUICK_EMOJIS = [
  "😀", "😂", "🥹", "😍", "🤩", "😎", "🤝", "🙏",
  "🔥", "✨", "🎉", "🚀", "💯", "👍", "👏", "❤️",
  "🔐", "🛡️", "⚡", "🌍", "📍", "📎", "✅", "🇮🇳",
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

export function Composer({
  replyingTo,
  editingMessage = null,
  onCancelReply,
  onCancelEdit,
  onSendMessage,
  onSubmitEdit,
  onTypingChange,
  onSendVoiceNote,
  onSelectAttachOption,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const popoversRef = useRef<HTMLDivElement | null>(null);

  // Focus input when replying or editing
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

  // Close attach / emoji popups on outside click or Esc
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

  // Mock voice recording timer
  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const handleSubmitText = () => {
    if (!text.trim()) return;
    if (editingMessage && onSubmitEdit) {
      onSubmitEdit(editingMessage.id, text);
    } else {
      onSendMessage(text);
    }
    setText("");
    onTypingChange?.(false);
    setEmojiOpen(false);
    setAttachOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmitText();
    }
  };

  const hasText = text.trim().length > 0;

  return (
    <div
      ref={popoversRef}
      style={{
        backgroundColor: "var(--rc-composer-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="relative shrink-0 border-t"
    >
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
          className="absolute bottom-[68px] left-3 w-72 rounded-2xl border shadow-2xl p-3 z-30 rc-animate-pop"
        >
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1"
          >
            Quick Emojis
          </div>
          <div className="grid grid-cols-8 gap-1">
            {QUICK_EMOJIS.map((em) => (
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

      {/* Attach Menu Popup (Document, Photos & Videos, Camera, Audio, Location, Contact) */}
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
              onClick={() => {
                setAttachOpen(false);
                onSelectAttachOption(item.id);
              }}
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
        <div className="h-[62px] px-4 flex items-center justify-between gap-3 rc-animate-pop">
          <button
            type="button"
            onClick={() => {
              setIsRecording(false);
              setRecordSeconds(0);
            }}
            className="p-2 rounded-full text-red-500 hover:bg-red-500/10 transition"
            title="Discard voice message"
            aria-label="Discard voice message"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5 text-sm font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="font-mono">
              0:{recordSeconds.toString().padStart(2, "0")}
            </span>
            <span
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-xs hidden sm:inline"
            >
              Recording encrypted voice note...
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              const dur = Math.max(2, recordSeconds);
              setIsRecording(false);
              setRecordSeconds(0);
              onSendVoiceNote(dur);
            }}
            className="w-10 h-10 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white flex items-center justify-center shadow transition"
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
            style={{ color: emojiOpen ? "var(--rc-accent)" : "var(--rc-text-secondary)" }}
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
            style={{ color: attachOpen ? "var(--rc-accent)" : "var(--rc-text-secondary)" }}
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

          {/* Text Input */}
          <div
            style={{ backgroundColor: "var(--rc-input-bg)" }}
            className="flex-1 rounded-xl px-3.5 py-2 shadow-sm"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => {
                const val = e.target.value;
                setText(val);
                if (!editingMessage) {
                  onTypingChange?.(val.trim().length > 0);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder={editingMessage ? "Edit your encrypted message" : "Type a message"}
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
              title={editingMessage ? "Save edit (Enter)" : "Send message (Enter)"}
              aria-label={editingMessage ? "Save edited message" : "Send message"}
            >
              {editingMessage ? <Check className="w-5 h-5" /> : <SendHorizontal className="w-5 h-5" />}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRecordSeconds(1);
                setIsRecording(true);
              }}
              data-testid="composer-mic-button"
              style={{ color: "var(--rc-text-secondary)" }}
              className="w-10 h-10 mb-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center transition shrink-0"
              title="Record voice message"
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
