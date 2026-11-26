"use client";

import React from "react";
import {
  Camera,
  Check,
  CheckCheck,
  Clock3,
  FileText,
  MapPin,
  Mic,
  Pin,
  VolumeX,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { DeliveryStatus, MockChat, MockMessageType } from "@/mocks";

export interface ChatListItemProps {
  chat: MockChat;
  isActive: boolean;
  onSelect: (chatId: string) => void;
}

function renderStatusTicks(status?: DeliveryStatus) {
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
        className="w-4 h-4 shrink-0"
      />
    );
  }
  return (
    <CheckCheck
      style={{
        color: status === "read" ? "var(--rc-tick-read)" : "var(--rc-tick-unread)",
      }}
      className="w-4 h-4 shrink-0"
    />
  );
}

function renderTypeMiniIcon(type: MockMessageType) {
  const cls = "w-3.5 h-3.5 shrink-0 opacity-75";
  if (type === "image") return <Camera className={cls} />;
  if (type === "file") return <FileText className={cls} />;
  if (type === "voice") return <Mic className={cls} />;
  if (type === "location") return <MapPin className={cls} />;
  return null;
}

export function ChatListItem({ chat, isActive, onSelect }: ChatListItemProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(chat.id)}
      data-testid={`chat-list-item-${chat.id}`}
      style={{
        backgroundColor: isActive ? "var(--rc-active-bg)" : undefined,
      }}
      className={`w-full px-3.5 py-3 flex items-center gap-3 text-left transition-colors ${
        isActive ? "" : "hover:bg-[var(--rc-hover-bg)]"
      }`}
    >
      <Avatar
        name={chat.name}
        src={chat.avatarUrl}
        color={chat.avatarColor}
        size="lg"
        isGroup={chat.isGroup}
        isOnline={chat.isOnline}
        showOnlineDot
      />

      <div
        style={{ borderColor: "var(--rc-border)" }}
        className="flex-1 min-w-0 pb-2.5 -mb-2.5 border-b"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            style={{ color: "var(--rc-text-primary)" }}
            className="text-[15px] font-medium truncate"
          >
            {chat.name}
          </span>
          <span
            style={{
              color:
                chat.unreadCount > 0
                  ? "var(--rc-accent)"
                  : "var(--rc-text-secondary)",
            }}
            className={`text-xs shrink-0 ${
              chat.unreadCount > 0 ? "font-semibold" : ""
            }`}
          >
            {chat.lastMessageTime}
          </span>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-1 text-[13px]">
            {chat.isTyping ? (
              <span
                style={{ color: "var(--rc-accent)" }}
                className="font-medium truncate"
              >
                {chat.isGroup && chat.typingUser
                  ? `${chat.typingUser} is typing...`
                  : "typing..."}
              </span>
            ) : (
              <>
                {chat.lastMessageOutgoing && renderStatusTicks(chat.lastMessageStatus)}
                <span
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="inline-flex items-center gap-1 min-w-0"
                >
                  {renderTypeMiniIcon(chat.lastMessageType)}
                  <span className="truncate">{chat.lastMessagePreview}</span>
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {chat.isMuted && (
              <VolumeX
                style={{ color: "var(--rc-text-muted)" }}
                className="w-4 h-4"
                aria-label="Muted"
              />
            )}
            {chat.isPinned && (
              <Pin
                style={{ color: "var(--rc-text-muted)" }}
                className="w-3.5 h-3.5 rotate-45"
                aria-label="Pinned"
              />
            )}
            {chat.unreadCount > 0 && (
              <span
                style={{ backgroundColor: "var(--rc-accent)" }}
                className="min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold text-white inline-flex items-center justify-center"
              >
                {chat.unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
