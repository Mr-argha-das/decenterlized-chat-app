"use client";

import React from "react";
import {
  ArrowLeft,
  Ban,
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
