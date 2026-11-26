"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Ban,
  Loader2,
  MapPin,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { KeyRestoreModal } from "@/components/KeyRestoreModal";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ChatList } from "@/components/chat/ChatList";
import { Composer } from "@/components/chat/Composer";
import { EmptyChatState } from "@/components/chat/EmptyChatState";
import { MessageList } from "@/components/chat/MessageList";
import { MyProfilePanel } from "@/components/panels/MyProfilePanel";
import { NewChatPanel } from "@/components/panels/NewChatPanel";
import { PeerProfileDrawer } from "@/components/panels/PeerProfileDrawer";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { ImageAttachmentMock, LocationAttachmentMock } from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

type LeftSidebarView = "chats" | "new-chat" | "profile" | "settings";
type OverlayModal = "none" | "shortcuts" | "voice-call" | "video-call";

export function RelayChatApp() {
  const router = useRouter();
  const { hydrated, user, hasLocalPrivateKey, hydrate, logout } = useAuthStore();

  const {
    chats,
    messagesByChat,
    paginationByChat,
    wsState,
    activeChatId,
    filter,
    searchQuery,
    inChatSearchOpen,
    inChatSearchQuery,
    replyingTo,
    editingMessage,
    sendError,
    isSkeletonLoading,
    theme,
    initTheme,
    toggleTheme,
    bootstrapRealtimeSession,
    teardownRealtimeSession,
    refreshConversations,
    selectChat,
    closeActiveChat,
    loadOlderMessages,
    setFilter,
    setSearchQuery,
    setInChatSearchOpen,
    setInChatSearchQuery,
    setReplyingTo,
    setEditingMessage,
    clearSendError,
    togglePinChat,
    toggleMuteChat,
    blockUser,
    unblockUser,
    notifyLocalTyping,
    sendTextMessage,
    submitEditMessage,
    deleteMessage,
    sendVoiceMessage,
    sendMockAttachItem,
  } = useChatStore();

  const [leftView, setLeftView] = useState<LeftSidebarView>("chats");
  const [peerDrawerOpen, setPeerDrawerOpen] = useState(false);
  const [modal, setModal] = useState<OverlayModal>("none");
  const [previewImage, setPreviewImage] = useState<ImageAttachmentMock | null>(
    null
  );
  const [previewLocation, setPreviewLocation] =
    useState<LocationAttachmentMock | null>(null);

  const [callMuted, setCallMuted] = useState(false);
  const [callCameraOff, setCallCameraOff] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Hydrate auth + theme on mount
  useEffect(() => {
    initTheme();
    hydrate();
  }, [initTheme, hydrate]);

  // 2. Redirect unauthenticated browsers to /login
  useEffect(() => {
    if (hydrated && !user) {
      teardownRealtimeSession();
      router.replace("/login");
    }
  }, [hydrated, user, teardownRealtimeSession, router]);

  // 3. Bootstrap real conversations + contacts + blocks + JWT WebSocket once authenticated
  useEffect(() => {
    if (!hydrated || !user) return;
    bootstrapRealtimeSession();
  }, [hydrated, user?.id, hasLocalPrivateKey, bootstrapRealtimeSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  const activeMessages = useMemo(
    () => (activeChatId ? messagesByChat[activeChatId] || [] : []),
    [messagesByChat, activeChatId]
  );

  const activePagination = activeChatId
    ? paginationByChat[activeChatId]
    : undefined;

  // Close peer drawer if active chat closes
  useEffect(() => {
    if (!activeChatId) {
      setPeerDrawerOpen(false);
    }
  }, [activeChatId]);

  // Global Keyboard Shortcuts: Esc closes drawer/panel/search/reply/edit/chat; Ctrl/Cmd+K focuses search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLeftView("chats");
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        if (modal !== "none" || previewImage || previewLocation) return;
        if (peerDrawerOpen) {
          setPeerDrawerOpen(false);
          return;
        }
        if (leftView !== "chats") {
          setLeftView("chats");
          return;
        }
        if (inChatSearchOpen) {
          setInChatSearchOpen(false);
          return;
        }
        if (editingMessage) {
          setEditingMessage(null);
          return;
        }
        if (replyingTo) {
          setReplyingTo(null);
          return;
        }
        if (activeChatId) {
          closeActiveChat();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    modal,
    previewImage,
    previewLocation,
    peerDrawerOpen,
    leftView,
    inChatSearchOpen,
    editingMessage,
    replyingTo,
    activeChatId,
    setInChatSearchOpen,
    setEditingMessage,
    setReplyingTo,
    closeActiveChat,
  ]);

  const handleLogout = async () => {
    teardownRealtimeSession();
    await logout();
    router.replace("/login");
  };

  const handleToggleBlockActivePeer = async () => {
    if (!activeChat?.peerUserId) return;
    if (activeChat.isBlockedByMe) {
      await unblockUser(activeChat.peerUserId);
    } else {
      await blockUser({ targetUserId: activeChat.peerUserId });
    }
  };

  if (!hydrated || !user) {
    return (
      <div
        style={{
          backgroundColor: "var(--rc-app-backdrop)",
          color: "var(--rc-text-primary)",
        }}
        className="h-screen w-screen flex flex-col items-center justify-center gap-3"
      >
        <Loader2 className="w-8 h-8 animate-spin text-[#00a884]" />
        <span
          style={{ color: "var(--rc-text-secondary)" }}
          className="text-sm font-medium"
        >
          Unlocking local E2EE keystore...
        </span>
      </div>
    );
  }

  return (
    <div
      style={{ backgroundColor: "var(--rc-app-backdrop)" }}
      className="h-screen w-screen overflow-hidden flex items-center justify-center xl:p-4 relative"
    >
      <KeyRestoreModal />

      {/* Top Emerald Ribbon on Wide Desktop Viewports */}
      <div
        style={{ backgroundColor: "var(--rc-ribbon)" }}
        className="hidden xl:block fixed top-0 inset-x-0 h-32 pointer-events-none"
      />

      {/* Main Responsive Messenger Container */}
      <div
        style={{
          backgroundColor: "var(--rc-sidebar-bg)",
          borderColor: "var(--rc-border)",
        }}
        className="relative z-10 w-full h-full xl:max-w-[1600px] xl:rounded-xl overflow-hidden shadow-2xl border flex"
      >
        {/* LEFT PANE: ChatList OR slide-over WhatsApp Panels (New Chat / Profile / Settings) */}
        <div
          className={`${
            activeChat && leftView === "chats" ? "hidden md:flex" : "flex"
          } w-full md:w-[34%] md:min-w-[320px] md:max-w-[440px] h-full shrink-0`}
        >
          {leftView === "new-chat" ? (
            <NewChatPanel
              onClose={() => setLeftView("chats")}
              onChatOpened={() => setLeftView("chats")}
            />
          ) : leftView === "profile" ? (
            <MyProfilePanel onClose={() => setLeftView("chats")} />
          ) : leftView === "settings" ? (
            <SettingsPanel onClose={() => setLeftView("chats")} />
          ) : (
            <ChatList
              currentUserName={user.display_name}
              currentUserId={user.global_id}
              currentUserAvatarUrl={user.avatar_url}
              currentUserAvatarColor="#00a884"
              wsState={wsState}
              chats={chats}
              activeChatId={activeChatId}
              filter={filter}
              searchQuery={searchQuery}
              isSkeletonLoading={isSkeletonLoading}
              theme={theme}
              searchInputRef={searchInputRef}
              onSelectChat={(id) => {
                selectChat(id);
              }}
              onFilterChange={setFilter}
              onSearchChange={setSearchQuery}
              onOpenNewChat={() => setLeftView("new-chat")}
              onOpenSettings={() => setLeftView("settings")}
              onOpenProfile={() => setLeftView("profile")}
              onOpenShortcuts={() => setModal("shortcuts")}
              onToggleTheme={toggleTheme}
              onReplaySkeleton={() => {
                refreshConversations();
              }}
              onLogout={handleLogout}
            />
          )}
        </div>

        {/* CENTER PANE: Active Chat View or Empty State */}
        <main
          className={`${
            activeChat && leftView === "chats" ? "flex" : "hidden md:flex"
          } ${peerDrawerOpen ? "hidden lg:flex" : ""} flex-1 min-w-0 h-full flex-col`}
        >
          {activeChat ? (
            <>
              <ChatHeader
                chat={activeChat}
                messageCount={
                  activeMessages.filter((m) => m.type !== "system").length
                }
                inChatSearchOpen={inChatSearchOpen}
                inChatSearchQuery={inChatSearchQuery}
                onBackMobile={closeActiveChat}
                onOpenContactInfo={() => setPeerDrawerOpen((v) => !v)}
                onStartVoiceCall={() => {
                  setCallMuted(false);
                  setModal("voice-call");
                }}
                onStartVideoCall={() => {
                  setCallMuted(false);
                  setCallCameraOff(false);
                  setModal("video-call");
                }}
                onToggleSearch={() => setInChatSearchOpen(!inChatSearchOpen)}
                onSearchQueryChange={setInChatSearchQuery}
                onTogglePin={() => togglePinChat(activeChat.id)}
                onToggleMute={() => toggleMuteChat(activeChat.id)}
                onToggleBlock={handleToggleBlockActivePeer}
                onCloseChat={closeActiveChat}
              />

              <MessageList
                chatId={activeChat.id}
                messages={activeMessages}
                isGroupChat={activeChat.isGroup}
                isTyping={activeChat.isTyping}
                typingUser={activeChat.typingUser}
                peerAvatarColor={activeChat.avatarColor}
                searchFilter={inChatSearchQuery}
                hasMoreOlder={activePagination?.hasMore ?? false}
                isLoadingOlder={activePagination?.isLoadingOlder ?? false}
                onLoadOlderMessages={() => loadOlderMessages(activeChat.id)}
                onReplyMessage={setReplyingTo}
                onEditMessage={setEditingMessage}
                onDeleteMessage={deleteMessage}
                onPreviewImage={setPreviewImage}
                onPreviewLocation={setPreviewLocation}
              />

              {sendError && (
                <div
                  data-testid="chat-send-error-banner"
                  className="px-4 py-2 bg-red-500/15 border-t border-red-500/30 text-red-500 text-xs flex items-center justify-between gap-2 shrink-0"
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{sendError}</span>
                  </span>
                  <button
                    type="button"
                    onClick={clearSendError}
                    className="p-1 rounded hover:bg-red-500/10"
                    aria-label="Dismiss error"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {activeChat.isBlockedByMe ? (
                <div
                  style={{
                    backgroundColor: "var(--rc-composer-bg)",
                    borderColor: "var(--rc-border)",
                  }}
                  data-testid="blocked-composer-banner"
                  className="px-4 py-3.5 border-t flex items-center justify-center gap-3 text-xs shrink-0"
                >
                  <span
                    style={{ color: "var(--rc-text-secondary)" }}
                    className="flex items-center gap-1.5"
                  >
                    <Ban className="w-4 h-4 text-red-500" />
                    <span>
                      You blocked <strong>{activeChat.name}</strong>.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={handleToggleBlockActivePeer}
                    data-testid="unblock-banner-button"
                    className="px-3 py-1 rounded-lg bg-[#00a884] text-white font-semibold hover:bg-[#008f6f] transition"
                  >
                    Unblock
                  </button>
                </div>
              ) : (
                <Composer
                  replyingTo={replyingTo}
                  editingMessage={editingMessage}
                  onCancelReply={() => setReplyingTo(null)}
                  onCancelEdit={() => setEditingMessage(null)}
                  onSendMessage={sendTextMessage}
                  onSubmitEdit={submitEditMessage}
                  onTypingChange={notifyLocalTyping}
                  onSendVoiceNote={sendVoiceMessage}
                  onSelectAttachOption={sendMockAttachItem}
                />
              )}
            </>
          ) : (
            <EmptyChatState />
          )}
        </main>

        {/* RIGHT PANE: Peer Profile / Contact Info Drawer */}
        {activeChat && peerDrawerOpen && (
          <PeerProfileDrawer
            chat={activeChat}
            onClose={() => setPeerDrawerOpen(false)}
          />
        )}
      </div>

      {/* ================= OVERLAY MODALS ================= */}

      {/* Keyboard Shortcuts Modal */}
      <Modal
        open={modal === "shortcuts"}
        onClose={() => setModal("none")}
        title="Keyboard Shortcuts"
      >
        <div className="space-y-2.5 text-sm">
          {[
            { keys: "Enter", desc: "Send / save message" },
            { keys: "Shift + Enter", desc: "Insert newline in message" },
            {
              keys: "Esc",
              desc: "Close drawer / panel / search / edit / active chat",
            },
            { keys: "Ctrl / Cmd + K", desc: "Focus chat search bar" },
          ].map((row) => (
            <div
              key={row.keys}
              style={{ backgroundColor: "var(--rc-header-bg)" }}
              className="flex items-center justify-between px-3.5 py-2.5 rounded-xl"
            >
              <span>{row.desc}</span>
              <kbd
                style={{
                  backgroundColor: "var(--rc-surface-elevated)",
                  borderColor: "var(--rc-border)",
                }}
                className="px-2 py-1 rounded-md border text-xs font-mono font-semibold"
              >
                {row.keys}
              </kbd>
            </div>
          ))}
        </div>
      </Modal>

      {/* Voice / Video Call Preview Modal */}
      <Modal
        open={(modal === "voice-call" || modal === "video-call") && !!activeChat}
        onClose={() => setModal("none")}
        title={modal === "video-call" ? "E2EE Video Call" : "E2EE Voice Call"}
        subtitle="WebRTC signaling comes in Phase 6"
      >
        {activeChat && (
          <div className="flex flex-col items-center text-center py-4 space-y-5">
            <Avatar
              name={activeChat.name}
              src={activeChat.avatarUrl}
              color={activeChat.avatarColor}
              size="xl"
              isGroup={activeChat.isGroup}
            />
            <div>
              <h3 className="text-lg font-semibold">{activeChat.name}</h3>
              <p className="text-xs text-[#00a884] mt-1 animate-pulse">
                Ringing {activeChat.globalId}...
              </p>
            </div>

            <div className="flex items-center gap-4 pt-2">
              <button
                type="button"
                onClick={() => setCallMuted((v) => !v)}
                style={{ backgroundColor: "var(--rc-header-bg)" }}
                className={`w-12 h-12 rounded-full flex items-center justify-center transition ${
                  callMuted ? "text-amber-500 ring-2 ring-amber-500" : ""
                }`}
                aria-label="Toggle mute"
              >
                <MicOff className="w-5 h-5" />
              </button>

              {modal === "video-call" && (
                <button
                  type="button"
                  onClick={() => setCallCameraOff((v) => !v)}
                  style={{ backgroundColor: "var(--rc-header-bg)" }}
                  className={`w-12 h-12 rounded-full flex items-center justify-center transition ${
                    callCameraOff ? "text-amber-500 ring-2 ring-amber-500" : ""
                  }`}
                  aria-label="Toggle camera"
                >
                  {callCameraOff ? (
                    <VideoOff className="w-5 h-5" />
                  ) : (
                    <Video className="w-5 h-5" />
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={() => setModal("none")}
                className="w-12 h-12 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition"
                aria-label="End call"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Image Lightbox Modal */}
      <Modal
        open={!!previewImage}
        onClose={() => setPreviewImage(null)}
        title={previewImage?.fileName || "Shared Photo"}
        maxWidthClass="max-w-2xl"
      >
        {previewImage && (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImage.dataUrl}
              alt={previewImage.caption || "Preview"}
              className="w-full rounded-xl object-contain max-h-[65vh]"
            />
            {previewImage.caption && (
              <p className="text-sm text-center">{previewImage.caption}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Location Preview Modal */}
      <Modal
        open={!!previewLocation}
        onClose={() => setPreviewLocation(null)}
        title={previewLocation?.label || "Shared Location"}
        subtitle={previewLocation?.address}
      >
        {previewLocation && (
          <div className="space-y-3">
            <div className="h-48 rounded-xl bg-[#eae6de] dark:bg-[#192630] relative flex items-center justify-center overflow-hidden border border-[var(--rc-border)]">
              <div className="p-2.5 rounded-full bg-red-500 text-white shadow-xl">
                <MapPin className="w-6 h-6" />
              </div>
              <span className="absolute bottom-2 right-3 text-[11px] font-mono px-2 py-0.5 rounded bg-black/50 text-white">
                {previewLocation.latitude.toFixed(4)}° N,{" "}
                {previewLocation.longitude.toFixed(4)}° E
              </span>
            </div>
            {previewLocation.isLive && (
              <div className="text-xs text-[#00a884] font-medium">
                ● {previewLocation.liveExpiresLabel} — end-to-end encrypted
                coordinates
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
