export type DeliveryStatus = "pending" | "sent" | "delivered" | "read";

export type MockMessageType =
  | "text"
  | "image"
  | "file"
  | "voice"
  | "location"
  | "system";

export interface ReplyReference {
  messageId: string;
  senderName: string;
  previewText: string;
  type?: MockMessageType;
}

export interface ImageAttachmentMock {
  dataUrl: string;
  caption?: string;
  width: number;
  height: number;
  fileName: string;
}

export interface FileAttachmentMock {
  fileName: string;
  fileSize: string;
  extension: string;
  pageCount?: number;
}

export interface VoiceAttachmentMock {
  durationSeconds: number;
  waveform: number[];
}

export interface LocationAttachmentMock {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
  isLive?: boolean;
  liveExpiresLabel?: string;
}

export interface MockMessage {
  id: string;
  clientMsgId?: string;
  chatId: string;
  senderId: string; // "me" for outgoing, or peer user_id / global_id
  senderName: string;
  senderColor?: string;
  type: MockMessageType;
  text?: string;
  timestamp: string; // ISO string
  timeLabel: string; // e.g. "14:32"
  dateKey: string; // e.g. "2026-11-26"
  dateLabel: string; // e.g. "TODAY", "YESTERDAY", "NOV 22, 2026"
  status?: DeliveryStatus;
  edited?: boolean;
  deletedForEveryone?: boolean;
  decryptionError?: boolean;
  replyToId?: string | null;
  replyTo?: ReplyReference;
  image?: ImageAttachmentMock;
  file?: FileAttachmentMock;
  voice?: VoiceAttachmentMock;
  location?: LocationAttachmentMock;
}

export interface MockChat {
  id: string;
  name: string;
  rawDisplayName?: string;
  nickname?: string | null;
  globalId: string;
  peerUserId?: string;
  peerPublicKey?: string;
  avatarColor: string;
  avatarUrl?: string;
  about: string;
  isGroup: boolean;
  isContact?: boolean;
  isBlockedByMe?: boolean;
  hasBlockedMe?: boolean;
  memberCount?: number;
  memberNames?: string[];
  isOnline: boolean;
  lastSeen: string;
  lastSeenIso?: string | null;
  isPinned: boolean;
  isMuted: boolean;
  isTyping: boolean;
  typingUser?: string;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageType: MockMessageType;
  lastMessageTime: string;
  lastMessageIso?: string | null;
  lastMessageOutgoing: boolean;
  lastMessageStatus?: DeliveryStatus;
}
