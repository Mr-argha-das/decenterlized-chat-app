"use client";

import { create } from "zustand";
import {
  encryptAndUploadAttachment,
} from "@/lib/api/attachments";
import {
  ApiBlock,
  ApiContact,
  ApiConversation,
  ApiCursorMessages,
  ApiEncryptedMessage,
  ApiGroupInviteInfo,
  ApiGroupInvitePreview,
  ApiGroupSenderKey,
  ApiGroupSummary,
  ApiReceiptEntry,
  ApiStarredMessageItem,
  PeerProfileView,
  UserProfile,
} from "@/lib/api/client";
import {
  DecryptedMessagePayload,
  bytesToBase64,
  decryptDirectMessage,
  encryptDirectMessage,
} from "@/lib/crypto/e2ee";
import {
  buildSenderKeyEnvelopesForRoster,
  decryptGroupMessageWithSenderKey,
  encryptGroupMessageWithSenderKey,
  generateGroupSenderKey,
  unwrapSenderKeyFromMember,
} from "@/lib/crypto/groupSenderKeys";
import { loadIdentityKeyFromIndexedDB } from "@/lib/crypto/keystore";
import {
  decryptBytesWithFileKey,
  formatHumanBytes,
} from "@/lib/crypto/mediaEncryption";
import {
  RealtimeConnectionState,
  RealtimePacket,
  RealtimeWebSocketClient,
} from "@/lib/ws/realtimeClient";
import {
  ActiveUploadTask,
  EncryptedBlobRef,
  MOCK_IMAGES,
  MockChat,
  MockMessage,
  MockMessageType,
} from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";

export type SidebarFilter = "all" | "unread" | "groups" | "archived";

export interface IncomingCallSignal {
  callId: string;
  fromUserId: string;
  fromGlobalId: string;
  fromName: string;
  callType: "voice" | "video";
  conversationId?: string | null;
  sdp?: unknown;
  status: "ringing" | "connected" | "ended";
}

export interface DecryptedStarredEntry {
  starredAt: string;
  chatId: string;
  chatName: string;
  message: MockMessage;
}

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

function makeE2eeSystemBanner(
  chatId: string,
  createdIso?: string,
  isGroup = false,
  keyVersion = 1
): MockMessage {
  const ts = createdIso || new Date().toISOString();
  const { dateKey, dateLabel } = formatDateKeyAndLabel(ts);
  return {
    id: `sys-e2ee-${chatId}`,
    chatId,
    senderId: "system",
    senderName: "System",
    type: "system",
    text: isGroup
      ? `Group messages are end-to-end encrypted with Sender Keys (v${keyVersion}) wrapped via pairwise ECDH P-256 + AES-256-GCM. Keys rotate automatically whenever membership changes.`
      : "Messages are end-to-end encrypted with ECDH P-256 + HKDF-SHA256 + AES-256-GCM. Not even this RelayChat node can read them.",
    timestamp: ts,
    timeLabel: formatClock(ts),
    dateKey,
    dateLabel,
  };
}

function mapApiTypeToUi(apiType: string): MockMessageType {
  if (apiType === "image" || apiType === "video") return "image";
  if (apiType === "voice" || apiType === "audio") return "voice";
  if (apiType === "location" || apiType === "live_location") return "location";
  if (apiType === "document" || apiType === "file") return "file";
  return "text";
}

function formatRemainingLiveLabel(expiresIso?: string | null, stopped?: boolean): string {
  if (stopped) return "Live location ended";
  if (!expiresIso) return "Live location";
  const diffMs = new Date(expiresIso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "Live location ended";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `Live • ${mins}m left`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `Live • ${hrs}h ${rem}m left` : `Live • ${hrs}h left`;
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
const uploadAbortControllers = new Map<string, AbortController>();
const liveLocationHandles = new Map<
  string,
  {
    intervalId: ReturnType<typeof setInterval>;
    expiryTimeoutId: ReturnType<typeof setTimeout>;
    geoWatchId: number | null;
    latestCoords: { latitude: number; longitude: number; accuracy?: number };
    label: string;
    address: string;
    durationMinutes: number;
    expiresAt: string;
    chatId: string;
  }
>();
let localTypingStopTimer: ReturnType<typeof setTimeout> | null = null;
let lastLocalTypingSentAt = 0;

interface PaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  initialized: boolean;
}

export interface ActiveLiveShareInfo {
  messageId: string;
  chatId: string;
  label: string;
  expiresAt: string;
  durationMinutes: number;
}

export interface MentionAlertItem {
  id: string;
  groupId: string;
  groupName: string;
  messageId: string;
  senderName: string;
  createdAt: string;
}

interface ChatStoreState {
  chats: MockChat[];
  messagesByChat: Record<string, MockMessage[]>;
  paginationByChat: Record<string, PaginationMeta>;
  activeUploads: Record<string, ActiveUploadTask>;
  activeLiveShares: Record<string, ActiveLiveShareInfo>;
  mentionAlerts: MentionAlertItem[];
  readByModalMessage: MockMessage | null;
  forwardModalMessage: MockMessage | null;
  statusFeedVersion: number;
  incomingCall: IncomingCallSignal | null;
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
  dismissMentionAlert: (id: string) => void;
  setReadByModalMessage: (msg: MockMessage | null) => void;
  fetchMessageReceipts: (messageId: string) => Promise<{
    read_by: ApiReceiptEntry[];
    delivered_to: ApiReceiptEntry[];
  } | null>;

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

  // Phase 7: Group Chats + Sender Keys E2EE
  createGroup: (params: {
    name: string;
    description?: string;
    memberIds: string[];
    onlyAdminsCanSend?: boolean;
    onlyAdminsCanEditInfo?: boolean;
    iconFile?: File | null;
  }) => Promise<string | null>;
  refreshGroupDetail: (groupId: string) => Promise<ApiGroupSummary | null>;
  updateGroupInfoAndSettings: (
    groupId: string,
    patch: {
      name?: string;
      description?: string;
      only_admins_can_send?: boolean;
      only_admins_can_edit_info?: boolean;
    }
  ) => Promise<ApiGroupSummary>;
  uploadGroupIcon: (groupId: string, file: File) => Promise<ApiGroupSummary>;
  addGroupMembers: (groupId: string, memberIds: string[]) => Promise<ApiGroupSummary>;
  removeGroupMember: (groupId: string, targetUserId: string) => Promise<ApiGroupSummary>;
  setGroupMemberRole: (
    groupId: string,
    targetUserId: string,
    role: "admin" | "member"
  ) => Promise<ApiGroupSummary>;
  leaveGroup: (groupId: string) => Promise<void>;
  revokeGroupInvite: (groupId: string) => Promise<string>;
  previewGroupInvite: (inviteCode: string) => Promise<ApiGroupInvitePreview>;
  joinGroupByInviteCode: (inviteCode: string) => Promise<string | null>;

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
  toggleArchiveChat: (chatId: string) => Promise<void>;
  setDisappearingTimer: (chatId: string, seconds: number) => Promise<void>;
  toggleStarMessage: (chatId: string, messageId: string) => Promise<void>;
  fetchStarredMessages: () => Promise<DecryptedStarredEntry[]>;
  setForwardModalMessage: (msg: MockMessage | null) => void;
  forwardMessageToChat: (msg: MockMessage, targetChatId: string) => Promise<void>;
  sendStatusReplyMessage: (params: {
    authorUserId: string;
    authorGlobalId: string;
    statusId: string;
    mediaType: string;
    previewText: string;
    backgroundStyle?: string | null;
    replyText: string;
  }) => Promise<string | null>;
  exportChatHistory: (chatId: string, format: "txt" | "json") => void;
  sendCallSignal: (
    event:
      | "call.offer"
      | "call.answer"
      | "call.ice_candidate"
      | "call.hangup"
      | "call.decline",
    data: Record<string, unknown>
  ) => void;
  clearIncomingCall: () => void;
  notifyLocalTyping: (isTyping: boolean) => void;

  sendTextMessage: (text: string, explicitMentionIds?: string[]) => Promise<void>;
  submitEditMessage: (messageId: string, newText: string) => Promise<void>;
  deleteMessage: (messageId: string, scope: "me" | "everyone") => Promise<void>;
  sendAttachmentFile: (
    file: Blob | File,
    options?: {
      fileName?: string;
      caption?: string;
      forceType?: "image" | "video" | "audio" | "voice" | "document";
      durationSec?: number;
      waveform?: number[];
    }
  ) => Promise<void>;
  cancelUpload: (uploadId: string) => void;
  sendRecordedVoiceMessage: (
    audioBlob: Blob,
    durationSeconds: number,
    waveform: number[]
  ) => Promise<void>;
  sendVoiceMessage: (durationSeconds: number) => Promise<void>;
  sendStaticLocation: (loc: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label: string;
    address: string;
  }) => Promise<void>;
  startLiveLocationShare: (loc: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label: string;
    address: string;
    durationMinutes: 15 | 60 | 480;
  }) => Promise<string | null>;
  pushLiveLocationUpdate: (
    messageId: string,
    coords: { latitude: number; longitude: number; accuracy?: number }
  ) => Promise<void>;
  stopLiveLocationShare: (messageId: string) => Promise<void>;
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

const senderKeyMemoryCache = new Map<string, string>();
const inFlightSenderKeyDistributions = new Map<string, Promise<{ senderKeyB64: string; keyVersion: number }>>();

function senderKeySlotId(
  myUserId: string,
  groupId: string,
  senderId: string,
  keyVersion: number
): string {
  return `${myUserId}|${groupId}|${senderId}|v${keyVersion}`;
}

function readCachedSenderKey(
  myUserId: string,
  groupId: string,
  senderId: string,
  keyVersion: number
): string | null {
  const slot = senderKeySlotId(myUserId, groupId, senderId, keyVersion);
  const mem = senderKeyMemoryCache.get(slot);
  if (mem) return mem;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`relaychat-sk:${slot}`);
    if (raw) {
      senderKeyMemoryCache.set(slot, raw);
      return raw;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeCachedSenderKey(
  myUserId: string,
  groupId: string,
  senderId: string,
  keyVersion: number,
  senderKeyB64: string
): void {
  const slot = senderKeySlotId(myUserId, groupId, senderId, keyVersion);
  senderKeyMemoryCache.set(slot, senderKeyB64);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`relaychat-sk:${slot}`, senderKeyB64);
  } catch {
    // ignore
  }
}

async function resolveGroupSenderKeyForDecryption(params: {
  groupId: string;
  senderId: string;
  keyVersion: number;
  myUserId: string;
  myPrivateKeyJwk: JsonWebKey;
}): Promise<string | null> {
  const cached = readCachedSenderKey(
    params.myUserId,
    params.groupId,
    params.senderId,
    params.keyVersion
  );
  if (cached) return cached;

  try {
    const rows = await useAuthStore
      .getState()
      .authedRequest<ApiGroupSenderKey[]>(
        `/groups/${params.groupId}/keys?key_version=${params.keyVersion}&sender_id=${encodeURIComponent(
          params.senderId
        )}`
      );
    const entry = rows.find(
      (r) => r.sender_id === params.senderId && r.key_version === params.keyVersion
    );
    if (!entry) return null;

    const unwrapped = await unwrapSenderKeyFromMember({
      groupId: params.groupId,
      keyVersion: params.keyVersion,
      recipientPrivateKeyJwk: params.myPrivateKeyJwk,
      senderPublicKey: entry.sender_public_key,
      wrappedKeyB64: entry.wrapped_key,
      nonceB64: entry.nonce,
    });
    writeCachedSenderKey(
      params.myUserId,
      params.groupId,
      params.senderId,
      params.keyVersion,
      unwrapped
    );
    return unwrapped;
  } catch {
    return null;
  }
}

async function ensureMyGroupSenderKey(params: {
  groupId: string;
  myUserId: string;
  myPrivateKeyJwk: JsonWebKey;
  forceRefreshGroup?: boolean;
}): Promise<{ senderKeyB64: string; keyVersion: number }> {
  const lockKey = `${params.myUserId}|${params.groupId}`;
  const existingFlight = inFlightSenderKeyDistributions.get(lockKey);
  if (existingFlight) return existingFlight;

  const task = (async () => {
    const auth = useAuthStore.getState();
    let groupSummary: ApiGroupSummary | null = null;
    if (!params.forceRefreshGroup) {
      const localChat = useChatStore
        .getState()
        .chats.find((c) => c.id === params.groupId);
      if (
        localChat?.isGroup &&
        localChat.keyVersion &&
        localChat.groupMembers &&
        localChat.groupMembers.length > 0
      ) {
        const cached = readCachedSenderKey(
          params.myUserId,
          params.groupId,
          params.myUserId,
          localChat.keyVersion
        );
        if (cached) {
          return { senderKeyB64: cached, keyVersion: localChat.keyVersion };
        }
      }
    }

    groupSummary = await auth.authedRequest<ApiGroupSummary>(
      `/groups/${params.groupId}`
    );
    const kv = groupSummary.key_version;

    // 1. Check local cache for this exact keyVersion
    const localCached = readCachedSenderKey(
      params.myUserId,
      params.groupId,
      params.myUserId,
      kv
    );
    if (localCached) {
      return { senderKeyB64: localCached, keyVersion: kv };
    }

    // 2. Check if another browser tab/device of ours already uploaded our Sender Key for kv
    const serverExisting = await resolveGroupSenderKeyForDecryption({
      groupId: params.groupId,
      senderId: params.myUserId,
      keyVersion: kv,
      myUserId: params.myUserId,
      myPrivateKeyJwk: params.myPrivateKeyJwk,
    });
    if (serverExisting) {
      return { senderKeyB64: serverExisting, keyVersion: kv };
    }

    // 3. Generate a brand-new 256-bit Sender Key and wrap it via pairwise ECDH for every active member
    const freshKey = await generateGroupSenderKey();
    const envelopes = await buildSenderKeyEnvelopesForRoster({
      groupId: params.groupId,
      keyVersion: kv,
      senderPrivateKeyJwk: params.myPrivateKeyJwk,
      senderKeyB64: freshKey,
      members: groupSummary.members.map((m) => ({
        userId: m.user_id,
        publicKey: m.public_key,
      })),
    });

    await auth.authedRequest(`/groups/${params.groupId}/keys`, {
      method: "POST",
      body: JSON.stringify({
        key_version: kv,
        envelopes,
      }),
    });

    writeCachedSenderKey(params.myUserId, params.groupId, params.myUserId, kv, freshKey);
    return { senderKeyB64: freshKey, keyVersion: kv };
  })();

  inFlightSenderKeyDistributions.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlightSenderKeyDistributions.delete(lockKey);
  }
}

async function encryptPayloadForChat(params: {
  chat: MockChat;
  myUserId: string;
  myPrivateKeyJwk: JsonWebKey;
  payload: string | Omit<DecryptedMessagePayload, "v">;
  forceRefreshGroup?: boolean;
}): Promise<{ ciphertext: string; nonce: string; senderKeyVersion?: number }> {
  if (!params.chat.isGroup) {
    if (!params.chat.peerPublicKey) {
      throw new Error("Missing peer E2EE public key.");
    }
    const enc = await encryptDirectMessage(
      params.myPrivateKeyJwk,
      params.chat.peerPublicKey,
      params.payload
    );
    return { ciphertext: enc.ciphertext, nonce: enc.nonce };
  }

  const { senderKeyB64, keyVersion } = await ensureMyGroupSenderKey({
    groupId: params.chat.id,
    myUserId: params.myUserId,
    myPrivateKeyJwk: params.myPrivateKeyJwk,
    forceRefreshGroup: params.forceRefreshGroup,
  });

  const enc = await encryptGroupMessageWithSenderKey({
    groupId: params.chat.id,
    senderId: params.myUserId,
    keyVersion,
    senderKeyB64,
    payload: params.payload,
  });
  return {
    ciphertext: enc.ciphertext,
    nonce: enc.nonce,
    senderKeyVersion: keyVersion,
  };
}

export function extractMentionedUserIds(
  text: string,
  chat: MockChat | undefined,
  myUserId: string,
  explicitIds?: string[]
): string[] {
  if (!chat?.isGroup || !chat.groupMembers) return [];
  const found = new Set<string>(explicitIds || []);
  const matches = text.match(/@([a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9.-]+)?)/g) || [];
  for (const token of matches) {
    const handle = token.slice(1).toLowerCase();
    for (const member of chat.groupMembers) {
      if (
        member.username.toLowerCase() === handle ||
        member.global_id.toLowerCase() === handle
      ) {
        if (member.user_id !== myUserId) {
          found.add(member.user_id);
        }
      }
    }
  }
  return Array.from(found);
}

async function decryptApiMessageToUi(
  raw: ApiEncryptedMessage,
  myUserId: string,
  myPrivateKeyJwk: JsonWebKey | null,
  peerName: string,
  peerPublicKey: string | undefined,
  peerColor: string,
  isGroup = false
): Promise<MockMessage> {
  const outgoing = raw.sender_id === myUserId;
  const { dateKey, dateLabel } = formatDateKeyAndLabel(raw.created_at);
  const timeLabel = formatClock(raw.created_at);
  const effectiveSenderName = outgoing
    ? "You"
    : raw.sender_display_name || (isGroup ? raw.sender_global_id : peerName);
  const effectiveSenderColor =
    raw.sender_color || (isGroup ? colorForIdentifier(raw.sender_id) : peerColor);

  if (raw.type === "system") {
    return {
      id: raw.id,
      clientMsgId: raw.client_msg_id || undefined,
      chatId: raw.conversation_id,
      senderId: "system",
      senderName: "System",
      type: "system",
      text: raw.system_event?.text || "Group updated",
      timestamp: raw.created_at,
      timeLabel,
      dateKey,
      dateLabel,
    };
  }

  if (raw.deleted_for_everyone) {
    return {
      id: raw.id,
      clientMsgId: raw.client_msg_id || undefined,
      chatId: raw.conversation_id,
      senderId: outgoing ? "me" : raw.sender_id,
      senderName: effectiveSenderName,
      senderColor: effectiveSenderColor,
      type: "text",
      text: "This message was deleted",
      timestamp: raw.created_at,
      timeLabel,
      dateKey,
      dateLabel,
      status: outgoing ? raw.status : undefined,
      deletedForEveryone: true,
      replyToId: raw.reply_to_id,
      readBy: raw.read_by || [],
      deliveredTo: raw.delivered_to || [],
    };
  }

  let decrypted: DecryptedMessagePayload | null = null;
  let decryptionError = false;

  if (isGroup) {
    const keyVersion = raw.sender_key_version || 1;
    if (myPrivateKeyJwk) {
      const senderKeyB64 = await resolveGroupSenderKeyForDecryption({
        groupId: raw.conversation_id,
        senderId: raw.sender_id,
        keyVersion,
        myUserId,
        myPrivateKeyJwk,
      });
      if (senderKeyB64) {
        try {
          decrypted = await decryptGroupMessageWithSenderKey({
            groupId: raw.conversation_id,
            senderId: raw.sender_id,
            keyVersion,
            senderKeyB64,
            ciphertextB64: raw.ciphertext,
            nonceB64: raw.nonce,
          });
        } catch {
          decryptionError = true;
        }
      } else {
        decryptionError = true;
      }
    } else {
      decryptionError = true;
    }
  } else if (myPrivateKeyJwk && peerPublicKey) {
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
    ? isGroup
      ? `🔒 Waiting for group Sender Key (v${raw.sender_key_version || 1})`
      : "🔒 Waiting for matching E2EE key on this device"
    : decrypted?.text || "";

  const msg: MockMessage = {
    id: raw.id,
    clientMsgId: raw.client_msg_id || undefined,
    chatId: raw.conversation_id,
    senderId: outgoing ? "me" : raw.sender_id,
    senderName: effectiveSenderName,
    senderColor: effectiveSenderColor,
    type: decryptionError ? "text" : uiType,
    text: baseText,
    timestamp: raw.created_at,
    timeLabel,
    dateKey,
    dateLabel,
    status: outgoing ? raw.status : undefined,
    senderKeyVersion: raw.sender_key_version || undefined,
    mentions: raw.mentions || [],
    readBy: raw.read_by || [],
    deliveredTo: raw.delivered_to || [],
    isStarred: !!raw.is_starred,
    isForwarded: !!decrypted?.forwarded,
    expiresAt: raw.expires_at || null,
    deliveredAt: raw.delivered_at || null,
    readAt: raw.read_at || null,
    statusReply: decrypted?.statusReply,
    edited: !!raw.edited_at,
    decryptionError,
    replyToId: raw.reply_to_id,
  };

  if (!decryptionError && decrypted) {
    const encryptedRef: EncryptedBlobRef | undefined =
      decrypted.attachmentId && decrypted.fileKeyB64 && decrypted.baseNonceB64
        ? {
            attachmentId: decrypted.attachmentId,
            fileKeyB64: decrypted.fileKeyB64,
            baseNonceB64: decrypted.baseNonceB64,
            chunkSize: decrypted.chunkSize || 1_048_576,
            chunkCount: decrypted.chunkCount || 1,
            encryptedChunkLengths: decrypted.encryptedChunkLengths,
            totalSizeBytes: decrypted.totalSizeBytes || 0,
            mimeType: decrypted.mimeType || "application/octet-stream",
            downloadUrl: decrypted.downloadUrl,
          }
        : undefined;

    let thumbDataUrl: string | undefined;
    if (decrypted.thumbCiphertext && decrypted.thumbNonce && decrypted.fileKeyB64) {
      try {
        const thumbBytes = await decryptBytesWithFileKey(
          decrypted.fileKeyB64,
          decrypted.thumbCiphertext,
          decrypted.thumbNonce
        );
        thumbDataUrl = `data:image/jpeg;base64,${bytesToBase64(thumbBytes)}`;
      } catch {
        thumbDataUrl = undefined;
      }
    }

    if (uiType === "voice") {
      msg.voice = {
        durationSeconds: decrypted.durationSec || 5,
        waveform:
          decrypted.waveform && decrypted.waveform.length > 0
            ? decrypted.waveform
            : deterministicWaveform(raw.id),
        mimeType: decrypted.mimeType,
        encryptedRef,
      };
    } else if (uiType === "file") {
      const fname = decrypted.fileName || baseText || "encrypted-document.pdf";
      const ext =
        decrypted.extension ||
        (fname.includes(".") ? fname.split(".").pop() || "FILE" : "FILE");
      msg.file = {
        fileName: fname,
        fileSize:
          decrypted.fileSize ||
          (decrypted.totalSizeBytes ? formatHumanBytes(decrypted.totalSizeBytes) : "240 KB"),
        extension: ext.toUpperCase(),
        mimeType: decrypted.mimeType,
        encryptedRef,
      };
    } else if (uiType === "location") {
      const effectiveExpiresIso = raw.expires_at || decrypted.expiresAt;
      const isLive = raw.type === "live_location" || !!decrypted.isLive;
      const isStoppedOrExpired =
        !!decrypted.liveStopped ||
        (effectiveExpiresIso
          ? Date.now() >= new Date(effectiveExpiresIso).getTime()
          : false);

      msg.location = {
        label: decrypted.label || baseText || "Pinned Location",
        address: decrypted.address || "End-to-end encrypted coordinates",
        latitude: decrypted.latitude ?? 26.9124,
        longitude: decrypted.longitude ?? 75.7873,
        accuracy: decrypted.accuracy,
        isLive,
        liveStopped: isLive && isStoppedOrExpired,
        durationMinutes: decrypted.durationMinutes,
        expiresAt: effectiveExpiresIso || undefined,
        updatedAt: decrypted.updatedAt || raw.edited_at || raw.created_at,
        liveExpiresLabel: isLive
          ? formatRemainingLiveLabel(effectiveExpiresIso, isStoppedOrExpired)
          : undefined,
      };
    } else if (uiType === "image") {
      const isVideo =
        raw.type === "video" || (decrypted.mimeType || "").startsWith("video/");
      msg.image = {
        dataUrl: encryptedRef ? thumbDataUrl || "" : MOCK_IMAGES.jaipurSunset,
        thumbDataUrl,
        caption: baseText,
        width: decrypted.width || 800,
        height: decrypted.height || 520,
        fileName: decrypted.fileName || (isVideo ? "encrypted-video.mp4" : "encrypted-photo.jpg"),
        fileSize: decrypted.fileSize,
        mimeType: decrypted.mimeType,
        isVideo,
        durationSeconds: decrypted.durationSec,
        encryptedRef,
      };
    }
  }

  return msg;
}

function previewTextFromMessage(msg: MockMessage | null, isGroup = false): string {
  if (!msg) return "Tap to start end-to-end encrypted chat";
  if (msg.type === "system") return msg.text || "Group updated";
  const prefix =
    isGroup && msg.senderId !== "me" && msg.senderName
      ? `${msg.senderName.split(" ")[0]}: `
      : "";
  if (msg.deletedForEveryone) return `${prefix}🚫 This message was deleted`;
  if (msg.type === "voice") return `${prefix}🎤 Voice message`;
  if (msg.type === "file") return `${prefix}📄 ${msg.file?.fileName || "Document"}`;
  if (msg.type === "location") {
    return msg.location?.isLive
      ? `${prefix}📍 ${msg.location.liveStopped ? "Live location ended" : "Live location"}`
      : `${prefix}📍 ${msg.location?.label || "Location"}`;
  }
  if (msg.type === "image") {
    if (msg.image?.isVideo) {
      return msg.image.caption ? `${prefix}🎬 ${msg.image.caption}` : `${prefix}🎬 Video`;
    }
    return msg.image?.caption ? `${prefix}📷 ${msg.image.caption}` : `${prefix}📷 Photo`;
  }
  return `${prefix}${msg.text || ""}`;
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
  activeUploads: {},
  activeLiveShares: {},
  mentionAlerts: [],
  readByModalMessage: null,
  forwardModalMessage: null,
  statusFeedVersion: 0,
  incomingCall: null,
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

  dismissMentionAlert: (id) =>
    set((state) => ({
      mentionAlerts: state.mentionAlerts.filter((a) => a.id !== id),
    })),

  setReadByModalMessage: (msg) => set({ readByModalMessage: msg }),

  fetchMessageReceipts: async (messageId: string) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;
    try {
      const res = await auth.authedRequest<{
        message_id: string;
        conversation_id: string;
        status: "sent" | "delivered" | "read";
        read_by: ApiReceiptEntry[];
        delivered_to: ApiReceiptEntry[];
      }>(`/messages/${messageId}/receipts`);

      set((state) => {
        const list = state.messagesByChat[res.conversation_id] || [];
        const updatedList = list.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: m.senderId === "me" ? res.status : m.status,
                readBy: res.read_by,
                deliveredTo: res.delivered_to,
              }
            : m
        );
        const modalMsg =
          state.readByModalMessage?.id === messageId
            ? {
                ...state.readByModalMessage,
                readBy: res.read_by,
                deliveredTo: res.delivered_to,
              }
            : state.readByModalMessage;
        return {
          readByModalMessage: modalMsg,
          messagesByChat: {
            ...state.messagesByChat,
            [res.conversation_id]: updatedList,
          },
        };
      });
      return { read_by: res.read_by, delivered_to: res.delivered_to };
    } catch {
      return null;
    }
  },

  teardownRealtimeSession: () => {
    if (wsClientInstance) {
      wsClientInstance.disconnect();
      wsClientInstance = null;
    }
    typingClearTimers.forEach((t) => clearTimeout(t));
    typingClearTimers.clear();
    uploadAbortControllers.forEach((c) => c.abort());
    uploadAbortControllers.clear();
    liveLocationHandles.forEach((h) => {
      clearInterval(h.intervalId);
      clearTimeout(h.expiryTimeoutId);
      if (h.geoWatchId !== null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(h.geoWatchId);
      }
    });
    liveLocationHandles.clear();
    set({
      chats: [],
      messagesByChat: {},
      paginationByChat: {},
      activeUploads: {},
      activeLiveShares: {},
      mentionAlerts: [],
      readByModalMessage: null,
      forwardModalMessage: null,
      incomingCall: null,
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
      const isGroup = conv.type === "group";
      const grp = conv.group || null;
      const peer = conv.peer;
      const peerId = isGroup ? conv.id : peer?.global_id || conv.id;
      const avatarColor = colorForIdentifier(peerId);
      const displayName = isGroup
        ? grp?.name || conv.name || "Encrypted Group"
        : peer?.display_name || conv.name || peerId;

      let lastMsgUi: MockMessage | null = null;
      if (conv.last_message) {
        lastMsgUi = await decryptApiMessageToUi(
          conv.last_message,
          auth.user.id,
          myPrivKey,
          displayName,
          peer?.public_key,
          avatarColor,
          isGroup
        );
      }

      const existing = get().chats.find((c) => c.id === conv.id);
      const lastIso = conv.last_message?.created_at || conv.last_message_at || conv.created_at;

      mapped.push({
        id: conv.id,
        name: displayName,
        rawDisplayName: isGroup ? displayName : peer?.raw_display_name || displayName,
        nickname: isGroup ? null : peer?.nickname || null,
        globalId: isGroup ? `group:${conv.id.slice(0, 8)}` : peer?.global_id || conv.id,
        peerUserId: peer?.id,
        peerPublicKey: peer?.public_key,
        avatarColor,
        avatarUrl: isGroup
          ? grp?.icon_url || conv.icon_url || undefined
          : peer?.avatar_url || conv.icon_url || undefined,
        about: isGroup ? grp?.description || conv.description || "" : peer?.about ?? "",
        description: isGroup ? grp?.description || conv.description || "" : undefined,
        isGroup,
        myRole: grp?.my_role,
        onlyAdminsCanSend: grp?.only_admins_can_send ?? false,
        onlyAdminsCanEditInfo: grp?.only_admins_can_edit_info ?? true,
        keyVersion: grp?.key_version ?? 1,
        inviteCode: grp?.invite_code ?? null,
        groupMembers: grp?.members,
        memberCount: grp?.member_count ?? grp?.members.length,
        memberNames: grp?.members.map((m) => m.display_name),
        hasUnreadMention:
          get().activeChatId === conv.id ? false : existing?.hasUnreadMention ?? false,
        isContact: peer?.is_contact ?? false,
        isBlockedByMe: peer?.is_blocked_by_me ?? false,
        hasBlockedMe: peer?.has_blocked_me ?? false,
        isOnline: isGroup
          ? Boolean(grp?.members.some((m) => m.user_id !== auth.user?.id && m.is_online))
          : peer?.is_online ?? false,
        lastSeen: isGroup ? "" : formatLastSeenLabel(peer?.last_seen_at),
        lastSeenIso: isGroup ? null : peer?.last_seen_at,
        isPinned: conv.is_pinned,
        isMuted: conv.is_muted,
        isArchived: conv.is_archived ?? false,
        disappearingTimerSeconds: conv.disappearing_timer_seconds ?? 0,
        isTyping: existing?.isTyping ?? false,
        typingUser: existing?.typingUser,
        unreadCount:
          get().activeChatId === conv.id ? 0 : conv.unread_count,
        lastMessagePreview: previewTextFromMessage(lastMsgUi, isGroup),
        lastMessageType: lastMsgUi?.type || "text",
        lastMessageTime: formatSidebarTimestamp(lastIso),
        lastMessageIso: lastIso,
        lastMessageOutgoing: lastMsgUi ? lastMsgUi.senderId === "me" : false,
        lastMessageStatus: lastMsgUi?.status,
      });
    }

    const activeId = get().activeChatId;
    const stillHasActive = !activeId || mapped.some((c) => c.id === activeId);

    set({
      chats: sortChats(mapped),
      activeChatId: stillHasActive ? activeId : null,
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

  createGroup: async ({
    name,
    description,
    memberIds,
    onlyAdminsCanSend,
    onlyAdminsCanEditInfo,
    iconFile,
  }) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;

    let grp = await auth.authedRequest<ApiGroupSummary>("/groups", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        description: description?.trim() || "",
        member_ids: memberIds,
        only_admins_can_send: Boolean(onlyAdminsCanSend),
        only_admins_can_edit_info:
          onlyAdminsCanEditInfo === undefined ? true : Boolean(onlyAdminsCanEditInfo),
      }),
    });

    if (iconFile) {
      try {
        grp = await get().uploadGroupIcon(grp.id, iconFile);
      } catch {
        // non-fatal icon failure
      }
    }

    // Immediately generate & distribute creator's v1 Sender Key wrapped for all members
    const myPrivKey = await getMyPrivateKeyJwk();
    if (myPrivKey && auth.user) {
      await ensureMyGroupSenderKey({
        groupId: grp.id,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        forceRefreshGroup: true,
      }).catch(() => undefined);
    }

    await get().refreshConversations();
    await get().selectChat(grp.id);
    return grp.id;
  },

  refreshGroupDetail: async (groupId: string) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;
    try {
      const grp = await auth.authedRequest<ApiGroupSummary>(`/groups/${groupId}`);
      set((state) => ({
        chats: state.chats.map((c) =>
          c.id === groupId
            ? {
                ...c,
                name: grp.name,
                rawDisplayName: grp.name,
                about: grp.description,
                description: grp.description,
                avatarUrl: grp.icon_url || undefined,
                myRole: grp.my_role,
                onlyAdminsCanSend: grp.only_admins_can_send,
                onlyAdminsCanEditInfo: grp.only_admins_can_edit_info,
                keyVersion: grp.key_version,
                inviteCode: grp.invite_code,
                groupMembers: grp.members,
                memberCount: grp.member_count,
                memberNames: grp.members.map((m) => m.display_name),
              }
            : c
        ),
      }));
      return grp;
    } catch {
      return null;
    }
  },

  updateGroupInfoAndSettings: async (groupId, patch) => {
    const auth = useAuthStore.getState();
    const grp = await auth.authedRequest<ApiGroupSummary>(`/groups/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await get().refreshConversations();
    return grp;
  },

  uploadGroupIcon: async (groupId, file) => {
    const auth = useAuthStore.getState();
    const formData = new FormData();
    formData.append("file", file);
    const grp = await auth.authedRequest<ApiGroupSummary>(`/groups/${groupId}/icon`, {
      method: "POST",
      body: formData,
    });
    await get().refreshConversations();
    return grp;
  },

  addGroupMembers: async (groupId, memberIds) => {
    const auth = useAuthStore.getState();
    const grp = await auth.authedRequest<ApiGroupSummary>(`/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ member_ids: memberIds }),
    });
    const myPrivKey = await getMyPrivateKeyJwk();
    if (myPrivKey && auth.user) {
      await ensureMyGroupSenderKey({
        groupId,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        forceRefreshGroup: true,
      }).catch(() => undefined);
    }
    await get().refreshConversations();
    return grp;
  },

  removeGroupMember: async (groupId, targetUserId) => {
    const auth = useAuthStore.getState();
    const grp = await auth.authedRequest<ApiGroupSummary>(
      `/groups/${groupId}/members/${targetUserId}`,
      { method: "DELETE" }
    );
    // Rotate our Sender Key immediately for the remaining roster ONLY
    const myPrivKey = await getMyPrivateKeyJwk();
    if (myPrivKey && auth.user) {
      await ensureMyGroupSenderKey({
        groupId,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        forceRefreshGroup: true,
      }).catch(() => undefined);
    }
    await get().refreshConversations();
    return grp;
  },

  setGroupMemberRole: async (groupId, targetUserId, role) => {
    const auth = useAuthStore.getState();
    const grp = await auth.authedRequest<ApiGroupSummary>(
      `/groups/${groupId}/members/${targetUserId}/role`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }
    );
    await get().refreshConversations();
    return grp;
  },

  leaveGroup: async (groupId) => {
    const auth = useAuthStore.getState();
    await auth.authedRequest(`/groups/${groupId}/leave`, {
      method: "POST",
    });
    if (get().activeChatId === groupId) {
      get().closeActiveChat();
    }
    await get().refreshConversations();
  },

  revokeGroupInvite: async (groupId) => {
    const auth = useAuthStore.getState();
    const info = await auth.authedRequest<ApiGroupInviteInfo>(
      `/groups/${groupId}/invite/revoke`,
      { method: "POST" }
    );
    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === groupId ? { ...c, inviteCode: info.invite_code } : c
      ),
    }));
    return info.invite_code;
  },

  previewGroupInvite: async (inviteCode) => {
    const auth = useAuthStore.getState();
    const clean = inviteCode.trim().split("/").pop()?.replace(/^\?join=/, "") || inviteCode.trim();
    return auth.authedRequest<ApiGroupInvitePreview>(
      `/groups/invite/${encodeURIComponent(clean)}`
    );
  },

  joinGroupByInviteCode: async (inviteCode) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;
    const clean =
      inviteCode
        .trim()
        .replace(/^.*[?&]join=/, "")
        .split("&")[0]
        .split("/")
        .pop() || inviteCode.trim();

    const grp = await auth.authedRequest<ApiGroupSummary>(
      `/groups/join/${encodeURIComponent(clean)}`,
      { method: "POST" }
    );

    const myPrivKey = await getMyPrivateKeyJwk();
    if (myPrivKey && auth.user) {
      await ensureMyGroupSenderKey({
        groupId: grp.id,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        forceRefreshGroup: true,
      }).catch(() => undefined);
    }

    await get().refreshConversations();
    await get().selectChat(grp.id);
    return grp.id;
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

        if (
          packet.event === "group.created" ||
          packet.event === "group.updated" ||
          packet.event === "group.member_added" ||
          packet.event === "group.member_removed" ||
          packet.event === "group.member_left"
        ) {
          await get().refreshConversations().catch(() => undefined);
          return;
        }

        if (packet.event === "conversation.updated") {
          const cid = String(packet.data?.conversation_id || "");
          const timerSec = Number(packet.data?.disappearing_timer_seconds ?? 0);
          if (cid) {
            set((state) => ({
              chats: state.chats.map((c) =>
                c.id === cid ? { ...c, disappearingTimerSeconds: timerSec } : c
              ),
            }));
          }
          return;
        }

        if (packet.event === "message.expired") {
          const cid = String(packet.data?.conversation_id || "");
          const expiredIds = new Set<string>(
            Array.isArray(packet.data?.message_ids)
              ? (packet.data.message_ids as string[])
              : []
          );
          if (cid && expiredIds.size > 0) {
            set((state) => ({
              messagesByChat: {
                ...state.messagesByChat,
                [cid]: (state.messagesByChat[cid] || []).filter(
                  (m) => !expiredIds.has(m.id)
                ),
              },
            }));
          }
          return;
        }

        if (
          packet.event === "status.new" ||
          packet.event === "status.viewed" ||
          packet.event === "status.deleted"
        ) {
          set((state) => ({ statusFeedVersion: state.statusFeedVersion + 1 }));
          return;
        }

        if (packet.event === "call.offer") {
          const callId = String(packet.data?.call_id || `call-${Date.now()}`);
          const fromUserId = String(packet.data?.from_user_id || packet.data?.caller_id || "");
          const fromGlobalId = String(
            packet.data?.from_global_id || packet.data?.caller_global_id || "Peer"
          );
          const fromName = String(
            packet.data?.from_display_name || fromGlobalId
          );
          const callType =
            packet.data?.call_type === "video" ? "video" : "voice";
          set({
            incomingCall: {
              callId,
              fromUserId,
              fromGlobalId,
              fromName,
              callType,
              conversationId: (packet.data?.conversation_id as string | undefined) || null,
              sdp: packet.data?.sdp,
              status: "ringing",
            },
          });
          return;
        }

        if (packet.event === "call.answer") {
          set((state) =>
            state.incomingCall
              ? { incomingCall: { ...state.incomingCall, status: "connected" } }
              : {}
          );
          return;
        }

        if (packet.event === "call.hangup" || packet.event === "call.decline") {
          set({ incomingCall: null });
          return;
        }

        if (packet.event === "group.key_rotated") {
          const groupId = String(packet.data.group_id || "");
          await get().refreshConversations().catch(() => undefined);
          const stillMember = get().chats.some((c) => c.id === groupId && c.isGroup);
          if (stillMember && groupId) {
            const myPrivKey = await getMyPrivateKeyJwk();
            if (myPrivKey) {
              ensureMyGroupSenderKey({
                groupId,
                myUserId: myUser.id,
                myPrivateKeyJwk: myPrivKey,
                forceRefreshGroup: true,
              }).catch(() => undefined);
            }
          }
          return;
        }

        if (packet.event === "group.sender_key_available") {
          const groupId = String(packet.data.group_id || "");
          const senderId = String(packet.data.sender_id || "");
          if (!groupId || !senderId) return;
          const existingList = get().messagesByChat[groupId] || [];
          const hasPending = existingList.some(
            (m) => m.decryptionError && m.senderId === senderId
          );
          if (hasPending) {
            // Re-fetch messages for this group so locked messages decrypt immediately
            try {
              const page = await currentAuth.authedRequest<ApiCursorMessages>(
                `/conversations/${groupId}/messages?limit=40`
              );
              const myPrivKey = await getMyPrivateKeyJwk();
              const chat = get().chats.find((c) => c.id === groupId);
              if (chat) {
                const reDecrypted: MockMessage[] = [];
                for (const item of page.items) {
                  reDecrypted.push(
                    await decryptApiMessageToUi(
                      item,
                      myUser.id,
                      myPrivKey,
                      chat.name,
                      chat.peerPublicKey,
                      chat.avatarColor,
                      true
                    )
                  );
                }
                const withBanner = page.has_more
                  ? reDecrypted
                  : [
                      makeE2eeSystemBanner(
                        groupId,
                        reDecrypted[0]?.timestamp,
                        true,
                        chat.keyVersion || 1
                      ),
                      ...reDecrypted,
                    ];
                set((state) => ({
                  messagesByChat: {
                    ...state.messagesByChat,
                    [groupId]: attachReplyReferences(withBanner),
                  },
                }));
              }
            } catch {
              // ignore
            }
          }
          return;
        }

        if (packet.event === "group.mention") {
          const groupId = String(packet.data.group_id || "");
          const groupName = String(packet.data.group_name || "Group");
          const messageId = String(packet.data.message_id || "");
          const senderName = String(
            packet.data.sender_display_name || packet.data.sender_global_id || "Someone"
          );
          const isActiveGroup =
            get().activeChatId === groupId &&
            (typeof document === "undefined" || document.visibilityState === "visible");

          if (!isActiveGroup) {
            const alertId = `mention-${messageId || Date.now()}`;
            set((state) => ({
              mentionAlerts: [
                ...state.mentionAlerts.filter((a) => a.id !== alertId).slice(-3),
                {
                  id: alertId,
                  groupId,
                  groupName,
                  messageId,
                  senderName,
                  createdAt: new Date().toISOString(),
                },
              ],
              chats: state.chats.map((c) =>
                c.id === groupId ? { ...c, hasUnreadMention: true } : c
              ),
            }));
          }
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
            chats: state.chats.map((c) => {
              if (c.isGroup && c.groupMembers) {
                const updatedMembers = c.groupMembers.map((m) =>
                  m.user_id === peerUserId ? { ...m, is_online: isOnline } : m
                );
                return {
                  ...c,
                  groupMembers: updatedMembers,
                  isOnline: updatedMembers.some(
                    (m) => m.user_id !== myUser.id && m.is_online
                  ),
                };
              }
              return c.peerUserId === peerUserId
                ? {
                    ...c,
                    isOnline,
                    lastSeenIso,
                    lastSeen: formatLastSeenLabel(lastSeenIso),
                  }
                : c;
            }),
          }));
          return;
        }

        if (packet.event === "typing.start" || packet.event === "typing.stop") {
          const convId = String(packet.data.conversation_id || "");
          const isStart = packet.event === "typing.start";
          const typingDisplayName =
            typeof packet.data.display_name === "string"
              ? packet.data.display_name
              : undefined;
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
                  c.id === convId ? { ...c, isTyping: false, typingUser: undefined } : c
                ),
              }));
            }, 4500);
            typingClearTimers.set(convId, timer);
          }
          set((state) => ({
            chats: state.chats.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    isTyping: isStart,
                    typingUser: isStart ? typingDisplayName : undefined,
                  }
                : c
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
          const readBy = Array.isArray(packet.data.read_by)
            ? (packet.data.read_by as ApiReceiptEntry[])
            : undefined;
          const deliveredTo = Array.isArray(packet.data.delivered_to)
            ? (packet.data.delivered_to as ApiReceiptEntry[])
            : undefined;

          set((state) => {
            const list = state.messagesByChat[convId] || [];
            const updatedList = attachReplyReferences(
              list.map((m) => {
                if (m.id === msgId || (clientMsgId && m.clientMsgId === clientMsgId)) {
                  return {
                    ...m,
                    id: msgId || m.id,
                    status: m.senderId === "me" ? nextStatus : m.status,
                    readBy: readBy ?? m.readBy,
                    deliveredTo: deliveredTo ?? m.deliveredTo,
                  };
                }
                return m;
              })
            );

            const modalMsg =
              state.readByModalMessage &&
              (state.readByModalMessage.id === msgId ||
                (clientMsgId && state.readByModalMessage.clientMsgId === clientMsgId))
                ? {
                    ...state.readByModalMessage,
                    readBy: readBy ?? state.readByModalMessage.readBy,
                    deliveredTo: deliveredTo ?? state.readByModalMessage.deliveredTo,
                  }
                : state.readByModalMessage;

            return {
              readByModalMessage: modalMsg,
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
          packet.event === "message.deleted" ||
          packet.event === "location.live_updated" ||
          packet.event === "location.live_stopped"
        ) {
          const rawMsg = packet.data as unknown as ApiEncryptedMessage & {
            delete_scope?: string;
          };
          const convId = rawMsg.conversation_id;

          // Ensure conversation exists in local sidebar (e.g. first message from a new peer or group)
          let targetChat = get().chats.find((c) => c.id === convId);
          if (!targetChat) {
            await get().refreshConversations();
            targetChat = get().chats.find((c) => c.id === convId);
          }
          if (!targetChat) return;

          // If a system message indicates group membership or info changed, refresh group details silently
          if (rawMsg.type === "system" && targetChat.isGroup) {
            get().refreshGroupDetail(convId).catch(() => undefined);
          }

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
                        lastMessagePreview: previewTextFromMessage(
                          lastVisible,
                          targetChat.isGroup
                        ),
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
            targetChat.avatarColor,
            targetChat.isGroup
          );

          const isIncoming = rawMsg.sender_id !== myUser.id && rawMsg.type !== "system";
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
                typingUser: isIncoming ? undefined : c.typingUser,
                unreadCount: nextUnread,
                lastMessagePreview: previewTextFromMessage(uiMsg, c.isGroup),
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
                    body: previewTextFromMessage(uiMsg, targetChat.isGroup),
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
      mentionAlerts: state.mentionAlerts.filter((a) => a.groupId !== chatId),
      chats: state.chats.map((c) =>
        c.id === chatId ? { ...c, unreadCount: 0, hasUnreadMention: false } : c
      ),
    }));

    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat || !auth.user) return;

    // Warm our own Sender Key in the background when opening a group
    if (chat.isGroup) {
      get().refreshGroupDetail(chatId).catch(() => undefined);
      getMyPrivateKeyJwk().then((priv) => {
        if (priv && auth.user) {
          ensureMyGroupSenderKey({
            groupId: chatId,
            myUserId: auth.user.id,
            myPrivateKeyJwk: priv,
          }).catch(() => undefined);
        }
      });
    }

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
              chat.avatarColor,
              chat.isGroup
            )
          );
        }

        const withBanner = page.has_more
          ? decryptedItems
          : [
              makeE2eeSystemBanner(
                chatId,
                decryptedItems[0]?.timestamp,
                chat.isGroup,
                chat.keyVersion || 1
              ),
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
            chat.avatarColor,
            chat.isGroup
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
          : [
              makeE2eeSystemBanner(
                chatId,
                combined[0]?.timestamp,
                chat.isGroup,
                chat.keyVersion || 1
              ),
              ...combined,
            ];

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

  toggleArchiveChat: async (chatId: string) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const nextArchived = !chat.isArchived;
    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === chatId ? { ...c, isArchived: nextArchived } : c
      ),
      activeChatId:
        nextArchived && state.activeChatId === chatId ? null : state.activeChatId,
    }));
    try {
      await useAuthStore.getState().authedRequest(`/conversations/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_archived: nextArchived }),
      });
    } catch {
      // ignore
    }
  },

  setDisappearingTimer: async (chatId: string, seconds: number) => {
    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === chatId ? { ...c, disappearingTimerSeconds: seconds } : c
      ),
    }));
    await useAuthStore.getState().authedRequest(`/conversations/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ disappearing_timer_seconds: seconds }),
    });
  },

  toggleStarMessage: async (chatId: string, messageId: string) => {
    const list = get().messagesByChat[chatId] || [];
    const target = list.find((m) => m.id === messageId);
    const nextStarred = !(target?.isStarred ?? false);

    set((state) => ({
      messagesByChat: {
        ...state.messagesByChat,
        [chatId]: (state.messagesByChat[chatId] || []).map((m) =>
          m.id === messageId ? { ...m, isStarred: nextStarred } : m
        ),
      },
    }));

    try {
      await useAuthStore
        .getState()
        .authedRequest(`/messages/${encodeURIComponent(messageId)}/star`, {
          method: nextStarred ? "POST" : "DELETE",
        });
    } catch {
      // ignore
    }
  },

  fetchStarredMessages: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user) return [];
    const myPrivKey = await getMyPrivateKeyJwk();
    const rows = await auth.authedRequest<ApiStarredMessageItem[]>(
      "/messages/starred"
    );
    const chatsMap = new Map(get().chats.map((c) => [c.id, c]));
    const out: DecryptedStarredEntry[] = [];
    for (const row of rows) {
      const chat = chatsMap.get(row.conversation_id);
      const chatName =
        chat?.name || row.conversation_name || row.message.sender_global_id;
      const uiMsg = await decryptApiMessageToUi(
        row.message,
        auth.user.id,
        myPrivKey,
        chatName,
        chat?.peerPublicKey,
        chat?.avatarColor || colorForIdentifier(row.conversation_id),
        chat?.isGroup ?? Boolean(row.message.sender_key_version)
      );
      out.push({
        starredAt: row.starred_at,
        chatId: row.conversation_id,
        chatName,
        message: { ...uiMsg, isStarred: true },
      });
    }
    return out;
  },

  setForwardModalMessage: (msg) => set({ forwardModalMessage: msg }),

  forwardMessageToChat: async (msg: MockMessage, targetChatId: string) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return;
    const targetChat = get().chats.find((c) => c.id === targetChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!targetChat || !myPrivKey) return;

    const payload: Omit<DecryptedMessagePayload, "v"> = {
      text: msg.text || "",
      forwarded: true,
    };
    let wireType: string = "text";

    if (msg.type === "location" && msg.location) {
      wireType = "location";
      payload.label = msg.location.label;
      payload.address = msg.location.address;
      payload.latitude = msg.location.latitude;
      payload.longitude = msg.location.longitude;
      payload.accuracy = msg.location.accuracy;
    } else if (msg.type === "image" && msg.image?.encryptedRef) {
      const ref = msg.image.encryptedRef;
      wireType = msg.image.isVideo ? "video" : "image";
      payload.text = msg.image.caption || "";
      payload.attachmentId = ref.attachmentId;
      payload.fileKeyB64 = ref.fileKeyB64;
      payload.baseNonceB64 = ref.baseNonceB64;
      payload.chunkSize = ref.chunkSize;
      payload.chunkCount = ref.chunkCount;
      payload.encryptedChunkLengths = ref.encryptedChunkLengths;
      payload.totalSizeBytes = ref.totalSizeBytes;
      payload.mimeType = ref.mimeType;
      payload.fileName = msg.image.fileName;
      payload.fileSize = msg.image.fileSize;
      payload.width = msg.image.width;
      payload.height = msg.image.height;
    } else if (msg.type === "file" && msg.file?.encryptedRef) {
      const ref = msg.file.encryptedRef;
      wireType = "document";
      payload.text = msg.file.fileName;
      payload.attachmentId = ref.attachmentId;
      payload.fileKeyB64 = ref.fileKeyB64;
      payload.baseNonceB64 = ref.baseNonceB64;
      payload.chunkSize = ref.chunkSize;
      payload.chunkCount = ref.chunkCount;
      payload.encryptedChunkLengths = ref.encryptedChunkLengths;
      payload.totalSizeBytes = ref.totalSizeBytes;
      payload.mimeType = ref.mimeType;
      payload.fileName = msg.file.fileName;
      payload.fileSize = msg.file.fileSize;
      payload.extension = msg.file.extension;
    } else if (msg.type === "voice" && msg.voice?.encryptedRef) {
      const ref = msg.voice.encryptedRef;
      wireType = "voice";
      payload.attachmentId = ref.attachmentId;
      payload.fileKeyB64 = ref.fileKeyB64;
      payload.baseNonceB64 = ref.baseNonceB64;
      payload.chunkSize = ref.chunkSize;
      payload.chunkCount = ref.chunkCount;
      payload.encryptedChunkLengths = ref.encryptedChunkLengths;
      payload.totalSizeBytes = ref.totalSizeBytes;
      payload.mimeType = ref.mimeType;
      payload.durationSec = msg.voice.durationSeconds;
      payload.waveform = msg.voice.waveform;
    }

    const { ciphertext, nonce, senderKeyVersion } = await encryptPayloadForChat({
      chat: targetChat,
      myUserId: auth.user.id,
      myPrivateKeyJwk: myPrivKey,
      payload,
    });

    const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: targetChatId,
        ciphertext,
        nonce,
        type: wireType,
        sender_key_version: senderKeyVersion ?? null,
      }),
    });

    const uiMsg = await decryptApiMessageToUi(
      saved,
      auth.user.id,
      myPrivKey,
      targetChat.name,
      targetChat.peerPublicKey,
      targetChat.avatarColor,
      targetChat.isGroup
    );

    set((state) => {
      const list = state.messagesByChat[targetChatId] || [];
      const exists = list.some((m) => m.id === uiMsg.id);
      return {
        forwardModalMessage: null,
        messagesByChat: {
          ...state.messagesByChat,
          [targetChatId]: attachReplyReferences(exists ? list : [...list, uiMsg]),
        },
        chats: sortChats(
          state.chats.map((c) =>
            c.id === targetChatId
              ? {
                  ...c,
                  lastMessagePreview: previewTextFromMessage(uiMsg, c.isGroup),
                  lastMessageType: uiMsg.type,
                  lastMessageTime: formatSidebarTimestamp(uiMsg.timestamp),
                  lastMessageIso: uiMsg.timestamp,
                  lastMessageOutgoing: true,
                  lastMessageStatus: uiMsg.status,
                }
              : c
          )
        ),
      };
    });
  },

  sendStatusReplyMessage: async (params) => {
    const auth = useAuthStore.getState();
    if (!auth.user) return null;
    const chatId = await get().startDirectChat({
      peerId: params.authorUserId,
      peerUsername: params.authorGlobalId,
    });
    if (!chatId) return null;
    const chat = get().chats.find((c) => c.id === chatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey) return null;

    const { ciphertext, nonce } = await encryptPayloadForChat({
      chat,
      myUserId: auth.user.id,
      myPrivateKeyJwk: myPrivKey,
      payload: {
        text: params.replyText.trim(),
        statusReply: {
          statusId: params.statusId,
          authorName: chat.name,
          mediaType: params.mediaType,
          previewText: params.previewText,
          backgroundStyle: params.backgroundStyle || null,
        },
      },
    });

    const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: chatId,
        ciphertext,
        nonce,
        type: "text",
      }),
    });

    const uiMsg = await decryptApiMessageToUi(
      saved,
      auth.user.id,
      myPrivKey,
      chat.name,
      chat.peerPublicKey,
      chat.avatarColor,
      false
    );

    set((state) => {
      const list = state.messagesByChat[chatId] || [];
      const exists = list.some((m) => m.id === uiMsg.id);
      return {
        messagesByChat: {
          ...state.messagesByChat,
          [chatId]: attachReplyReferences(exists ? list : [...list, uiMsg]),
        },
      };
    });
    await get().refreshConversations();
    return chatId;
  },

  exportChatHistory: (chatId: string, format: "txt" | "json") => {
    if (typeof window === "undefined") return;
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const msgs = (get().messagesByChat[chatId] || []).filter(
      (m) => m.type !== "system"
    );
    const safeName = chat.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "chat";
    let content = "";
    let mime = "text/plain;charset=utf-8";
    let ext = "txt";

    if (format === "json") {
      mime = "application/json;charset=utf-8";
      ext = "json";
      content = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          chatId: chat.id,
          chatName: chat.name,
          globalId: chat.globalId,
          encryption: chat.isGroup
            ? `Sender Keys E2EE (v${chat.keyVersion || 1})`
            : "ECDH P-256 + AES-256-GCM",
          messageCount: msgs.length,
          messages: msgs.map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            sender: m.senderId === "me" ? "You" : m.senderName,
            type: m.type,
            text: m.deletedForEveryone ? "[Deleted]" : m.text || "",
            fileName: m.file?.fileName || m.image?.fileName || undefined,
            starred: !!m.isStarred,
          })),
        },
        null,
        2
      );
    } else {
      const header = [
        `RelayChat End-to-End Encrypted Chat Export`,
        `Conversation: ${chat.name} (${chat.globalId})`,
        `Exported locally in browser: ${new Date().toLocaleString()}`,
        `------------------------------------------------------------`,
        ``,
      ];
      const lines = msgs.map((m) => {
        const dt = new Date(m.timestamp).toLocaleString();
        const sender = m.senderId === "me" ? "You" : m.senderName;
        const body = m.deletedForEveryone
          ? "[This message was deleted]"
          : m.type === "voice"
            ? "[Voice message]"
            : m.type === "file"
              ? `[Document: ${m.file?.fileName}]`
              : m.type === "image"
                ? `[Media: ${m.image?.fileName}${m.image?.caption ? ` — ${m.image.caption}` : ""}]`
                : m.type === "location"
                  ? `[Location: ${m.location?.label} (${m.location?.latitude}, ${m.location?.longitude})]`
                  : m.text || "";
        return `[${dt}] ${sender}: ${body}`;
      });
      content = [...header, ...lines].join("\n");
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relaychat-${safeName}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  sendCallSignal: (event, data) => {
    wsClientInstance?.send(event, data);
  },

  clearIncomingCall: () => set({ incomingCall: null }),

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

  sendTextMessage: async (rawText: string, explicitMentionIds?: string[]) => {
    const text = rawText.trim();
    const { activeChatId, replyingTo } = get();
    const auth = useAuthStore.getState();
    if (!text || !activeChatId || !auth.user) return;

    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return;

    if (chat.isGroup && chat.onlyAdminsCanSend && chat.myRole !== "admin") {
      set({ sendError: "Only group admins can send messages in this group." });
      return;
    }

    get().notifyLocalTyping(false);

    const mentionIds = extractMentionedUserIds(
      text,
      chat,
      auth.user.id,
      explicitMentionIds
    );

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
      mentions: mentionIds,
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

    try {
      // 2. Encrypt client-side (1:1 ECDH or Group Sender Key + fresh 12-byte random nonce)
      let encrypted = await encryptPayloadForChat({
        chat,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        payload: { text },
      });

      const buildWire = (enc: typeof encrypted) => ({
        conversation_id: activeChatId,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        type: "text" as const,
        sender_key_version: enc.senderKeyVersion ?? null,
        mentions: mentionIds,
        reply_to_id:
          replyingTo && !replyingTo.id.startsWith("cmsg-") ? replyingTo.id : null,
        client_msg_id: clientMsgId,
      });

      // 3. Send via WebSocket, or fall back to POST /messages REST (also used for group key-version retry)
      const sentOverWs = !chat.isGroup && wsClientInstance?.send("message.send", buildWire(encrypted));
      if (!sentOverWs) {
        let saved: ApiEncryptedMessage;
        try {
          saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
            method: "POST",
            body: JSON.stringify(buildWire(encrypted)),
          });
        } catch (firstErr) {
          // If group key rotated concurrently, rotate our Sender Key and retry once!
          if (chat.isGroup) {
            await get().refreshGroupDetail(activeChatId);
            const refreshedChat = get().chats.find((c) => c.id === activeChatId) || chat;
            encrypted = await encryptPayloadForChat({
              chat: refreshedChat,
              myUserId: auth.user.id,
              myPrivateKeyJwk: myPrivKey,
              payload: { text },
              forceRefreshGroup: true,
            });
            saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
              method: "POST",
              body: JSON.stringify(buildWire(encrypted)),
            });
          } else {
            throw firstErr;
          }
        }

        set((state) => ({
          messagesByChat: {
            ...state.messagesByChat,
            [activeChatId]: (state.messagesByChat[activeChatId] || []).map((m) =>
              m.clientMsgId === clientMsgId
                ? {
                    ...m,
                    id: saved.id,
                    status: saved.status,
                    senderKeyVersion: saved.sender_key_version || m.senderKeyVersion,
                    readBy: saved.read_by || [],
                    deliveredTo: saved.delivered_to || [],
                  }
                : m
            ),
          },
          chats: state.chats.map((c) =>
            c.id === activeChatId ? { ...c, lastMessageStatus: saved.status } : c
          ),
        }));
      }
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
  },

  submitEditMessage: async (messageId: string, newText: string) => {
    const trimmed = newText.trim();
    const { activeChatId } = get();
    const auth = useAuthStore.getState();
    if (!trimmed || !activeChatId || !auth.user) return;

    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return;

    const existingMsg = (get().messagesByChat[activeChatId] || []).find(
      (m) => m.id === messageId
    );

    let ciphertext: string;
    let nonce: string;
    if (chat.isGroup && existingMsg?.senderKeyVersion) {
      // Encrypt edited message under the exact Sender Key version stored on that message
      const cachedSk =
        readCachedSenderKey(
          auth.user.id,
          activeChatId,
          auth.user.id,
          existingMsg.senderKeyVersion
        ) ||
        (await resolveGroupSenderKeyForDecryption({
          groupId: activeChatId,
          senderId: auth.user.id,
          keyVersion: existingMsg.senderKeyVersion,
          myUserId: auth.user.id,
          myPrivateKeyJwk: myPrivKey,
        }));
      if (!cachedSk) {
        throw new Error("Original group Sender Key not available to edit this message.");
      }
      const enc = await encryptGroupMessageWithSenderKey({
        groupId: activeChatId,
        senderId: auth.user.id,
        keyVersion: existingMsg.senderKeyVersion,
        senderKeyB64: cachedSk,
        payload: { text: trimmed },
      });
      ciphertext = enc.ciphertext;
      nonce = enc.nonce;
    } else {
      const enc = await encryptPayloadForChat({
        chat,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        payload: { text: trimmed },
      });
      ciphertext = enc.ciphertext;
      nonce = enc.nonce;
    }

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
                lastMessagePreview: previewTextFromMessage(lastVisible, c.isGroup),
              }
            : c
        ),
      };
    });
  },

  sendAttachmentFile: async (file, options) => {
    const { activeChatId, replyingTo } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return;
    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return;

    if (chat.isGroup && chat.onlyAdminsCanSend && chat.myRole !== "admin") {
      set({ sendError: "Only group admins can send messages in this group." });
      return;
    }

    const rawMime =
      file.type ||
      (options?.forceType === "voice"
        ? "audio/webm"
        : options?.forceType === "document"
          ? "application/pdf"
          : "application/octet-stream");
    const cleanMime = rawMime.split(";")[0].trim().toLowerCase();

    const fileName =
      options?.fileName ||
      (file instanceof File && file.name ? file.name : "attachment.bin");
    const fileSizeLabel = formatHumanBytes(file.size);

    let apiMsgType: "image" | "video" | "audio" | "voice" | "document" = "document";
    if (options?.forceType) {
      apiMsgType = options.forceType;
    } else if (cleanMime.startsWith("image/")) {
      apiMsgType = "image";
    } else if (cleanMime.startsWith("video/")) {
      apiMsgType = "video";
    } else if (cleanMime.startsWith("audio/")) {
      apiMsgType = "audio";
    }

    const uploadId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();
    uploadAbortControllers.set(uploadId, controller);

    const uiCategory: ActiveUploadTask["category"] =
      apiMsgType === "document" ? "file" : apiMsgType;

    set((state) => ({
      sendError: null,
      activeUploads: {
        ...state.activeUploads,
        [uploadId]: {
          uploadId,
          chatId: activeChatId,
          fileName,
          fileSizeLabel,
          category: uiCategory,
          progressPercent: 0,
          uploadedChunks: 0,
          totalChunks: Math.max(1, Math.ceil(file.size / 1_048_576)),
          status: "encrypting",
        },
      },
    }));

    const replyTarget = replyingTo;
    if (replyTarget) {
      set({ replyingTo: null });
    }

    try {
      const uploaded = await encryptAndUploadAttachment({
        conversationId: activeChatId,
        blob: file,
        fileName,
        mimeType: cleanMime,
        signal: controller.signal,
        onStatus: (st) => {
          set((state) => {
            const cur = state.activeUploads[uploadId];
            if (!cur) return state;
            return {
              activeUploads: {
                ...state.activeUploads,
                [uploadId]: { ...cur, status: st },
              },
            };
          });
        },
        onProgress: (pct, uploadedChunks, totalChunks) => {
          set((state) => {
            const cur = state.activeUploads[uploadId];
            if (!cur) return state;
            return {
              activeUploads: {
                ...state.activeUploads,
                [uploadId]: {
                  ...cur,
                  progressPercent: pct,
                  uploadedChunks,
                  totalChunks,
                },
              },
            };
          });
        },
      });

      const ext = fileName.includes(".")
        ? (fileName.split(".").pop() || "FILE").toUpperCase()
        : "FILE";
      const caption = options?.caption?.trim() || "";

      const envelopePayload: Omit<DecryptedMessagePayload, "v"> = {
        text:
          apiMsgType === "voice"
            ? "Voice message"
            : caption || (apiMsgType === "document" ? fileName : ""),
        attachmentId: uploaded.attachmentId,
        fileKeyB64: uploaded.fileKeyB64,
        baseNonceB64: uploaded.baseNonceB64,
        chunkSize: uploaded.chunkSize,
        chunkCount: uploaded.chunkCount,
        encryptedChunkLengths: uploaded.encryptedChunkLengths,
        totalSizeBytes: uploaded.totalSizeBytes,
        downloadUrl: uploaded.downloadUrl,
        fileName,
        fileSize: fileSizeLabel,
        mimeType: uploaded.mimeType,
        extension: ext,
        thumbCiphertext: uploaded.thumbCiphertext,
        thumbNonce: uploaded.thumbNonce,
        width: uploaded.width,
        height: uploaded.height,
        durationSec: options?.durationSec ?? uploaded.durationSec,
        waveform: options?.waveform,
      };

      const { ciphertext, nonce, senderKeyVersion } = await encryptPayloadForChat({
        chat,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        payload: envelopePayload,
      });

      const clientMsgId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const wirePayload = {
        conversation_id: activeChatId,
        ciphertext,
        nonce,
        type: apiMsgType,
        sender_key_version: senderKeyVersion ?? null,
        attachment_id: uploaded.attachmentId,
        reply_to_id:
          replyTarget && !replyTarget.id.startsWith("cmsg-") ? replyTarget.id : null,
        client_msg_id: clientMsgId,
      };

      const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
        method: "POST",
        body: JSON.stringify(wirePayload),
      });

      const uiMsg = await decryptApiMessageToUi(
        saved,
        auth.user.id,
        myPrivKey,
        chat.name,
        chat.peerPublicKey,
        chat.avatarColor,
        chat.isGroup
      );

      set((state) => {
        const list = state.messagesByChat[activeChatId] || [];
        const exists = list.some((m) => m.id === uiMsg.id);
        const nextList = attachReplyReferences(exists ? list : [...list, uiMsg]);
        const nextUploads = { ...state.activeUploads };
        delete nextUploads[uploadId];
        return {
          activeUploads: nextUploads,
          messagesByChat: {
            ...state.messagesByChat,
            [activeChatId]: nextList,
          },
          chats: sortChats(
            state.chats.map((c) =>
              c.id === activeChatId
                ? {
                    ...c,
                    lastMessagePreview: previewTextFromMessage(uiMsg, c.isGroup),
                    lastMessageType: uiMsg.type,
                    lastMessageTime: formatSidebarTimestamp(uiMsg.timestamp),
                    lastMessageIso: uiMsg.timestamp,
                    lastMessageOutgoing: true,
                    lastMessageStatus: uiMsg.status,
                  }
                : c
            )
          ),
        };
      });
    } catch (err) {
      const isAbort =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      set((state) => {
        const nextUploads = { ...state.activeUploads };
        delete nextUploads[uploadId];
        return {
          activeUploads: nextUploads,
          sendError: isAbort
            ? null
            : err instanceof Error
              ? err.message
              : "Encrypted upload failed.",
        };
      });
    } finally {
      uploadAbortControllers.delete(uploadId);
    }
  },

  cancelUpload: (uploadId: string) => {
    const ctrl = uploadAbortControllers.get(uploadId);
    if (ctrl) {
      ctrl.abort();
      uploadAbortControllers.delete(uploadId);
    }
    set((state) => {
      const next = { ...state.activeUploads };
      delete next[uploadId];
      return { activeUploads: next };
    });
  },

  sendRecordedVoiceMessage: async (audioBlob, durationSeconds, waveform) => {
    const ext = (audioBlob.type || "").includes("ogg")
      ? "ogg"
      : (audioBlob.type || "").includes("mp4")
        ? "m4a"
        : "webm";
    await get().sendAttachmentFile(audioBlob, {
      fileName: `voice-note-${Date.now()}.${ext}`,
      forceType: "voice",
      durationSec: Math.max(1, Math.round(durationSeconds)),
      waveform,
    });
  },

  sendVoiceMessage: async (durationSeconds: number) => {
    // Fallback synthesizer if MediaRecorder blob wasn't supplied directly
    const sampleRate = 8000;
    const secs = Math.max(1, Math.min(30, Math.round(durationSeconds)));
    const numSamples = sampleRate * secs;
    const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(wavBuffer);
    const writeStr = (off: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 1.4) * 0.25;
      view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
    }
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });
    await get().sendRecordedVoiceMessage(
      wavBlob,
      secs,
      deterministicWaveform(`voice-${Date.now()}`)
    );
  },

  sendStaticLocation: async (loc) => {
    const { activeChatId, replyingTo } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return;
    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return;

    const replyTarget = replyingTo;
    if (replyTarget) set({ replyingTo: null });

    const { ciphertext, nonce, senderKeyVersion } = await encryptPayloadForChat({
      chat,
      myUserId: auth.user.id,
      myPrivateKeyJwk: myPrivKey,
      payload: {
        text: loc.label || "Current Location",
        label: loc.label || "Current Location",
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        isLive: false,
      },
    });

    const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: activeChatId,
        ciphertext,
        nonce,
        type: "location",
        sender_key_version: senderKeyVersion ?? null,
        reply_to_id:
          replyTarget && !replyTarget.id.startsWith("cmsg-") ? replyTarget.id : null,
      }),
    });

    const uiMsg = await decryptApiMessageToUi(
      saved,
      auth.user.id,
      myPrivKey,
      chat.name,
      chat.peerPublicKey,
      chat.avatarColor,
      chat.isGroup
    );

    set((state) => {
      const list = state.messagesByChat[activeChatId] || [];
      const exists = list.some((m) => m.id === uiMsg.id);
      return {
        messagesByChat: {
          ...state.messagesByChat,
          [activeChatId]: attachReplyReferences(exists ? list : [...list, uiMsg]),
        },
        chats: sortChats(
          state.chats.map((c) =>
            c.id === activeChatId
              ? {
                  ...c,
                  lastMessagePreview: previewTextFromMessage(uiMsg, c.isGroup),
                  lastMessageType: "location",
                  lastMessageTime: formatSidebarTimestamp(uiMsg.timestamp),
                  lastMessageIso: uiMsg.timestamp,
                  lastMessageOutgoing: true,
                  lastMessageStatus: uiMsg.status,
                }
              : c
          )
        ),
      };
    });
  },

  startLiveLocationShare: async (loc) => {
    const { activeChatId, replyingTo } = get();
    const auth = useAuthStore.getState();
    if (!activeChatId || !auth.user) return null;
    const chat = get().chats.find((c) => c.id === activeChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return null;

    const replyTarget = replyingTo;
    if (replyTarget) set({ replyingTo: null });

    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + loc.durationMinutes * 60_000).toISOString();

    const { ciphertext, nonce, senderKeyVersion } = await encryptPayloadForChat({
      chat,
      myUserId: auth.user.id,
      myPrivateKeyJwk: myPrivKey,
      payload: {
        text: loc.label || "Live Location",
        label: loc.label || "Live Location",
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        isLive: true,
        liveStopped: false,
        durationMinutes: loc.durationMinutes,
        expiresAt,
        updatedAt: new Date(nowMs).toISOString(),
      },
    });

    const saved = await auth.authedRequest<ApiEncryptedMessage>("/messages", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: activeChatId,
        ciphertext,
        nonce,
        type: "live_location",
        sender_key_version: senderKeyVersion ?? null,
        expires_at: expiresAt,
        reply_to_id:
          replyTarget && !replyTarget.id.startsWith("cmsg-") ? replyTarget.id : null,
      }),
    });

    const msgId = saved.id;
    const uiMsg = await decryptApiMessageToUi(
      saved,
      auth.user.id,
      myPrivKey,
      chat.name,
      chat.peerPublicKey,
      chat.avatarColor,
      chat.isGroup
    );

    set((state) => {
      const list = state.messagesByChat[activeChatId] || [];
      const exists = list.some((m) => m.id === uiMsg.id);
      return {
        activeLiveShares: {
          ...state.activeLiveShares,
          [msgId]: {
            messageId: msgId,
            chatId: activeChatId,
            label: loc.label || "Live Location",
            expiresAt,
            durationMinutes: loc.durationMinutes,
          },
        },
        messagesByChat: {
          ...state.messagesByChat,
          [activeChatId]: attachReplyReferences(exists ? list : [...list, uiMsg]),
        },
        chats: sortChats(
          state.chats.map((c) =>
            c.id === activeChatId
              ? {
                  ...c,
                  lastMessagePreview: previewTextFromMessage(uiMsg, c.isGroup),
                  lastMessageType: "location",
                  lastMessageTime: formatSidebarTimestamp(uiMsg.timestamp),
                  lastMessageIso: uiMsg.timestamp,
                  lastMessageOutgoing: true,
                  lastMessageStatus: uiMsg.status,
                }
              : c
          )
        ),
      };
    });

    const latestCoords = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
    };

    let geoWatchId: number | null = null;
    if (typeof navigator !== "undefined" && navigator.geolocation?.watchPosition) {
      try {
        geoWatchId = navigator.geolocation.watchPosition(
          (pos) => {
            latestCoords.latitude = pos.coords.latitude;
            latestCoords.longitude = pos.coords.longitude;
            latestCoords.accuracy = pos.coords.accuracy;
          },
          () => undefined,
          { enableHighAccuracy: true, maximumAge: 3000 }
        );
      } catch {
        geoWatchId = null;
      }
    }

    const intervalId = setInterval(() => {
      if (Date.now() >= new Date(expiresAt).getTime()) {
        get().stopLiveLocationShare(msgId);
        return;
      }
      get().pushLiveLocationUpdate(msgId, { ...latestCoords }).catch(() => undefined);
    }, 5000);

    const expiryTimeoutId = setTimeout(() => {
      get().stopLiveLocationShare(msgId).catch(() => undefined);
    }, Math.max(1000, new Date(expiresAt).getTime() - Date.now()));

    liveLocationHandles.set(msgId, {
      intervalId,
      expiryTimeoutId,
      geoWatchId,
      latestCoords,
      label: loc.label || "Live Location",
      address: loc.address,
      durationMinutes: loc.durationMinutes,
      expiresAt,
      chatId: activeChatId,
    });

    return msgId;
  },

  pushLiveLocationUpdate: async (messageId, coords) => {
    const handle = liveLocationHandles.get(messageId);
    const auth = useAuthStore.getState();
    if (!handle || !auth.user) return;
    if (Date.now() >= new Date(handle.expiresAt).getTime()) {
      await get().stopLiveLocationShare(messageId);
      return;
    }

    handle.latestCoords = { ...coords };
    const chat = get().chats.find((c) => c.id === handle.chatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    if (!chat || !myPrivKey || (!chat.isGroup && !chat.peerPublicKey)) return;

    const existingMsg = (get().messagesByChat[handle.chatId] || []).find(
      (m) => m.id === messageId
    );
    const payloadObj = {
      text: handle.label,
      label: handle.label,
      address: handle.address,
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
      isLive: true,
      liveStopped: false,
      durationMinutes: handle.durationMinutes,
      expiresAt: handle.expiresAt,
      updatedAt: new Date().toISOString(),
    };

    let ciphertext: string;
    let nonce: string;
    if (chat.isGroup && existingMsg?.senderKeyVersion) {
      const sk = readCachedSenderKey(
        auth.user.id,
        handle.chatId,
        auth.user.id,
        existingMsg.senderKeyVersion
      );
      if (!sk) return;
      const enc = await encryptGroupMessageWithSenderKey({
        groupId: handle.chatId,
        senderId: auth.user.id,
        keyVersion: existingMsg.senderKeyVersion,
        senderKeyB64: sk,
        payload: payloadObj,
      });
      ciphertext = enc.ciphertext;
      nonce = enc.nonce;
    } else {
      const enc = await encryptPayloadForChat({
        chat,
        myUserId: auth.user.id,
        myPrivateKeyJwk: myPrivKey,
        payload: payloadObj,
      });
      ciphertext = enc.ciphertext;
      nonce = enc.nonce;
    }

    const sentViaWs = wsClientInstance?.send("location.live_update", {
      conversation_id: handle.chatId,
      message_id: messageId,
      ciphertext,
      nonce,
    });

    if (!sentViaWs) {
      await auth.authedRequest(`/messages/${messageId}/live-location`, {
        method: "PATCH",
        body: JSON.stringify({ ciphertext, nonce }),
      });
    }
  },

  stopLiveLocationShare: async (messageId) => {
    const handle = liveLocationHandles.get(messageId);
    if (handle) {
      clearInterval(handle.intervalId);
      clearTimeout(handle.expiryTimeoutId);
      if (
        handle.geoWatchId !== null &&
        typeof navigator !== "undefined" &&
        navigator.geolocation
      ) {
        navigator.geolocation.clearWatch(handle.geoWatchId);
      }
      liveLocationHandles.delete(messageId);
    }

    const auth = useAuthStore.getState();
    const targetChatId =
      handle?.chatId ||
      Object.keys(get().messagesByChat).find((cid) =>
        (get().messagesByChat[cid] || []).some((m) => m.id === messageId)
      );
    const existingMsg = targetChatId
      ? (get().messagesByChat[targetChatId] || []).find((m) => m.id === messageId)
      : undefined;

    set((state) => {
      const nextShares = { ...state.activeLiveShares };
      delete nextShares[messageId];
      if (!targetChatId) return { activeLiveShares: nextShares };
      return {
        activeLiveShares: nextShares,
        messagesByChat: {
          ...state.messagesByChat,
          [targetChatId]: (state.messagesByChat[targetChatId] || []).map((m) =>
            m.id === messageId && m.location
              ? {
                  ...m,
                  location: {
                    ...m.location,
                    liveStopped: true,
                    expiresAt: new Date().toISOString(),
                    liveExpiresLabel: "Live location ended",
                  },
                }
              : m
          ),
        },
      };
    });

    if (!targetChatId || !auth.user) return;
    const chat = get().chats.find((c) => c.id === targetChatId);
    const myPrivKey = await getMyPrivateKeyJwk();
    let ciphertext: string | undefined;
    let nonce: string | undefined;

    if (chat && myPrivKey && (chat.isGroup || chat.peerPublicKey)) {
      const lat = handle?.latestCoords.latitude ?? existingMsg?.location?.latitude ?? 26.9124;
      const lng = handle?.latestCoords.longitude ?? existingMsg?.location?.longitude ?? 75.7873;
      const label = handle?.label ?? existingMsg?.location?.label ?? "Live Location";
      const address = handle?.address ?? existingMsg?.location?.address ?? "Stopped";

      const stopPayload = {
        text: label,
        label,
        address,
        latitude: lat,
        longitude: lng,
        isLive: true,
        liveStopped: true,
        expiresAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (chat.isGroup && existingMsg?.senderKeyVersion) {
        const sk = readCachedSenderKey(
          auth.user.id,
          targetChatId,
          auth.user.id,
          existingMsg.senderKeyVersion
        );
        if (sk) {
          const enc = await encryptGroupMessageWithSenderKey({
            groupId: targetChatId,
            senderId: auth.user.id,
            keyVersion: existingMsg.senderKeyVersion,
            senderKeyB64: sk,
            payload: stopPayload,
          });
          ciphertext = enc.ciphertext;
          nonce = enc.nonce;
        }
      } else {
        const enc = await encryptPayloadForChat({
          chat,
          myUserId: auth.user.id,
          myPrivateKeyJwk: myPrivKey,
          payload: stopPayload,
        });
        ciphertext = enc.ciphertext;
        nonce = enc.nonce;
      }
    }

    const sentViaWs = wsClientInstance?.send("location.live_stop", {
      conversation_id: targetChatId,
      message_id: messageId,
      ciphertext,
      nonce,
    });
    if (!sentViaWs) {
      await auth
        .authedRequest(`/messages/${messageId}/live-location/stop`, {
          method: "POST",
          body: JSON.stringify({ ciphertext: ciphertext || null, nonce: nonce || null }),
        })
        .catch(() => undefined);
    }
  },

  sendMockAttachItem: async (kind) => {
    if (kind === "contact") {
      await get().sendTextMessage("👤 Shared E2EE Contact Card");
    }
  },
}));
