"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AtSign,
  Ban,
  Download,
  ExternalLink,
  Loader2,
  MicOff,
  Phone,
  PhoneOff,
  Smartphone,
  UploadCloud,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { KeyRestoreModal } from "@/components/KeyRestoreModal";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ChatList } from "@/components/chat/ChatList";
import { AttachMenuKind, Composer } from "@/components/chat/Composer";
import { EmptyChatState } from "@/components/chat/EmptyChatState";
import { LeafletLocationMap } from "@/components/chat/LeafletLocationMap";
import { LightboxMediaPayload } from "@/components/chat/MessageBubble";
import { MessageList } from "@/components/chat/MessageList";
import {
  ActiveLiveLocationBanner,
  UploadProgressTray,
} from "@/components/chat/UploadProgressTray";
import { GroupInfoDrawer } from "@/components/drawers/GroupInfoDrawer";
import { CameraCaptureModal } from "@/components/modals/CameraCaptureModal";
import { CreateGroupModal } from "@/components/modals/CreateGroupModal";
import { ForwardMessageModal } from "@/components/modals/ForwardMessageModal";
import { LocationShareModal } from "@/components/modals/LocationShareModal";
import { MediaStagingModal } from "@/components/modals/MediaStagingModal";
import { MessageReadByModal } from "@/components/modals/MessageReadByModal";
import { MyProfilePanel } from "@/components/panels/MyProfilePanel";
import { NewChatPanel } from "@/components/panels/NewChatPanel";
import { PeerProfileDrawer } from "@/components/panels/PeerProfileDrawer";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { StarredMessagesPanel } from "@/components/panels/StarredMessagesPanel";
import { StatusPanel } from "@/components/panels/StatusPanel";
import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { registerRelayChatServiceWorker } from "@/lib/push/webPushClient";
import { LocationAttachmentMock } from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";
import { useChatStore } from "@/store/useChatStore";

type LeftSidebarView =
  | "chats"
  | "new-chat"
  | "profile"
  | "settings"
  | "status"
  | "starred";
type OverlayModal =
  | "none"
  | "shortcuts"
  | "voice-call"
  | "video-call"
  | "location-share"
  | "camera-capture"
  | "create-group";

export function RelayChatApp() {
  const router = useRouter();
  const { hydrated, user, hasLocalPrivateKey, hydrate, logout } = useAuthStore();

  const {
    chats,
    messagesByChat,
    paginationByChat,
    activeUploads,
    activeLiveShares,
    mentionAlerts,
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
    dismissMentionAlert,
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
    toggleArchiveChat,
    setDisappearingTimer,
    exportChatHistory,
    incomingCall,
    sendCallSignal,
    clearIncomingCall,
    blockUser,
    unblockUser,
    notifyLocalTyping,
    sendTextMessage,
    submitEditMessage,
    deleteMessage,
    sendAttachmentFile,
    cancelUpload,
    sendRecordedVoiceMessage,
    sendVoiceMessage,
    sendStaticLocation,
    startLiveLocationShare,
    stopLiveLocationShare,
    sendMockAttachItem,
  } = useChatStore();

  const [leftView, setLeftView] = useState<LeftSidebarView>("chats");
  const [peerDrawerOpen, setPeerDrawerOpen] = useState(false);
  const [modal, setModal] = useState<OverlayModal>("none");
  const [groupModalMode, setGroupModalMode] = useState<"create" | "join">("create");
  const [urlInviteCode, setUrlInviteCode] = useState("");
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [isDraggingOverChat, setIsDraggingOverChat] = useState(false);

  const [previewMedia, setPreviewMedia] = useState<LightboxMediaPayload | null>(
    null
  );
  const [previewLocation, setPreviewLocation] =
    useState<LocationAttachmentMock | null>(null);

  const [callMuted, setCallMuted] = useState(false);
  const [callCameraOff, setCallCameraOff] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [pwaInstallPrompt, setPwaInstallPrompt] = useState<
    (Event & { prompt?: () => Promise<void> }) | null
  >(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  // 1. Hydrate auth + theme + register PWA/WebPush Service Worker on mount
  useEffect(() => {
    initTheme();
    hydrate();
    registerRelayChatServiceWorker().catch(() => undefined);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setPwaInstallPrompt(e as Event & { prompt?: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, [initTheme, hydrate]);

  // 1b. Dynamic unread badge in browser tab title
  useEffect(() => {
    if (typeof document === "undefined") return;
    const totalUnread = chats.reduce(
      (sum, c) => sum + (c.isMuted || c.isArchived ? 0 : c.unreadCount || 0),
      0
    );
    document.title =
      totalUnread > 0
        ? `(${totalUnread}) RelayChat — Federated E2EE Messenger`
        : "RelayChat — Federated E2EE Messenger";
  }, [chats]);

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
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode) {
        setUrlInviteCode(joinCode);
        setGroupModalMode("join");
        setModal("create-group");
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, "", cleanUrl);
      }
    }
  }, [hydrated, user?.id, hasLocalPrivateKey, bootstrapRealtimeSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  const activeMessages = useMemo(
    () => (activeChatId ? messagesByChat[activeChatId] || [] : []),
    [messagesByChat, activeChatId]
  );

  const activeChatUploads = useMemo(
    () =>
      activeChatId
        ? Object.values(activeUploads).filter((u) => u.chatId === activeChatId)
        : [],
    [activeUploads, activeChatId]
  );

  const activeChatLiveShares = useMemo(
    () =>
      activeChatId
        ? Object.values(activeLiveShares).filter(
            (s) => s.chatId === activeChatId
          )
        : [],
    [activeLiveShares, activeChatId]
  );

  const activePagination = activeChatId
    ? paginationByChat[activeChatId]
    : undefined;

  useEffect(() => {
    if (!activeChatId) {
      setPeerDrawerOpen(false);
      setIsDraggingOverChat(false);
      dragCounterRef.current = 0;
    }
  }, [activeChatId]);

  // Window-level clipboard paste fallback when active chat is open
  useEffect(() => {
    if (!activeChat || activeChat.isBlockedByMe) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            const named =
              f.name && f.name !== "image.png"
                ? f
                : new File(
                    [f],
                    `pasted-${Date.now()}.${
                      (f.type.split("/")[1] || "png").split(";")[0]
                    }`,
                    { type: f.type || "image/png" }
                  );
            setStagedFile(named);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [activeChat]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLeftView("chats");
        searchInputRef.current?.focus();
        return;
      }

      if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setLeftView("status");
        return;
      }

      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setLeftView("new-chat");
        return;
      }

      if (e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setLeftView("starred");
        return;
      }

      if (e.key === "Escape") {
        if (
          modal !== "none" ||
          stagedFile ||
          previewMedia ||
          previewLocation
        ) {
          return;
        }
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
    stagedFile,
    previewMedia,
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

  const handleAttachMenuAction = (kind: AttachMenuKind) => {
    if (kind === "location") {
      setModal("location-share");
      return;
    }
    if (kind === "camera") {
      setModal("camera-capture");
      return;
    }
    sendMockAttachItem(kind);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLElement>) => {
    if (!activeChat || activeChat.isBlockedByMe) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingOverChat(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!activeChat || activeChat.isBlockedByMe) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (!activeChat || activeChat.isBlockedByMe) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingOverChat(false);
    }
  };

  const handleDropFiles = async (e: React.DragEvent<HTMLElement>) => {
    if (!activeChat || activeChat.isBlockedByMe) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingOverChat(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    if (files.length === 1) {
      setStagedFile(files[0]);
      return;
    }
    // Multiple files dropped: encrypt & upload all sequentially
    for (const f of files) {
      await sendAttachmentFile(f);
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
        {/* LEFT PANE */}
        <div
          className={`${
            activeChat && leftView === "chats" ? "hidden md:flex" : "flex"
          } w-full md:w-[34%] md:min-w-[320px] md:max-w-[440px] h-full shrink-0`}
        >
          {leftView === "new-chat" ? (
            <NewChatPanel
              onClose={() => setLeftView("chats")}
              onChatOpened={() => setLeftView("chats")}
              onOpenCreateGroup={(m = "create") => {
                setUrlInviteCode("");
                setGroupModalMode(m);
                setModal("create-group");
              }}
            />
          ) : leftView === "profile" ? (
            <MyProfilePanel onClose={() => setLeftView("chats")} />
          ) : leftView === "settings" ? (
            <SettingsPanel onClose={() => setLeftView("chats")} />
          ) : leftView === "status" ? (
            <StatusPanel
              onBack={() => setLeftView("chats")}
              onOpenedChatFromReply={() => setLeftView("chats")}
            />
          ) : leftView === "starred" ? (
            <StarredMessagesPanel
              onBack={() => setLeftView("chats")}
              onJumpToChatMessage={(chatId) => {
                selectChat(chatId);
                setLeftView("chats");
              }}
            />
          ) : (
            <ChatList
              currentUserName={user.display_name}
              currentUserId={user.global_id}
              currentUserAvatarUrl={user.avatar_url}
              currentUserAvatarColor="#00a884"
              wsState={wsState}
              chats={chats}
              messagesByChat={messagesByChat}
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
              onOpenCreateGroup={() => {
                setUrlInviteCode("");
                setGroupModalMode("create");
                setModal("create-group");
              }}
              onOpenStatus={() => setLeftView("status")}
              onOpenStarred={() => setLeftView("starred")}
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

        {/* CENTER PANE: Active Chat View (with Drag-and-Drop Dropzone) */}
        <main
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDropFiles}
          className={`${
            activeChat && leftView === "chats" ? "flex" : "hidden md:flex"
          } ${peerDrawerOpen ? "hidden lg:flex" : ""} flex-1 min-w-0 h-full flex-col relative`}
        >
          {activeChat ? (
            <>
              {/* Drag-and-drop overlay */}
              {isDraggingOverChat && (
                <div
                  data-testid="chat-dropzone-overlay"
                  className="absolute inset-3 z-40 rounded-2xl border-2 border-dashed border-[#00a884] bg-[#111b21]/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3 text-white pointer-events-none"
                >
                  <div className="w-16 h-16 rounded-full bg-[#00a884]/25 text-[#00a884] flex items-center justify-center">
                    <UploadCloud className="w-8 h-8" />
                  </div>
                  <div className="text-base font-semibold">
                    Drop files to encrypt &amp; send to {activeChat.name}
                  </div>
                  <div className="text-xs text-white/70">
                    Random AES-256-GCM key per file • 1 MB chunks • Max 100 MB
                  </div>
                </div>
              )}

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
                  const cid = `call-${Date.now()}`;
                  setCallMuted(false);
                  setActiveCallId(cid);
                  setModal("voice-call");
                  if (activeChat.peerUserId) {
                    sendCallSignal("call.offer", {
                      call_id: cid,
                      conversation_id: activeChat.id,
                      to_user_id: activeChat.peerUserId,
                      to_global_id: activeChat.globalId,
                      call_type: "voice",
                      payload: { sdp: "webrtc-dtls-srtp-offer" },
                    });
                  }
                }}
                onStartVideoCall={() => {
                  const cid = `call-${Date.now()}`;
                  setCallMuted(false);
                  setCallCameraOff(false);
                  setActiveCallId(cid);
                  setModal("video-call");
                  if (activeChat.peerUserId) {
                    sendCallSignal("call.offer", {
                      call_id: cid,
                      conversation_id: activeChat.id,
                      to_user_id: activeChat.peerUserId,
                      to_global_id: activeChat.globalId,
                      call_type: "video",
                      payload: { sdp: "webrtc-dtls-srtp-video-offer" },
                    });
                  }
                }}
                onToggleSearch={() => setInChatSearchOpen(!inChatSearchOpen)}
                onSearchQueryChange={setInChatSearchQuery}
                onTogglePin={() => togglePinChat(activeChat.id)}
                onToggleMute={() => toggleMuteChat(activeChat.id)}
                onToggleArchive={() => toggleArchiveChat(activeChat.id)}
                onSetDisappearingTimer={(secs) =>
                  setDisappearingTimer(activeChat.id, secs)
                }
                onExportChat={(fmt) => exportChatHistory(activeChat.id, fmt)}
                onToggleBlock={handleToggleBlockActivePeer}
                onCloseChat={closeActiveChat}
              />

              <ActiveLiveLocationBanner
                liveShares={activeChatLiveShares}
                onStopShare={(msgId) => stopLiveLocationShare(msgId)}
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
                onPreviewImage={setPreviewMedia}
                onPreviewLocation={setPreviewLocation}
                onStopLiveLocation={(msgId) => stopLiveLocationShare(msgId)}
              />

              <UploadProgressTray
                uploads={activeChatUploads}
                onCancelUpload={cancelUpload}
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
                  onSendRecordedVoice={sendRecordedVoiceMessage}
                  onStageFile={(file) => setStagedFile(file)}
                  onSelectAttachOption={handleAttachMenuAction}
                />
              )}
            </>
          ) : (
            <EmptyChatState />
          )}
        </main>

        {/* RIGHT PANE */}
        {activeChat &&
          peerDrawerOpen &&
          (activeChat.isGroup ? (
            <GroupInfoDrawer
              open={peerDrawerOpen}
              chat={activeChat}
              messages={activeMessages}
              onClose={() => setPeerDrawerOpen(false)}
              onPreviewMedia={setPreviewMedia}
            />
          ) : (
            <PeerProfileDrawer
              chat={activeChat}
              onClose={() => setPeerDrawerOpen(false)}
            />
          ))}
      </div>

      {/* Live @Mention Notification Toasts */}
      {mentionAlerts.length > 0 && (
        <div
          data-testid="mention-toast-stack"
          className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-xs w-full pointer-events-auto"
        >
          {mentionAlerts.map((alert) => (
            <div
              key={alert.id}
              style={{
                backgroundColor: "var(--rc-surface-elevated)",
                borderColor: "var(--rc-border)",
                color: "var(--rc-text-primary)",
              }}
              className="rounded-xl border shadow-2xl p-3 flex items-start gap-2.5 rc-animate-pop"
            >
              <div className="w-8 h-8 rounded-full bg-[#00a884]/15 text-[#00a884] flex items-center justify-center shrink-0">
                <AtSign className="w-4 h-4" />
              </div>
              <button
                type="button"
                onClick={() => {
                  dismissMentionAlert(alert.id);
                  selectChat(alert.groupId);
                }}
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-xs font-semibold truncate">
                  {alert.senderName} mentioned you
                </div>
                <div
                  style={{ color: "var(--rc-text-secondary)" }}
                  className="text-[11px] truncate"
                >
                  in {alert.groupName} • Tap to open
                </div>
              </button>
              <button
                type="button"
                onClick={() => dismissMentionAlert(alert.id)}
                className="p-1 rounded opacity-60 hover:opacity-100"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ================= OVERLAY MODALS ================= */}

      {/* Create Encrypted Group / Join via Invite Link Modal */}
      <CreateGroupModal
        open={modal === "create-group"}
        initialMode={groupModalMode}
        initialInviteCode={urlInviteCode}
        onClose={() => {
          setModal("none");
          setUrlInviteCode("");
        }}
      />

      {/* Per-Message Read By & Delivered To Modal */}
      <MessageReadByModal />

      {/* Forward Message Modal */}
      <ForwardMessageModal />

      {/* PWA Install Banner (shown when browser surfaces install prompt) */}
      {pwaInstallPrompt && (
        <div className="fixed bottom-4 left-4 z-40 rounded-xl bg-[#00a884] text-white px-3.5 py-2.5 shadow-xl flex items-center gap-2.5 text-xs font-medium">
          <Smartphone className="w-4 h-4 shrink-0" />
          <span>Install RelayChat PWA</span>
          <button
            type="button"
            onClick={async () => {
              await pwaInstallPrompt.prompt?.();
              setPwaInstallPrompt(null);
            }}
            className="px-2.5 py-1 rounded-lg bg-white text-slate-900 font-semibold"
          >
            Install
          </button>
          <button
            type="button"
            onClick={() => setPwaInstallPrompt(null)}
            className="opacity-80 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Incoming Live WebRTC Call Modal */}
      <Modal
        open={!!incomingCall && modal !== "voice-call" && modal !== "video-call"}
        onClose={() => {
          if (incomingCall) {
            sendCallSignal("call.decline", {
              call_id: incomingCall.callId,
              to_user_id: incomingCall.fromUserId,
              to_global_id: incomingCall.fromGlobalId,
              call_type: incomingCall.callType,
            });
          }
          clearIncomingCall();
        }}
        title={
          incomingCall?.callType === "video"
            ? "Incoming E2EE Video Call"
            : "Incoming E2EE Voice Call"
        }
        subtitle="DTLS-SRTP Encrypted Peer-to-Peer Call"
      >
        {incomingCall && (
          <div
            data-testid="incoming-call-modal"
            className="flex flex-col items-center text-center py-4 space-y-5"
          >
            <Avatar name={incomingCall.fromName} size="xl" />
            <div>
              <h3 className="text-lg font-semibold">{incomingCall.fromName}</h3>
              <p className="text-xs font-mono text-[#00a884] mt-1">
                {incomingCall.fromGlobalId}
              </p>
            </div>
            <div className="flex items-center gap-5 pt-2">
              <button
                type="button"
                data-testid="accept-call-button"
                onClick={() => {
                  sendCallSignal("call.answer", {
                    call_id: incomingCall.callId,
                    to_user_id: incomingCall.fromUserId,
                    to_global_id: incomingCall.fromGlobalId,
                    call_type: incomingCall.callType,
                    payload: { sdp: "webrtc-dtls-srtp-answer" },
                  });
                  setActiveCallId(incomingCall.callId);
                  if (incomingCall.conversationId) {
                    selectChat(incomingCall.conversationId);
                  }
                  setModal(
                    incomingCall.callType === "video"
                      ? "video-call"
                      : "voice-call"
                  );
                }}
                className="w-12 h-12 rounded-full bg-[#00a884] hover:bg-[#008f6f] text-white flex items-center justify-center shadow-lg transition"
                aria-label="Accept call"
              >
                <Phone className="w-5 h-5" />
              </button>
              <button
                type="button"
                data-testid="decline-call-button"
                onClick={() => {
                  sendCallSignal("call.decline", {
                    call_id: incomingCall.callId,
                    to_user_id: incomingCall.fromUserId,
                    to_global_id: incomingCall.fromGlobalId,
                    call_type: incomingCall.callType,
                  });
                  clearIncomingCall();
                }}
                className="w-12 h-12 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition"
                aria-label="Decline call"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Staged Media / Document / Paste / Drop Modal */}
      <MediaStagingModal
        file={stagedFile}
        onClose={() => setStagedFile(null)}
        onConfirmSend={async (file, caption) => {
          await sendAttachmentFile(file, { caption });
        }}
      />

      {/* Camera Photo Capture Modal */}
      <CameraCaptureModal
        open={modal === "camera-capture"}
        onClose={() => setModal("none")}
        onCapturedFile={(file) => setStagedFile(file)}
      />

      {/* Static & Live Location Share Modal */}
      <LocationShareModal
        open={modal === "location-share"}
        onClose={() => setModal("none")}
        onSendStatic={async (loc) => {
          await sendStaticLocation(loc);
        }}
        onStartLive={async (loc) => {
          await startLiveLocationShare(loc);
        }}
      />

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
            { keys: "Ctrl / Cmd + V", desc: "Paste image or file into chat" },
            {
              keys: "Esc",
              desc: "Close drawer / panel / search / edit / active chat",
            },
            { keys: "Ctrl / Cmd + K", desc: "Focus chat & decrypted message search" },
            { keys: "Alt + S", desc: "Open 24h Status / Stories" },
            { keys: "Alt + A", desc: "Open Starred messages" },
            { keys: "Alt + N", desc: "Start a new encrypted chat" },
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

      {/* Voice / Video Call Modal (WebRTC + WS Signaling) */}
      <Modal
        open={(modal === "voice-call" || modal === "video-call") && !!activeChat}
        onClose={() => {
          if (activeChat?.peerUserId && activeCallId) {
            sendCallSignal("call.hangup", {
              call_id: activeCallId,
              to_user_id: activeChat.peerUserId,
              to_global_id: activeChat.globalId,
              call_type: modal === "video-call" ? "video" : "voice",
            });
          }
          clearIncomingCall();
          setActiveCallId(null);
          setModal("none");
        }}
        title={modal === "video-call" ? "E2EE Video Call" : "E2EE Voice Call"}
        subtitle="DTLS-SRTP Peer-to-Peer Encrypted Signaling"
      >
        {activeChat && (
          <div
            data-testid="active-call-modal"
            className="flex flex-col items-center text-center py-4 space-y-5"
          >
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
                {incomingCall?.status === "connected"
                  ? `Connected • ${activeChat.globalId}`
                  : `Ringing ${activeChat.globalId}...`}
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
                data-testid="end-call-button"
                onClick={() => {
                  if (activeChat.peerUserId && activeCallId) {
                    sendCallSignal("call.hangup", {
                      call_id: activeCallId,
                      to_user_id: activeChat.peerUserId,
                      to_global_id: activeChat.globalId,
                      call_type: modal === "video-call" ? "video" : "voice",
                    });
                  }
                  clearIncomingCall();
                  setActiveCallId(null);
                  setModal("none");
                }}
                className="w-12 h-12 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition"
                aria-label="End call"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Image & Video Lightbox Modal */}
      <Modal
        open={!!previewMedia}
        onClose={() => setPreviewMedia(null)}
        title={previewMedia?.fileName || "Decrypted Media"}
        maxWidthClass="max-w-3xl"
      >
        {previewMedia && (
          <div data-testid="media-lightbox" className="space-y-3">
            {previewMedia.isVideo ? (
              <video
                src={previewMedia.url}
                controls
                autoPlay
                playsInline
                className="w-full rounded-xl max-h-[68vh] bg-black"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewMedia.url}
                alt={previewMedia.caption || "Preview"}
                className="w-full rounded-xl object-contain max-h-[68vh]"
              />
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-sm truncate">{previewMedia.caption || ""}</p>
              <a
                href={previewMedia.url}
                download={previewMedia.fileName}
                data-testid="lightbox-download-button"
                className="px-3.5 py-1.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download</span>
              </a>
            </div>
          </div>
        )}
      </Modal>

      {/* Interactive Leaflet Location Preview Modal */}
      <Modal
        open={!!previewLocation}
        onClose={() => setPreviewLocation(null)}
        title={previewLocation?.label || "Shared Location"}
        subtitle={previewLocation?.address}
      >
        {previewLocation && (
          <div className="space-y-3">
            <div className="rounded-xl overflow-hidden border border-[var(--rc-border)]">
              <LeafletLocationMap
                latitude={previewLocation.latitude}
                longitude={previewLocation.longitude}
                isLive={
                  !!previewLocation.isLive && !previewLocation.liveStopped
                }
                interactive
                heightClass="h-60"
              />
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono text-[11px] opacity-80">
                {previewLocation.latitude.toFixed(5)}°,{" "}
                {previewLocation.longitude.toFixed(5)}°
              </span>
              <a
                href={`https://www.openstreetmap.org/?mlat=${previewLocation.latitude}&mlon=${previewLocation.longitude}#map=16/${previewLocation.latitude}/${previewLocation.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white font-semibold inline-flex items-center gap-1.5 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open in Maps</span>
              </a>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
