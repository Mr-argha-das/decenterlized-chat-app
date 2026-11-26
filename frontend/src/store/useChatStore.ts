"use client";

import { create } from "zustand";
import {
  ApiBlock,
  ApiContact,
  ApiConversation,
  ApiCursorMessages,
  ApiEncryptedMessage,
  PeerProfileView,
  UserProfile,
} from "@/lib/api/client";
import {
  DecryptedMessagePayload,
  decryptDirectMessage,
  encryptDirectMessage,
} from "@/lib/crypto/e2ee";
import { loadIdentityKeyFromIndexedDB } from "@/lib/crypto/keystore";
import {
  RealtimeConnectionState,
  RealtimePacket,
  RealtimeWebSocketClient,
} from "@/lib/ws/realtimeClient";
import {
  MOCK_IMAGES,
  MockChat,
  MockMessage,
  MockMessageType,
} from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";

export type SidebarFilter = "all" | "unread" | "groups";

const AVATAR_PALETTE = [
  "#00a884",
  "#0284c7",
  "#7c3aed",
  "#e11d48",
  "#ea580c",
  "#0d9488",
  "#4f46e5",
  "#2563eb",
];

function colorForIdentifier(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function formatDateKeyAndLabel(iso: string): { dateKey: string; dateLabel: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { dateKey: "today", dateLabel: "TODAY" };
  }
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const dateKey = `${yyyy}-${mm}-${dd}`;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(yyyy, d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTarget) / 86_400_000);

  if (diffDays === 0) return { dateKey, dateLabel: "TODAY" };
  if (diffDays === 1) return { dateKey, dateLabel: "YESTERDAY" };
  const label = d
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
  return { dateKey, dateLabel: label };
}

function formatSidebarTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const { dateLabel } = formatDateKeyAndLabel(iso);
  if (dateLabel === "TODAY") return formatClock(iso);
  if (dateLabel === "YESTERDAY") return "Yesterday";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatLastSeenLabel(lastSeenIso: string | null | undefined): string {
  if (!lastSeenIso) return "";
  const { dateLabel } = formatDateKeyAndLabel(lastSeenIso);
  const time = formatClock(lastSeenIso);
  if (dateLabel === "TODAY") return `last seen today at ${time}`;
  if (dateLabel === "YESTERDAY") return `last seen yesterday at ${time}`;
  const d = new Date(lastSeenIso);
  const shortDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `last seen ${shortDate} at ${time}`;
}

export function playMessageNotificationChime(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // ignore audio autoplay restriction
  }
}

function deterministicWaveform(seed: string, bars = 34): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    h ^= i + 17;
    h = Math.imul(h, 16777619);
    const norm = ((h >>> 0) % 75) / 100 + 0.2;
    out.push(Number(norm.toFixed(2)));
  }
  return out;
}

function makeE2eeSystemBanner(chatId: string, createdIso?: string): MockMessage {
  const ts = createdIso || new Date().toISOString();
  const { dateKey, dateLabel } = formatDateKeyAndLabel(ts);
  return {
    id: `sys-e2ee-${chatId}`,
    chatId,
    senderId: "system",
    senderName: "System",
    type: "system",
    text: "Messages are end-to-end encrypted with ECDH P-256 + HKDF-SHA256 + AES-256-GCM. Not even this RelayChat node can read them.",
    timestamp: ts,
    timeLabel: formatClock(ts),
    dateKey,
    dateLabel,
  };
}

function mapApiTypeToUi(apiType: string): MockMessageType {
  if (apiType === "image") return "image";
  if (apiType === "voice" || apiType === "audio") return "voice";
  if (apiType === "location" || apiType === "live_location") return "location";
  if (apiType === "document" || apiType === "file") return "file";
  return "text";
}

function attachReplyReferences(messages: MockMessage[]): MockMessage[] {
  const byId = new Map<string, MockMessage>();
  for (const m of messages) {
    byId.set(m.id, m);
  }
  return messages.map((m) => {
    if (!m.replyToId || m.replyTo) return m;
    const ref = byId.get(m.replyToId);
    if (!ref) return m;
    return {
      ...m,
      replyTo: {
        messageId: ref.id,
        senderName: ref.senderId === "me" ? "You" : ref.senderName,
        previewText: ref.deletedForEveryone
          ? "This message was deleted"
          : ref.text ||
            ref.file?.fileName ||
            ref.location?.label ||
            (ref.type === "voice" ? "Voice message" : "Encrypted message"),
        type: ref.type,
      },
    };
  });
}

let wsClientInstance: RealtimeWebSocketClient | null = null;
const typingClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
let localTypingStopTimer: ReturnType<typeof setTimeout> | null = null;
let lastLocalTypingSentAt = 0;

interface PaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  initialized: boolean;
}

interface ChatStoreState {
  chats: MockChat[];
  messagesByChat: Record<string, MockMessage[]>;
  paginationByChat: Record<string, PaginationMeta>;
  directoryUsers: PeerProfileView[];
  contacts: ApiContact[];
  blocks: ApiBlock[];
  wsState: RealtimeConnectionState;
  sendError: string | null;

  activeChatId: string | null;
  filter: SidebarFilter;
  searchQuery: string;
  inChatSearchOpen: boolean;
  inChatSearchQuery: string;
  replyingTo: MockMessage | null;
  editingMessage: MockMessage | null;
  isSkeletonLoading: boolean;
  theme: "light" | "dark";

  initTheme: () => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  replaySkeletonLoader: () => void;
  clearSendError: () => void;

  bootstrapRealtimeSession: () => Promise<void>;
  teardownRealtimeSession: () => void;
  refreshConversations: () => Promise<void>;
  searchDirectoryUsers: (query: string) => Promise<void>;
  fetchContacts: (query?: string) => Promise<ApiContact[]>;
  addContactById: (identifier: string, nickname?: string) => Promise<ApiContact>;
  updateContactNickname: (contactUserId: string, nickname: string | null) => Promise<void>;
  removeContact: (contactUserId: string) => Promise<void>;
  fetchBlocks: () => Promise<ApiBlock[]>;
  blockUser: (params: { targetUserId?: string; identifier?: string }) => Promise<void>;
  unblockUser: (blockedUserId: string) => Promise<void>;
  fetchPeerProfile: (identifierOrId: string) => Promise<PeerProfileView>;
  startDirectChat: (peerUsernameOrId: { peerId?: string; peerUsername?: string }) => Promise<string | null>;

  selectChat: (chatId: string) => Promise<void>;
  closeActiveChat: () => void;
  loadOlderMessages: (chatId: string) => Promise<void>;

  setFilter: (filter: SidebarFilter) => void;
  setSearchQuery: (q: string) => void;
  setInChatSearchOpen: (open: boolean) => void;
  setInChatSearchQuery: (q: string) => void;
  setReplyingTo: (msg: MockMessage | null) => void;
  setEditingMessage: (msg: MockMessage | null) => void;

  togglePinChat: (chatId: string) => Promise<void>;
  toggleMuteChat: (chatId: string) => Promise<void>;
  notifyLocalTyping: (isTyping: boolean) => void;

  sendTextMessage: (text: string) => Promise<void>;
  submitEditMessage: (messageId: string, newText: string) => Promise<void>;
  deleteMessage: (messageId: string, scope: "me" | "everyone") => Promise<void>;
  sendVoiceMessage: (durationSeconds: number) => Promise<void>;
  sendMockAttachItem: (
    kind: "document" | "photos" | "camera" | "audio" | "location" | "contact"
  ) => Promise<void>;
}

function applyCssTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    window.localStorage.setItem("relaychat-ui-theme", theme);
  } catch {
    // ignore storage restriction
  }
}

async function getMyPrivateKeyJwk(): Promise<JsonWebKey | null> {
  const user = useAuthStore.getState().user;
  if (!user) return null;
  const record = await loadIdentityKeyFromIndexedDB(user.global_id);
  return record?.privateKeyJwk || null;
}

async function decryptApiMessageToUi(
  raw: ApiEncryptedMessage,
  myUserId: string,
  myPrivateKeyJwk: JsonWebKey | null,
  peerName: string,
  peerPublicKey: string | undefined,
  peerColor: string
): Promise<MockMessage> {
  const outgoing = raw.sender_id === myUserId;
  const { dateKey, dateLabel } = formatDateKeyAndLabel(raw.created_at);
  const timeLabel = formatClock(raw.created_at);

  if (raw.deleted_for_everyone) {
    return {
      id: raw.id,
      clientMsgId: raw.client_msg_id || undefined,
      chatId: raw.conversation_id,
      senderId: outgoing ? "me" : raw.sender_id,
      senderName: outgoing ? "You" : peerName,
      senderColor: peerColor,
      type: "text",
      text: "This message was deleted",
      timestamp: raw.created_at,
      timeLabel,
      dateKey,
      dateLabel,
      status: outgoing ? raw.status : undefined,
      deletedForEveryone: true,
      replyToId: raw.reply_to_id,
    };
  }

  let decrypted: DecryptedMessagePayload | null = null;
  let decryptionError = false;

  if (myPrivateKeyJwk && peerPublicKey) {
    try {
      decrypted = await decryptDirectMessage(
        myPrivateKeyJwk,
        peerPublicKey,
        raw.ciphertext,
        raw.nonce
      );
    } catch {
      decryptionError = true;
    }
  } else {
    decryptionError = true;
  }

  const uiType = mapApiTypeToUi(raw.type);
  const baseText = decryptionError
    ? "🔒 Waiting for matching E2EE key on this device"
    : decrypted?.text || "";

  const msg: MockMessage = {
    id: raw.id,
    clientMsgId: raw.client_msg_id || undefined,
    chatId: raw.conversation_id,
    senderId: outgoing ? "me" : raw.sender_id,
    senderName: outgoing ? "You" : peerName,
    senderColor: peerColor,
    type: decryptionError ? "text" : uiType,
    text: baseText,
    timestamp: raw.created_at,
    timeLabel,
    dateKey,
    dateLabel,
    status: outgoing ? raw.status : undefined,
    edited: !!raw.edited_at,
    decryptionError,
    replyToId: raw.reply_to_id,
  };

  if (!decryptionError && decrypted) {
    if (uiType === "voice") {
      msg.voice = {
        durationSeconds: decrypted.durationSec || 8,
        waveform: deterministicWaveform(raw.id),
      };
    } else if (uiType === "file") {
      const fname = decrypted.fileName || baseText || "encrypted-document.pdf";
      const ext = fname.includes(".") ? fname.split(".").pop() || "FILE" : "FILE";
      msg.file = {
        fileName: fname,
        fileSize: decrypted.fileSize || "240 KB",
        extension: ext.toUpperCase(),
      };
    } else if (uiType === "location") {
      msg.location = {
        label: baseText || "Pinned Location",
        address: decrypted.address || "End-to-end encrypted coordinates",
        latitude: decrypted.latitude ?? 26.9124,
        longitude: decrypted.longitude ?? 75.7873,
      };
    } else if (uiType === "image") {
      msg.image = {
        dataUrl: MOCK_IMAGES.jaipurSunset,
        caption: baseText,
        width: 800,
        height: 520,
        fileName: decrypted.fileName || "encrypted-photo.jpg",
      };
    }
  }

  return msg;
}

function previewTextFromMessage(msg: MockMessage | null): string {
  if (!msg) return "Tap to start end-to-end encrypted chat";
  if (msg.deletedForEveryone) return "🚫 This message was deleted";
  if (msg.type === "voice") return "Voice message";
  if (msg.type === "file") return msg.file?.fileName || "Document";
  if (msg.type === "location") return msg.location?.label || "Location";
  if (msg.type === "image") return msg.image?.caption || "Photo";
  return msg.text || "";
}

function sortChats(chats: MockChat[]): MockChat[] {
  return [...chats].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return Number(b.isPinned) - Number(a.isPinned);
    const ta = a.lastMessageIso ? new Date(a.lastMessageIso).getTime() : 0;
    const tb = b.lastMessageIso ? new Date(b.lastMessageIso).getTime() : 0;
    return tb - ta;
  });
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  chats: [],
  messagesByChat: {},
  paginationByChat: {},
  directoryUsers: [],
  contacts: [],
  blocks: [],
  wsState: "disconnected",
  sendError: null,

  activeChatId: null,
  filter: "all",
  searchQuery: "",
  inChatSearchOpen: false,
  inChatSearchQuery: "",
  replyingTo: null,
  editingMessage: null,
  isSkeletonLoading: true,
  theme: "dark",

  initTheme: () => {
    if (typeof window === "undefined") return;
    const authTheme = useAuthStore.getState().theme;
    let saved: "light" | "dark" = authTheme || "dark";
    try {
      const raw = window.localStorage.getItem("relaychat-ui-theme");
      if (raw === "light" || raw === "dark") saved = raw;
    } catch {
      // ignore
    }
    applyCssTheme(saved);
    set({ theme: saved });
  },

  setTheme: (theme) => {
    applyCssTheme(theme);
    set({ theme });
    useAuthStore.getState().setTheme(theme);
    if (useAuthStore.getState().user) {
      useAuthStore.getState().updateProfile({ theme }).catch(() => undefined);
    }
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    get().setTheme(next);
  },

  replaySkeletonLoader: () => {
    set({ isSkeletonLoading: true });
    setTimeout(() => set({ isSkeletonLoading: false }), 550);
  },

  clearSendError: () => set({ sendError: null }),

  teardownRealtimeSession: () => {
    if (wsClientInstance) {
      wsClientInstance.disconnect();
      wsClientInstance = null;
    }
    typingClearTimers.forEach((t) => clearTimeout(t));
    typingClearTimers.clear();
    set({
      chats: [],
      messagesByChat: {},
      paginationByChat: {},
      activeChatId: null,
      wsState: "disconnected",
    });
  },

  refreshConversations: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user || !auth.accessToken) return;
    const myPrivKey = await getMyPrivateKeyJwk();

    const apiConvs = await auth.authedRequest<ApiConversation[]>("/conversations");
    const mapped: MockChat[] = [];

    for (const conv of apiConvs) {
      const peer = conv.peer;
      const peerId = peer?.global_id || conv.id;
      const avatarColor = colorForIdentifier(peerId);
      const displayName = peer?.display_name || conv.name || peerId;

      let lastMsgUi: MockMessage | null = null;
      if (conv.last_message) {
        lastMsgUi = await decryptApiMessageToUi(
          conv.last_message,
          auth.user.id,
          myPrivKey,
          displayName,
          peer?.public_key,
          avatarColor
        );
      }

      const existing = get().chats.find((c) => c.id === conv.id);
      const lastIso = conv.last_message?.created_at || conv.last_message_at || conv.created_at;

      mapped.push({
        id: conv.id,
        name: displayName,
        rawDisplayName: peer?.raw_display_name || displayName,
        nickname: peer?.nickname || null,
        globalId: peer?.global_id || conv.id,
        peerUserId: peer?.id,
        peerPublicKey: peer?.public_key,
        avatarColor,
        avatarUrl: peer?.avatar_url || conv.icon_url || undefined,
        about: peer?.about ?? "",
        isGroup: conv.type === "group",
        isContact: peer?.is_contact ?? false,
        isBlockedByMe: peer?.is_blocked_by_me ?? false,
        hasBlockedMe: peer?.has_blocked_me ?? false,
        isOnline: peer?.is_online ?? false,
        lastSeen: formatLastSeenLabel(peer?.last_seen_at),
        lastSeenIso: peer?.last_seen_at,
        isPinned: conv.is_pinned,
        isMuted: conv.is_muted,
        isTyping: existing?.isTyping ?? false,
        unreadCount:
          get().activeChatId === conv.id ? 0 : conv.unread_count,
        lastMessagePreview: previewTextFromMessage(lastMsgUi),
        lastMessageType: lastMsgUi?.type || "text",
        lastMessageTime: formatSidebarTimestamp(lastIso),
        lastMessageIso: lastIso,
        lastMessageOutgoing: lastMsgUi ? lastMsgUi.senderId === "me" : false,
        lastMessageStatus: lastMsgUi?.status,
      });
    }

    set({
      chats: sortChats(mapped),
      isSkeletonLoading: false,
    });
  },

  searchDirectoryUsers: async (query: string) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return;
    try {
      const results = await auth.authedRequest<PeerProfileView[]>(
        `/users/search?q=${encodeURIComponent(query.trim())}`
      );
      set({ directoryUsers: results });
    } catch {
      // ignore transient error
    }
  },

  fetchContacts: async (query = "") => {
    const auth = useAuthStore.getState();
    if (!auth.user) return [];
    const list = await auth.authedRequest<ApiContact[]>(
      `/contacts?q=${encodeURIComponent(query.trim())}`
    );
    if (!query.trim()) {
      set({ contacts: list });
    }
    return list;
  },

  addContactById: async (identifier: string, nickname?: string) => {
    const auth = useAuthStore.getState();
    const created = await auth.authedRequest<ApiContact>("/contacts", {
      method: "POST",
      body: JSON.stringify({
        identifier: identifier.trim(),
        nickname: nickname?.trim() || undefined,
      }),
    });
    await Promise.all([get().fetchContacts(), get().refreshConversations()]);
    return created;
  },

  updateContactNickname: async (contactUserId: string, nickname: string | null) => {
    const auth = useAuthStore.getState();
    await auth.authedRequest<ApiContact>(`/contacts/${contactUserId}`, {
      method: "PATCH",
      body: JSON.stringify({ nickname }),
    });
    await Promise.all([get().fetchContacts(), get().refreshConversations()]);
  },

  removeContact: async (contactUserId: string) => {
    const auth = useAuthStore.getState();
    await auth.authedRequest(`/contacts/${contactUserId}`, {
      method: "DELETE",
    });
    await Promise.all([get().fetchContacts(), get().refreshConversations()]);
  },

  fetchBlocks: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user) return [];
    const list = await auth.authedRequest<ApiBlock[]>("/blocks");
    set({ blocks: list });
    return list;
  },

  blockUser: async ({ targetUserId, identifier }) => {
    const auth = useAuthStore.getState();
    await auth.authedRequest<ApiBlock>("/blocks", {
      method: "POST",
      body: JSON.stringify({
        target_user_id: targetUserId,
        identifier,
      }),
    });
    await Promise.all([get().fetchBlocks(), get().refreshConversations()]);
  },

  unblockUser: async (blockedUserId: string) => {
    const auth = useAuthStore.getState();
    await auth.authedRequest(`/blocks/${blockedUserId}`, {
      method: "DELETE",
    });
    await Promise.all([
      get().fetchBlocks(),
      get().refreshConversations(),
      get().fetchContacts(),
    ]);
  },

  fetchPeerProfile: async (identifierOrId: string) => {
    const auth = useAuthStore.getState();
    return auth.authedRequest<PeerProfileView>(
      `/users/profile/${encodeURIComponent(identifierOrId)}`
    );
  },

  startDirectChat: async ({ peerId, peerUsername }) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;
    const conv = await auth.authedRequest<ApiConversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({
        peer_id: peerId,
        peer_username: peerUsername,
      }),
    });
    await get().refreshConversations();
    await get().selectChat(conv.id);
    return conv.id;
  },

  bootstrapRealtimeSession: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user || !auth.accessToken) return;

    set({ isSkeletonLoading: true });
    await Promise.all([
      get().refreshConversations(),
      get().fetchContacts().catch(() => []),
      get().fetchBlocks().catch(() => []),
    ]);
    get().searchDirectoryUsers("").catch(() => undefined);

    if (!wsClientInstance) {
      wsClientInstance = new RealtimeWebSocketClient({
        getToken: () => useAuthStore.getState().accessToken,
        onAuthFailure: async () => {
          try {
            await useAuthStore.getState().authedRequest<UserProfile>("/users/me");
            return useAuthStore.getState().accessToken;
          } catch {
            return null;
          }
        },
      });

      wsClientInstance.subscribeState((wsState) => {
        set({ wsState });
      });

      wsClientInstance.subscribe(async (packet: RealtimePacket) => {
        const currentAuth = useAuthStore.getState();
        const myUser = currentAuth.user;
        if (!myUser) return;

        if (packet.event === "session.ready") {
          // Refresh conversation metadata + online statuses on reconnect
          get().refreshConversations().catch(() => undefined);
          return;
        }

        if (packet.event === "error") {
          const errMessage = String(packet.data?.message || "Message could not be sent.");
          const failedClientId =
            typeof packet.data?.client_msg_id === "string"
              ? packet.data.client_msg_id
              : null;
          set((state) => {
            const updatedByChat = { ...state.messagesByChat };
            if (failedClientId) {
              for (const cid of Object.keys(updatedByChat)) {
                updatedByChat[cid] = updatedByChat[cid].filter(
                  (m) => m.clientMsgId !== failedClientId && m.id !== failedClientId
                );
              }
            }
            return {
              sendError: errMessage,
              messagesByChat: updatedByChat,
            };
          });
          return;
        }

        if (packet.event === "presence.online" || packet.event === "presence.offline") {
          const peerUserId = String(packet.data.user_id || "");
          const isOnline = Boolean(packet.data.is_online);
          const lastSeenIso =
            packet.data.last_seen_at === null
              ? null
              : typeof packet.data.last_seen_at === "string"
                ? packet.data.last_seen_at
                : new Date().toISOString();

          set((state) => ({
            chats: state.chats.map((c) =>
              c.peerUserId === peerUserId
                ? {
                    ...c,
                    isOnline,
                    lastSeenIso,
                    lastSeen: formatLastSeenLabel(lastSeenIso),
                  }
                : c
            ),
          }));
          return;
        }

        if (packet.event === "typing.start" || packet.event === "typing.stop") {
          const convId = String(packet.data.conversation_id || "");
          const isStart = packet.event === "typing.start";
          const prevTimer = typingClearTimers.get(convId);
          if (prevTimer) {
            clearTimeout(prevTimer);
            typingClearTimers.delete(convId);
          }
          if (isStart) {
            const timer = setTimeout(() => {
              typingClearTimers.delete(convId);
              set((s) => ({
                chats: s.chats.map((c) =>
                  c.id === convId ? { ...c, isTyping: false } : c
                ),
              }));
            }, 4500);
            typingClearTimers.set(convId, timer);
          }
          set((state) => ({
            chats: state.chats.map((c) =>
              c.id === convId ? { ...c, isTyping: isStart } : c
            ),
          }));
          return;
        }

        if (packet.event === "message.ack") {
          const convId = String(packet.data.conversation_id || "");
          const msgId = String(packet.data.message_id || "");
          const clientMsgId =
            typeof packet.data.client_msg_id === "string"
              ? packet.data.client_msg_id
              : undefined;
          const nextStatus = packet.data.status as "sent" | "delivered" | "read";

          set((state) => {
            const list = state.messagesByChat[convId] || [];
            const updatedList = attachReplyReferences(
              list.map((m) => {
                if (m.id === msgId || (clientMsgId && m.clientMsgId === clientMsgId)) {
                  return {
                    ...m,
                    id: msgId || m.id,
                    status: nextStatus,
                  };
                }
                return m;
              })
            );

            return {
              messagesByChat: {
                ...state.messagesByChat,
                [convId]: updatedList,
              },
              chats: state.chats.map((c) => {
                if (c.id !== convId) return c;
                if (!c.lastMessageOutgoing) return c;
                return { ...c, lastMessageStatus: nextStatus };
              }),
            };
          });
          return;
        }

        if (
          packet.event === "message.new" ||
          packet.event === "message.updated" ||
          packet.event === "message.deleted"
        ) {
          const rawMsg = packet.data as unknown as ApiEncryptedMessage & {
            delete_scope?: string;
          };
          const convId = rawMsg.conversation_id;

          // Ensure conversation exists in local sidebar (e.g. first message from a new peer)
          let targetChat = get().chats.find((c) => c.id === convId);
          if (!targetChat) {
            await get().refreshConversations();
            targetChat = get().chats.find((c) => c.id === convId);
          }
          if (!targetChat) return;

          // Handle "delete for me" from another tab
          if (packet.event === "message.deleted" && rawMsg.delete_scope === "me") {
            set((state) => {
              const filtered = (state.messagesByChat[convId] || []).filter(
                (m) => m.id !== rawMsg.id
              );
              const lastVisible =
                [...filtered].reverse().find((m) => m.type !== "system") || null;
              return {
                messagesByChat: { ...state.messagesByChat, [convId]: filtered },
                chats: state.chats.map((c) =>
                  c.id === convId
                    ? {
                        ...c,
                        lastMessagePreview: previewTextFromMessage(lastVisible),
                        lastMessageType: lastVisible?.type || "text",
                        lastMessageOutgoing: lastVisible
                          ? lastVisible.senderId === "me"
                          : false,
                        lastMessageStatus: lastVisible?.status,
                      }
                    : c
                ),
              };
            });
            return;
          }

          const myPrivKey = await getMyPrivateKeyJwk();
          const uiMsg = await decryptApiMessageToUi(
            rawMsg,
            myUser.id,
            myPrivKey,
            targetChat.name,
            targetChat.peerPublicKey,
            targetChat.avatarColor
          );

          const isIncoming = rawMsg.sender_id !== myUser.id;
          const isChatActiveAndVisible =
            get().activeChatId === convId &&
            (typeof document === "undefined" || document.visibilityState === "visible");

          // Clear peer typing indicator when message arrives
          if (isIncoming && packet.event === "message.new") {
            const t = typingClearTimers.get(convId);
            if (t) {
              clearTimeout(t);
              typingClearTimers.delete(convId);
            }
          }

          set((state) => {
            const existingList = state.messagesByChat[convId] || [];
            let nextList: MockMessage[];

            const matchIdx = existingList.findIndex(
              (m) =>
                m.id === uiMsg.id ||
                (uiMsg.clientMsgId && m.clientMsgId === uiMsg.clientMsgId)
            );
            if (matchIdx >= 0) {
              nextList = [...existingList];
              nextList[matchIdx] = { ...existingList[matchIdx], ...uiMsg };
            } else {
              nextList = [...existingList, uiMsg];
            }

            const linkedList = attachReplyReferences(nextList);

            const updatedChats = state.chats.map((c) => {
              if (c.id !== convId) return c;
              const nextUnread =
                packet.event === "message.new" && isIncoming && !isChatActiveAndVisible
                  ? c.unreadCount + 1
                  : isChatActiveAndVisible
                    ? 0
                    : c.unreadCount;

              return {
                ...c,
                isTyping: isIncoming ? false : c.isTyping,
                unreadCount: nextUnread,
                lastMessagePreview: previewTextFromMessage(uiMsg),
                lastMessageType: uiMsg.type,
                lastMessageTime: formatSidebarTimestamp(uiMsg.timestamp),
                lastMessageIso: uiMsg.timestamp,
                lastMessageOutgoing: uiMsg.senderId === "me",
                lastMessageStatus: uiMsg.status,
              };
            });

            return {
              messagesByChat: {
                ...state.messagesByChat,
                [convId]: linkedList,
              },
              chats:
                packet.event === "message.new" ? sortChats(updatedChats) : updatedChats,
            };
          });

          // Automatically send delivery or read receipt back over WebSocket!
          if (isIncoming && packet.event === "message.new" && !rawMsg.deleted_for_everyone) {
            if (!targetChat.isMuted && !isChatActiveAndVisible) {
              if (myUser.notification_sound) {
                playMessageNotificationChime();
              }
              if (
                myUser.notifications_enabled &&
                typeof window !== "undefined" &&
                "Notification" in window &&
                Notification.permission === "granted"
              ) {
                try {
                  new Notification(targetChat.name, {
                    body: previewTextFromMessage(uiMsg),
                  });
                } catch {
                  // ignore
                }
              }
            }

            const ackStatus = isChatActiveAndVisible ? "read" : "delivered";
            const sentViaWs = wsClientInstance?.send("message.ack", {
              conversation_id: convId,
              message_ids: [rawMsg.id],
              status: ackStatus,
            });
            if (!sentViaWs) {
              currentAuth
                .authedRequest(`/conversations/${convId}/ack`, {
                  method: "POST",
                  body: JSON.stringify({
                    status: ackStatus,
                    message_ids: [rawMsg.id],
                  }),
                })
                .catch(() => undefined);
            }
          }
        }
      });
    }

    wsClientInstance.connect();
  },

  selectChat: async (chatId: string) => {
    const auth = useAuthStore.getState();
    set((state) => ({
      activeChatId: chatId,
      replyingTo: null,
      editingMessage: null,
      inChatSearchOpen: false,
      inChatSearchQuery: "",
      chats: state.chats.map((c) =>
        c.id === chatId ? { ...c, unreadCount: 0 } : c
      ),
    }));

    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat || !auth.user) return;

    const meta = get().paginationByChat[chatId];
    if (!meta?.initialized) {
      try {
        const page = await auth.authedRequest<ApiCursorMessages>(
          `/conversations/${chatId}/messages?limit=40`
        );
        const myPrivKey = await getMyPrivateKeyJwk();
        const decryptedItems: MockMessage[] = [];
        for (const item of page.items) {
          decryptedItems.push(
            await decryptApiMessageToUi(
              item,
              auth.user.id,
              myPrivKey,
              chat.name,
              chat.peerPublicKey,
              chat.avatarColor
            )
          );
        }

        const withBanner = page.has_more
          ? decryptedItems
          : [
              makeE2eeSystemBanner(chatId, decryptedItems[0]?.timestamp),
              ...decryptedItems,
            ];

        set((state) => ({
          messagesByChat: {
            ...state.messagesByChat,
            [chatId]: attachReplyReferences(withBanner),
          },
          paginationByChat: {
            ...state.paginationByChat,
            [chatId]: {
              nextCursor: page.next_cursor,
              hasMore: page.has_more,
              isLoadingOlder: false,
              initialized: true,
            },
          },
        }));
      } catch {
        // ignore
      }
    }

    // Acknowledge all unread messages in this conversation as "read"
    const sentWs = wsClientInstance?.send("message.ack", {
      conversation_id: chatId,
      status: "read",
    });
    if (!sentWs) {
      auth
        .authedRequest(`/conversations/${chatId}/ack`, {
          method: "POST",
          body: JSON.stringify({ status: "read" }),
        })
        .catch(() => undefined);
    }
  },

  loadOlderMessages: async (chatId: string) => {
    const auth = useAuthStore.getState();
    const chat = get().chats.find((c) => c.id === chatId);
    const meta = get().paginationByChat[chatId];
    if (!auth.user || !chat || !meta || !meta.hasMore || meta.isLoadingOlder || !meta.nextCursor) {
      return;
    }

    set((state) => ({
      paginationByChat: {
        ...state.paginationByChat,
        [chatId]: { ...meta, isLoadingOlder: true },
      },
    }));

    try {
      const page = await auth.authedRequest<ApiCursorMessages>(
        `/conversations/${chatId}/messages?limit=40&cursor=${encodeURIComponent(
          meta.nextCursor
        )}`
      );
      const myPrivKey = await getMyPrivateKeyJwk();
      const olderDecrypted: MockMessage[] = [];
      for (const item of page.items) {
        olderDecrypted.push(
          await decryptApiMessageToUi(
            item,
            auth.user.id,
            myPrivKey,
            chat.name,
            chat.peerPublicKey,
            chat.avatarColor
          )
        );
      }

      set((state) => {
        const current = (state.messagesByChat[chatId] || []).filter(
          (m) => m.id !== `sys-e2ee-${chatId}`
        );
        const existingIds = new Set(current.map((m) => m.id));
        const dedupedOlder = olderDecrypted.filter((m) => !existingIds.has(m.id));
        const combined = [...dedupedOlder, ...current];
        const finalMessages = page.has_more
          ? combined
          : [makeE2eeSystemBanner(chatId, combined[0]?.timestamp), ...combined];

        return {
          messagesByChat: {
            ...state.messagesByChat,
            [chatId]: attachReplyReferences(finalMessages),
          },
          paginationByChat: {
            ...state.paginationByChat,
            [chatId]: {
              nextCursor: page.next_cursor,
              hasMore: page.has_more,
              isLoadingOlder: false,
              initialized: true,
            },
          },
        };
      });
    } catch {
      set((state) => ({
        paginationByChat: {
          ...state.paginationByChat,
          [chatId]: { ...meta, isLoadingOlder: false },
        },
      }));
    }
  },

  closeActiveChat: () =>
    set({
      activeChatId: null,
      replyingTo: null,
      editingMessage: null,
      inChatSearchOpen: false,
      inChatSearchQuery: "",
    }),

  setFilter: (filter) => set({ filter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setInChatSearchOpen: (inChatSearchOpen) =>
    set({
      inChatSearchOpen,
      inChatSearchQuery: inChatSearchOpen ? get().inChatSearchQuery : "",
    }),
  setInChatSearchQuery: (inChatSearchQuery) => set({ inChatSearchQuery }),
  setReplyingTo: (replyingTo) => set({ replyingTo, editingMessage: null }),
  setEditingMessage: (editingMessage) => set({ editingMessage, replyingTo: null }),

  togglePinChat: async (chatId: string) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const nextPinned = !chat.isPinned;
    set((state) => ({
      chats: sortChats(
        state.chats.map((c) => (c.id === chatId ? { ...c, isPinned: nextPinned } : c))
      ),
    }));
    try {
      await useAuthStore.getState().authedRequest(`/conversations/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_pinned: nextPinned }),
      });
    } catch {
      // ignore
    }
  },

  toggleMuteChat: async (chatId: string) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const nextMuted = !chat.isMuted;
    set((state) => ({
      chats: state.chats.map((c) => (c.id === chatId ? { ...c, isMuted: nextMuted } : c)),
    }));
    try {
      await useAuthStore.getState().authedRequest(`/conversations/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_muted: nextMuted }),
      });
    } catch {
      // ignore
    }
  },

  notifyLocalTyping: (isTyping: boolean) => {
    const { activeChatId } = get();
    if (!activeChatId || !wsClientInstance) return;

    if (!isTyping) {
      if (localTypingStopTimer) {
        clearTimeout(localTypingStopTimer);
        localTypingStopTimer = null;
      }
      lastLocalTypingSentAt = 0;
      wsClientInstance.send("typing.stop", { conversation_id: activeChatId });
      return;
    }

    const now = Date.now();
    if (now - lastLocalTypingSentAt > 1500) {
      lastLocalTypingSentAt = now;
      wsClientInstance.send("typing.start", { conversation_id: activeChatId });
    }
    if (localTypingStopTimer) clearTimeout(localTypingStopTimer);
    const targetConv = activeChatId;
    localTypingStopTimer = setTimeout(() => {
      localTypingStopTimer = null;
      lastLocalTypingSentAt = 0;
      wsClientInstance?.send("typing.stop", { conversation_id: targetConv });
    }, 2400);
  },

  sendTextMessage: async (rawText: string) => {
    const text = rawText.trim();
    const { activeChatId, replyingTo } = get();
    const auth = useAuthStore.getState();
    if (!text || !activeChatId || !auth.user) return;

    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat?.peerPublicKey || !myPrivKey) return;

    get().notifyLocalTyping(false);

    const clientMsgId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const { dateKey, dateLabel } = formatDateKeyAndLabel(nowIso);

    const optimistic: MockMessage = {
      id: clientMsgId,
      clientMsgId,
      chatId: activeChatId,
      senderId: "me",
      senderName: "You",
      type: "text",
      text,
      timestamp: nowIso,
      timeLabel: formatClock(nowIso),
      dateKey,
      dateLabel,
      status: "pending",
      replyToId: replyingTo?.id || null,
      replyTo: replyingTo
        ? {
            messageId: replyingTo.id,
            senderName: replyingTo.senderId === "me" ? "You" : replyingTo.senderName,
            previewText: replyingTo.text || "Encrypted message",
            type: replyingTo.type,
          }
        : undefined,
    };

    // 1. Optimistic insert with `pending` clock state
    set((state) => ({
      replyingTo: null,
      messagesByChat: {
        ...state.messagesByChat,
        [activeChatId]: [...(state.messagesByChat[activeChatId] || []), optimistic],
      },
      chats: sortChats(
        state.chats.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                lastMessagePreview: text,
                lastMessageType: "text",
                lastMessageTime: formatClock(nowIso),
                lastMessageIso: nowIso,
                lastMessageOutgoing: true,
                lastMessageStatus: "pending",
              }
            : c
        )
      ),
    }));

    // 2. Encrypt client-side with ECDH -> HKDF -> AES-256-GCM + fresh 12-byte random nonce
    const { ciphertext, nonce } = await encryptDirectMessage(
      myPrivKey,
      chat.peerPublicKey,
      { text }
    );

    const wirePayload = {
      conversation_id: activeChatId,
      ciphertext,
      nonce,
      type: "text" as const,
      reply_to_id: replyingTo && !replyingTo.id.startsWith("cmsg-") ? replyingTo.id : null,
      client_msg_id: clientMsgId,
    };

    // 3. Send via WebSocket, or fall back to POST /messages REST if WS is reconnecting
    const sentOverWs = wsClientInstance?.send("message.send", wirePayload);
    if (!sentOverWs) {
      try {
        const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
          method: "POST",
          body: JSON.stringify(wirePayload),
        });
        set((state) => ({
          messagesByChat: {
            ...state.messagesByChat,
            [activeChatId]: (state.messagesByChat[activeChatId] || []).map((m) =>
              m.clientMsgId === clientMsgId
                ? { ...m, id: saved.id, status: saved.status }
                : m
            ),
          },
          chats: state.chats.map((c) =>
            c.id === activeChatId ? { ...c, lastMessageStatus: saved.status } : c
          ),
        }));
      } catch (err) {
        set((state) => ({
          sendError: err instanceof Error ? err.message : "Failed to send message.",
          messagesByChat: {
            ...state.messagesByChat,
            [activeChatId]: (state.messagesByChat[activeChatId] || []).filter(
              (m) => m.clientMsgId !== clientMsgId
            ),
          },
        }));
      }
    }
  },

  submitEditMessage: async (messageId: string, newText: string) => {
    const trimmed = newText.trim();
    const { activeChatId } = get();
    const auth = useAuthStore.getState();
    if (!trimmed || !activeChatId || !auth.user) return;

    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat?.peerPublicKey || !myPrivKey) return;

    const { ciphertext, nonce } = await encryptDirectMessage(
      myPrivKey,
      chat.peerPublicKey,
      { text: trimmed }
    );

    await auth.authedRequest<ApiEncryptedMessage>(`/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ ciphertext, nonce }),
    });

    set((state) => ({
      editingMessage: null,
      messagesByChat: {
        ...state.messagesByChat,
        [activeChatId]: (state.messagesByChat[activeChatId] || []).map((m) =>
          m.id === messageId ? { ...m, text: trimmed, edited: true } : m
        ),
      },
    }));
  },

  deleteMessage: async (messageId: string, scope: "me" | "everyone") => {
    const { activeChatId } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return;

    await auth.authedRequest<ApiEncryptedMessage>(
      `/messages/${messageId}?scope=${scope}`,
      { method: "DELETE" }
    );

    set((state) => {
      const list = state.messagesByChat[activeChatId] || [];
      const nextList =
        scope === "me"
          ? list.filter((m) => m.id !== messageId)
          : list.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    text: "This message was deleted",
                    type: "text" as const,
                    deletedForEveryone: true,
                    image: undefined,
                    file: undefined,
                    voice: undefined,
                    location: undefined,
                  }
                : m
            );

      const lastVisible =
        [...nextList].reverse().find((m) => m.type !== "system") || null;

      return {
        messagesByChat: {
          ...state.messagesByChat,
          [activeChatId]: nextList,
        },
        chats: state.chats.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                lastMessagePreview: previewTextFromMessage(lastVisible),
              }
            : c
        ),
      };
    });
  },

  sendVoiceMessage: async (durationSeconds: number) => {
    const { activeChatId } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return;
    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat?.peerPublicKey || !myPrivKey) return;

    const dur = Math.max(1, durationSeconds);
    const clientMsgId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const { dateKey, dateLabel } = formatDateKeyAndLabel(nowIso);

    const optimistic: MockMessage = {
      id: clientMsgId,
      clientMsgId,
      chatId: activeChatId,
      senderId: "me",
      senderName: "You",
      type: "voice",
      text: "Voice message",
      timestamp: nowIso,
      timeLabel: formatClock(nowIso),
      dateKey,
      dateLabel,
      status: "pending",
      voice: {
        durationSeconds: dur,
        waveform: deterministicWaveform(clientMsgId),
      },
    };

    set((state) => ({
      messagesByChat: {
        ...state.messagesByChat,
        [activeChatId]: [...(state.messagesByChat[activeChatId] || []), optimistic],
      },
      chats: sortChats(
        state.chats.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                lastMessagePreview: "Voice message",
                lastMessageType: "voice",
                lastMessageTime: formatClock(nowIso),
                lastMessageIso: nowIso,
                lastMessageOutgoing: true,
                lastMessageStatus: "pending",
              }
            : c
        )
      ),
    }));

    const { ciphertext, nonce } = await encryptDirectMessage(
      myPrivKey,
      chat.peerPublicKey,
      { text: "Voice message", durationSec: dur }
    );

    const wirePayload = {
      conversation_id: activeChatId,
      ciphertext,
      nonce,
      type: "voice" as const,
      client_msg_id: clientMsgId,
    };

    if (!wsClientInstance?.send("message.send", wirePayload)) {
      const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
        method: "POST",
        body: JSON.stringify(wirePayload),
      });
      set((state) => ({
        messagesByChat: {
          ...state.messagesByChat,
          [activeChatId]: (state.messagesByChat[activeChatId] || []).map((m) =>
            m.clientMsgId === clientMsgId ? { ...m, id: saved.id, status: saved.status } : m
          ),
        },
      }));
    }
  },

  sendMockAttachItem: async (kind) => {
    const { activeChatId } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return;
    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat?.peerPublicKey || !myPrivKey) return;

    if (kind === "location") {
      const { ciphertext, nonce } = await encryptDirectMessage(
        myPrivKey,
        chat.peerPublicKey,
        {
          text: "Shared Location",
          address: "Jaipur, Rajasthan",
          latitude: 26.9124,
          longitude: 75.7873,
        }
      );
      await auth.authedRequest("/messages", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: activeChatId,
          ciphertext,
          nonce,
          type: "location",
        }),
      });
      return;
    }

    if (kind === "document") {
      const { ciphertext, nonce } = await encryptDirectMessage(
        myPrivKey,
        chat.peerPublicKey,
        {
          text: "RelayChat-Protocol-Notes.pdf",
          fileName: "RelayChat-Protocol-Notes.pdf",
          fileSize: "420 KB",
        }
      );
      await auth.authedRequest("/messages", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: activeChatId,
          ciphertext,
          nonce,
          type: "document",
        }),
      });
      return;
    }

    await get().sendTextMessage(
      kind === "contact"
        ? "👤 Shared E2EE Contact Card"
        : kind === "audio"
          ? "🎵 Shared Encrypted Audio Clip"
          : "📷 Shared Encrypted Snapshot"
    );
  },
}));
