"use client";

import React, { useMemo } from "react";
import {
  Keyboard,
  LogOut,
  MessageSquarePlus,
  Moon,
  MoreVertical,
  RefreshCw,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { ChatListItem } from "@/components/chat/ChatListItem";
import { Avatar } from "@/components/ui/Avatar";
import { Dropdown } from "@/components/ui/Dropdown";
import { RealtimeConnectionState } from "@/lib/ws/realtimeClient";
import { MockChat } from "@/mocks";
import { SidebarFilter } from "@/store/useChatStore";

export interface ChatListProps {
  currentUserName: string;
  currentUserId: string;
  currentUserAvatarUrl?: string | null;
  currentUserAvatarColor?: string;
  wsState?: RealtimeConnectionState;
  chats: MockChat[];
  activeChatId: string | null;
  filter: SidebarFilter;
  searchQuery: string;
  isSkeletonLoading: boolean;
  theme: "light" | "dark";
  searchInputRef?: React.RefObject<HTMLInputElement>;
  onSelectChat: (chatId: string) => void;
  onFilterChange: (filter: SidebarFilter) => void;
  onSearchChange: (q: string) => void;
  onOpenNewChat: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onOpenShortcuts: () => void;
  onToggleTheme: () => void;
  onReplaySkeleton: () => void;
  onLogout?: () => void;
}

export function ChatList({
  currentUserName,
  currentUserId,
  currentUserAvatarUrl,
  currentUserAvatarColor = "#00a884",
  wsState = "connected",
  chats,
  activeChatId,
  filter,
  searchQuery,
  isSkeletonLoading,
  theme,
  searchInputRef,
  onSelectChat,
  onFilterChange,
  onSearchChange,
  onOpenNewChat,
  onOpenSettings,
  onOpenProfile,
  onOpenShortcuts,
  onToggleTheme,
  onReplaySkeleton,
  onLogout,
}: ChatListProps) {
  const unreadChatCount = useMemo(
    () => chats.filter((c) => c.unreadCount > 0).length,
    [chats]
  );

  const visibleChats = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...chats]
      .filter((c) => {
        if (filter === "unread" && c.unreadCount === 0) return false;
        if (filter === "groups" && !c.isGroup) return false;
        if (!q) return true;
        return (
          c.name.toLowerCase().includes(q) ||
          c.globalId.toLowerCase().includes(q) ||
          c.lastMessagePreview.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned));
  }, [chats, filter, searchQuery]);

  return (
    <aside
      style={{
        backgroundColor: "var(--rc-sidebar-bg)",
        borderColor: "var(--rc-border)",
      }}
      className="w-full h-full flex flex-col border-r select-none"
    >
      {/* Top Sidebar Header */}
      <header
        style={{ backgroundColor: "var(--rc-header-bg)" }}
        className="h-[60px] px-4 flex items-center justify-between shrink-0"
      >
        <button
          type="button"
          onClick={onOpenProfile}
          data-testid="open-my-profile-button"
          className="flex items-center gap-2.5 min-w-0 text-left hover:opacity-90 transition"
          title="My Profile"
        >
          <Avatar
            name={currentUserName}
            src={currentUserAvatarUrl || undefined}
            color={currentUserAvatarColor}
            size="md"
            isOnline={wsState === "connected"}
            showOnlineDot
          />
          <div className="min-w-0 hidden sm:block">
            <div
              style={{ color: "var(--rc-text-primary)" }}
              className="text-sm font-semibold truncate leading-tight"
            >
              {currentUserName}
            </div>
            <div
              style={{ color: "var(--rc-text-secondary)" }}
              className="text-[11px] font-mono truncate flex items-center gap-1.5"
            >
              <span>{currentUserId}</span>
              {wsState !== "connected" && (
                <span className="text-amber-500 font-sans text-[10px]">
                  • {wsState}...
                </span>
              )}
            </div>
          </div>
        </button>

        <div
          style={{ color: "var(--rc-text-secondary)" }}
          className="flex items-center gap-1"
        >
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            title={theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          <button
            type="button"
            onClick={onOpenNewChat}
            data-testid="open-new-chat-button"
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            title="New chat & contacts"
            aria-label="New chat"
          >
            <MessageSquarePlus className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            data-testid="open-settings-button"
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>

          <Dropdown
            ariaLabel="Main menu"
            trigger={<MoreVertical className="w-5 h-5" />}
            items={[
              {
                id: "new-chat",
                label: "New chat / group",
                icon: <MessageSquarePlus className="w-4 h-4 text-[#00a884]" />,
                onClick: onOpenNewChat,
              },
              {
                id: "settings",
                label: "Settings & Theme",
                icon: <Settings className="w-4 h-4 text-[#00a884]" />,
                onClick: onOpenSettings,
              },
              {
                id: "shortcuts",
                label: "Keyboard shortcuts",
                icon: <Keyboard className="w-4 h-4 text-[#00a884]" />,
                onClick: onOpenShortcuts,
              },
              {
                id: "skeleton",
                label: "Refresh conversations",
                icon: <RefreshCw className="w-4 h-4 text-[#00a884]" />,
                dividerBefore: true,
                onClick: onReplaySkeleton,
              },
              ...(onLogout
                ? [
                    {
                      id: "logout",
                      label: "Log out",
                      icon: <LogOut className="w-4 h-4 text-red-500" />,
                      dividerBefore: true,
                      danger: true,
                      onClick: onLogout,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>

      {/* Search Bar & Filter Chips */}
      <div
        style={{ borderColor: "var(--rc-border)" }}
        className="px-3 pt-2.5 pb-2 border-b space-y-2.5 shrink-0"
      >
        <div
          style={{ backgroundColor: "var(--rc-header-bg)" }}
          className="relative flex items-center rounded-lg"
        >
          <Search
            style={{ color: "var(--rc-text-secondary)" }}
            className="w-4 h-4 absolute left-3.5 pointer-events-none"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search or start new chat"
            data-testid="sidebar-search-input"
            style={{ color: "var(--rc-text-primary)" }}
            className="w-full bg-transparent pl-10 pr-8 py-1.5 text-sm placeholder:text-[var(--rc-text-secondary)] focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              style={{ color: "var(--rc-text-secondary)" }}
              className="absolute right-2.5 p-0.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter Chips: All / Unread / Groups */}
        <div className="flex items-center gap-2">
          {(
            [
              { key: "all", label: "All" },
              {
                key: "unread",
                label: unreadChatCount > 0 ? `Unread (${unreadChatCount})` : "Unread",
              },
              { key: "groups", label: "Groups" },
            ] as { key: SidebarFilter; label: string }[]
          ).map((chip) => {
            const active = filter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => onFilterChange(chip.key)}
                data-testid={`filter-chip-${chip.key}`}
                style={{
                  backgroundColor: active
                    ? "var(--rc-accent-soft)"
                    : "var(--rc-header-bg)",
                  color: active
                    ? "var(--rc-accent-strong)"
                    : "var(--rc-text-secondary)",
                }}
                className="px-3 py-1 rounded-full text-xs font-medium transition hover:opacity-90"
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable Chat List / Skeleton Loader */}
      <div className="flex-1 overflow-y-auto rc-scrollbar">
        {isSkeletonLoading ? (
          <div className="divide-y divide-[var(--rc-border)]" data-testid="chat-list-skeleton">
            {Array.from({ length: 9 }).map((_, idx) => (
              <div key={idx} className="px-3.5 py-3 flex items-center gap-3 animate-pulse">
                <div className="w-12 h-12 rounded-full bg-slate-200 dark:bg-slate-700/70 shrink-0" />
                <div className="flex-1 space-y-2.5">
                  <div className="flex justify-between gap-4">
                    <div className="h-3.5 w-32 rounded bg-slate-200 dark:bg-slate-700/70" />
                    <div className="h-3 w-10 rounded bg-slate-200 dark:bg-slate-700/70" />
                  </div>
                  <div className="h-3 w-48 rounded bg-slate-200 dark:bg-slate-700/50" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleChats.length === 0 ? (
          <div
            style={{ color: "var(--rc-text-secondary)" }}
            className="py-14 px-6 text-center text-sm space-y-3"
          >
            <p>
              {chats.length === 0
                ? "No conversations yet on this account."
                : "No chats match your current filter."}
            </p>
            <button
              type="button"
              onClick={onOpenNewChat}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white text-xs font-semibold shadow-sm transition"
            >
              <MessageSquarePlus className="w-4 h-4" />
              Start a New E2EE Chat
            </button>
          </div>
        ) : (
          visibleChats.map((chat) => (
            <ChatListItem
              key={chat.id}
              chat={chat}
              isActive={chat.id === activeChatId}
              onSelect={onSelectChat}
            />
          ))
        )}
      </div>
    </aside>
  );
}
