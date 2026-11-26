"use client";

import React from "react";
import {
  Archive,
  ArrowLeft,
  Ban,
  Clock3,
  Download,
  Info,
  Layers,
  MoreVertical,
  Phone,
  Pin,
  Search,
  Sparkles,
  Video,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Dropdown } from "@/components/ui/Dropdown";
import { MockChat } from "@/mocks";

export interface ChatHeaderProps {
  chat: MockChat;
  messageCount: number;
  inChatSearchOpen: boolean;
  inChatSearchQuery: string;
  onBackMobile: () => void;
  onOpenContactInfo: () => void;
  onStartVoiceCall: () => void;
  onStartVideoCall: () => void;
  onToggleSearch: () => void;
  onSearchQueryChange: (q: string) => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onToggleArchive?: () => void;
  onSetDisappearingTimer?: (seconds: number) => void;
  onExportChat?: (format: "txt" | "json") => void;
  onToggleBlock?: () => void;
  onToggleTypingDemo?: () => void;
  onInjectThousandMessages?: () => void;
  onCloseChat: () => void;
}

export function ChatHeader({
  chat,
  messageCount,
  inChatSearchOpen,
  inChatSearchQuery,
  onBackMobile,
  onOpenContactInfo,
  onStartVoiceCall,
  onStartVideoCall,
  onToggleSearch,
  onSearchQueryChange,
  onTogglePin,
  onToggleMute,
  onToggleArchive,
  onSetDisappearingTimer,
  onExportChat,
  onToggleBlock,
  onToggleTypingDemo,
  onInjectThousandMessages,
  onCloseChat,
}: ChatHeaderProps) {
  const subtitle = chat.isTyping
    ? chat.isGroup && chat.typingUser
      ? `${chat.typingUser} is typing...`
      : "typing..."
    : chat.isGroup && chat.memberNames
      ? chat.memberNames.join(", ")
      : chat.isOnline
        ? "online"
        : chat.lastSeen;

  return (
    <div className="shrink-0">
      <header
        style={{
          backgroundColor: "var(--rc-header-bg)",
          borderColor: "var(--rc-border)",
        }}
        className="h-[60px] px-3 sm:px-4 border-b flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {/* Mobile Back Button */}
          <button
            type="button"
            onClick={onBackMobile}
            data-testid="mobile-back-button"
            style={{ color: "var(--rc-text-secondary)" }}
            className="md:hidden p-2 -ml-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            aria-label="Back to chat list"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={onOpenContactInfo}
            data-testid="open-contact-info"
            className="flex items-center gap-3 min-w-0 text-left hover:opacity-90 transition"
          >
            <Avatar
              name={chat.name}
              src={chat.avatarUrl}
              color={chat.avatarColor}
              size="md"
              isGroup={chat.isGroup}
              isOnline={chat.isOnline}
              showOnlineDot
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  style={{ color: "var(--rc-text-primary)" }}
                  className="text-[15px] font-semibold truncate"
                >
                  {chat.name}
                </span>
                {!chat.isGroup && chat.globalId?.includes("@") && (
                  <span className="hidden sm:inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#00a884]/15 text-[#00a884] shrink-0">
                    @{chat.globalId.split("@")[1]}
                  </span>
                )}
                {chat.disappearingTimerSeconds ? (
                  <span
                    data-testid="disappearing-timer-badge"
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 shrink-0"
                    title="Disappearing messages active"
                  >
                    <Clock3 className="w-3 h-3" />
                    {chat.disappearingTimerSeconds >= 604800
                      ? "7d"
                      : chat.disappearingTimerSeconds >= 86400
                        ? "24h"
                        : `${Math.round(chat.disappearingTimerSeconds / 60)}m`}
                  </span>
                ) : null}
                <span
                  style={{ color: "var(--rc-text-muted)" }}
                  className="hidden lg:inline-block text-[11px] font-mono px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/5"
                >
                  {messageCount.toLocaleString()} msgs
                </span>
              </div>
              <div
                style={{
                  color: chat.isTyping
                    ? "var(--rc-accent)"
                    : "var(--rc-text-secondary)",
                }}
                className={`text-xs truncate ${chat.isTyping ? "font-medium" : ""}`}
              >
                {subtitle}
              </div>
            </div>
          </button>
        </div>

        {/* Right Header Actions: Video Call, Voice Call, Search, Menu */}
        <div
          style={{ color: "var(--rc-text-secondary)" }}
          className="flex items-center gap-0.5 sm:gap-1 shrink-0"
        >
          <button
            type="button"
            onClick={onStartVideoCall}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            title="Video call"
            aria-label="Video call"
          >
            <Video className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={onStartVoiceCall}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            title="Voice call"
            aria-label="Voice call"
          >
            <Phone className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={onToggleSearch}
            className={`p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition ${
              inChatSearchOpen ? "text-[#00a884]" : ""
            }`}
            title="Search messages"
            aria-label="Search messages"
          >
            <Search className="w-5 h-5" />
          </button>

          <Dropdown
            ariaLabel="Chat options"
            widthClass="w-64"
            trigger={<MoreVertical className="w-5 h-5" />}
            items={[
              {
                id: "info",
                label: chat.isGroup ? "Group info" : "Contact info",
                icon: <Info className="w-4 h-4 text-[#00a884]" />,
                onClick: onOpenContactInfo,
              },
              {
                id: "pin",
                label: chat.isPinned ? "Unpin chat" : "Pin chat",
                icon: <Pin className="w-4 h-4 text-[#00a884]" />,
                onClick: onTogglePin,
              },
              {
                id: "mute",
                label: chat.isMuted ? "Unmute notifications" : "Mute notifications",
                icon: chat.isMuted ? (
                  <Volume2 className="w-4 h-4 text-[#00a884]" />
                ) : (
                  <VolumeX className="w-4 h-4 text-[#00a884]" />
                ),
                onClick: onToggleMute,
              },
              ...(onToggleArchive
                ? [
                    {
                      id: "archive",
                      label: chat.isArchived ? "Unarchive chat" : "Archive chat",
                      icon: <Archive className="w-4 h-4 text-[#00a884]" />,
                      onClick: onToggleArchive,
                    },
                  ]
                : []),
              ...(onSetDisappearingTimer
                ? [
                    {
                      id: "disappear-toggle",
                      label: chat.disappearingTimerSeconds
                        ? "Disappearing messages: Turn Off"
                        : "Disappearing messages: 24 hours",
                      icon: <Clock3 className="w-4 h-4 text-amber-400" />,
                      dividerBefore: true,
                      onClick: () =>
                        onSetDisappearingTimer(
                          chat.disappearingTimerSeconds ? 0 : 86400
                        ),
                    },
                    ...(!chat.disappearingTimerSeconds
                      ? [
                          {
                            id: "disappear-7d",
                            label: "Disappearing messages: 7 days",
                            icon: <Clock3 className="w-4 h-4 text-amber-400" />,
                            onClick: () => onSetDisappearingTimer(604800),
                          },
                        ]
                      : []),
                  ]
                : []),
              ...(onExportChat
                ? [
                    {
                      id: "export-txt",
                      label: "Export chat (.txt)",
                      icon: <Download className="w-4 h-4 text-[#00a884]" />,
                      dividerBefore: true,
                      onClick: () => onExportChat("txt"),
                    },
                    {
                      id: "export-json",
                      label: "Export chat (.json)",
                      icon: <Download className="w-4 h-4 text-[#00a884]" />,
                      onClick: () => onExportChat("json"),
                    },
                  ]
                : []),
              ...(onToggleBlock && !chat.isGroup
                ? [
                    {
                      id: "block",
                      label: chat.isBlockedByMe
                        ? `Unblock ${chat.name}`
                        : `Block ${chat.name}`,
                      icon: (
                        <Ban
                          className={`w-4 h-4 ${
                            chat.isBlockedByMe ? "text-[#00a884]" : "text-red-500"
                          }`}
                        />
                      ),
                      danger: !chat.isBlockedByMe,
                      dividerBefore: true,
                      onClick: onToggleBlock,
                    },
                  ]
                : []),
              ...(onToggleTypingDemo
                ? [
                    {
                      id: "typing",
                      label: chat.isTyping
                        ? "Stop 'typing...' indicator"
                        : "Simulate 'typing...' indicator",
                      icon: <Sparkles className="w-4 h-4 text-[#00a884]" />,
                      dividerBefore: true,
                      onClick: onToggleTypingDemo,
                    },
                  ]
                : []),
              ...(onInjectThousandMessages
                ? [
                    {
                      id: "stress",
                      label: "Prepend +1,000 mock messages",
                      icon: <Layers className="w-4 h-4 text-[#00a884]" />,
                      onClick: onInjectThousandMessages,
                    },
                  ]
                : []),
              {
                id: "close",
                label: "Close chat (Esc)",
                icon: <X className="w-4 h-4" />,
                dividerBefore: true,
                onClick: onCloseChat,
              },
            ]}
          />
        </div>
      </header>

      {/* Collapsible In-Chat Search Bar */}
      {inChatSearchOpen && (
        <div
          style={{
            backgroundColor: "var(--rc-sidebar-bg)",
            borderColor: "var(--rc-border)",
          }}
          className="px-4 py-2 border-b flex items-center gap-2 rc-animate-pop"
        >
          <Search
            style={{ color: "var(--rc-text-secondary)" }}
            className="w-4 h-4 shrink-0"
          />
          <input
            type="text"
            autoFocus
            value={inChatSearchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder={`Search within ${chat.name}...`}
            style={{ color: "var(--rc-text-primary)" }}
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--rc-text-secondary)]"
          />
          <button
            type="button"
            onClick={onToggleSearch}
            style={{ color: "var(--rc-text-secondary)" }}
            className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close message search"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
