export type DeliveryStatus = "pending" | "sent" | "delivered" | "read";
export type MessageStatus = DeliveryStatus;

export type MockMessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
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

export interface EncryptedBlobRef {
  attachmentId: string;
  fileKeyB64: string;
  baseNonceB64: string;
  chunkSize: number;
  chunkCount: number;
  encryptedChunkLengths?: number[];
  totalSizeBytes: number;
  mimeType: string;
  downloadUrl?: string;
}

export interface ImageAttachmentMock {
  dataUrl: string;
  thumbDataUrl?: string;
  caption?: string;
  width: number;
  height: number;
  fileName: string;
  fileSize?: string;
  mimeType?: string;
  isVideo?: boolean;
  durationSeconds?: number;
  encryptedRef?: EncryptedBlobRef;
}

export interface FileAttachmentMock {
  fileName: string;
  fileSize: string;
  extension: string;
  mimeType?: string;
  pageCount?: number;
  encryptedRef?: EncryptedBlobRef;
}

export interface VoiceAttachmentMock {
  durationSeconds: number;
  waveform: number[];
  audioUrl?: string;
  mimeType?: string;
  encryptedRef?: EncryptedBlobRef;
}

export interface LocationAttachmentMock {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  isLive?: boolean;
  liveStopped?: boolean;
  durationMinutes?: number;
  expiresAt?: string;
  updatedAt?: string;
  liveExpiresLabel?: string;
}

export interface ActiveUploadTask {
  uploadId: string;
  chatId: string;
  fileName: string;
  fileSizeLabel: string;
  category: "image" | "video" | "audio" | "voice" | "file";
  progressPercent: number;
  uploadedChunks: number;
  totalChunks: number;
  status: "encrypting" | "uploading" | "finalizing" | "error";
  errorMessage?: string;
}

export interface MessageReadEntry {
  user_id: string;
  global_id: string;
  display_name: string;
  avatar_url?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
}

export interface GroupMemberInfo {
  user_id: string;
  username: string;
  domain: string;
  global_id: string;
  display_name: string;
  avatar_url: string | null;
  public_key: string;
  role: "admin" | "member";
  sender_color: string;
  is_online: boolean;
  joined_at: string;
}

export interface StatusReplyReference {
  statusId: string;
  authorName?: string;
  mediaType: string;
  previewText?: string;
  backgroundStyle?: string | null;
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
  senderKeyVersion?: number;
  mentions?: string[];
  readBy?: MessageReadEntry[];
  deliveredTo?: MessageReadEntry[];
  isStarred?: boolean;
  isForwarded?: boolean;
  expiresAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  statusReply?: StatusReplyReference;
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
  description?: string;
  isGroup: boolean;
  myRole?: "admin" | "member";
  onlyAdminsCanSend?: boolean;
  onlyAdminsCanEditInfo?: boolean;
  keyVersion?: number;
  inviteCode?: string | null;
  groupMembers?: GroupMemberInfo[];
  hasUnreadMention?: boolean;
  removedFromGroup?: boolean;
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
  isArchived?: boolean;
  disappearingTimerSeconds?: number;
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
