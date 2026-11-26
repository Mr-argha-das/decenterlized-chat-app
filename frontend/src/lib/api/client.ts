export type PrivacyScope = "everyone" | "contacts" | "nobody";
export type WallpaperChoice =
  | "default"
  | "emerald"
  | "midnight"
  | "sand"
  | "rose"
  | "slate";

export interface UserProfile {
  id: string;
  username: string;
  domain: string;
  global_id: string;
  public_key: string;
  display_name: string;
  about: string;
  avatar_url: string | null;
  is_local: boolean;
  is_admin?: boolean;
  is_online: boolean;
  last_seen_at: string | null;
  privacy_last_seen: PrivacyScope;
  privacy_profile_photo: PrivacyScope;
  privacy_read_receipts: boolean;
  privacy_read_receipts_visibility: PrivacyScope;
  notifications_enabled: boolean;
  notification_sound: boolean;
  chat_wallpaper: WallpaperChoice;
  theme: "light" | "dark" | "system";
  created_at: string;
}

export interface DeviceSession {
  id: string;
  name: string;
  device_name: string;
  user_agent: string | null;
  ip_address: string | null;
  is_revoked: boolean;
  last_active: string;
  last_active_at: string;
  created_at: string;
  is_current: boolean;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: UserProfile;
  device: DeviceSession;
}

export interface UsernameCheckResponse {
  username: string;
  id: string;
  valid: boolean;
  available: boolean;
  reason: string | null;
}

export interface WellKnownUser {
  id: string;
  username: string;
  domain: string;
  global_id: string;
  display_name: string;
  about: string;
  avatar_url: string | null;
  public_key: string;
  key_algorithm: string;
  node: string;
  node_url: string;
  federation_inbox_url: string;
}

export interface NodeKeyInfo {
  app_name: string;
  domain: string;
  node_url: string;
  algorithm: string;
  public_key: string;
  federation_inbox_url: string;
  protocol_version: string;
}

export interface PeerProfileView {
  id: string;
  username: string;
  domain: string;
  global_id: string;
  display_name: string;
  nickname: string | null;
  effective_name: string;
  about: string;
  avatar_url: string | null;
  public_key: string;
  is_local: boolean;
  is_online: boolean;
  last_seen_at: string | null;
  is_contact: boolean;
  is_blocked_by_me: boolean;
  has_blocked_me: boolean;
}

export interface ApiContact {
  id: string;
  owner_id: string;
  contact_user_id: string;
  nickname: string | null;
  created_at: string;
  user: PeerProfileView;
}

export interface ApiBlock {
  id: string;
  blocker_id: string;
  blocked_user_id: string;
  reason: string | null;
  created_at: string;
  user: PeerProfileView;
}

export interface ApiPeerSummary {
  id: string;
  username: string;
  domain: string;
  global_id: string;
  display_name: string;
  raw_display_name?: string | null;
  nickname?: string | null;
  about: string;
  avatar_url: string | null;
  public_key: string;
  is_online: boolean;
  last_seen_at: string | null;
  is_contact?: boolean;
  is_blocked_by_me?: boolean;
  has_blocked_me?: boolean;
}

export interface ApiReceiptEntry {
  user_id: string;
  global_id: string;
  display_name: string;
  avatar_url: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

export interface ApiGroupMember {
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

export interface ApiGroupSummary {
  id: string;
  name: string;
  description: string;
  icon_url: string | null;
  created_by_id: string | null;
  key_version: number;
  only_admins_can_send: boolean;
  only_admins_can_edit_info: boolean;
  my_role: "admin" | "member";
  member_count: number;
  invite_code: string | null;
  members: ApiGroupMember[];
  created_at: string;
}

export interface ApiGroupSenderKey {
  id: string;
  group_id: string;
  sender_id: string;
  sender_global_id: string;
  sender_public_key: string;
  recipient_id: string;
  key_version: number;
  wrapped_key: string;
  nonce: string;
  created_at: string;
}

export interface ApiGroupInviteInfo {
  group_id: string;
  invite_code: string;
  invite_path: string;
  invite_revoked_at: string | null;
}

export interface ApiGroupInvitePreview {
  group_id: string;
  name: string;
  description: string;
  icon_url: string | null;
  member_count: number;
  already_member: boolean;
}

export interface ApiEncryptedMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_global_id: string;
  sender_display_name?: string | null;
  sender_color?: string | null;
  ciphertext: string;
  nonce: string;
  type: string;
  status: "sent" | "delivered" | "read";
  sender_key_version?: number | null;
  mentions?: string[];
  system_event?: {
    action?: string;
    actor_id?: string;
    actor_name?: string;
    target_id?: string;
    target_name?: string;
    text?: string;
  } | null;
  attachment_id?: string | null;
  reply_to_id: string | null;
  client_msg_id?: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_for_everyone: boolean;
  expires_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  is_starred?: boolean;
  read_by?: ApiReceiptEntry[];
  delivered_to?: ApiReceiptEntry[];
}

export interface ApiConversation {
  id: string;
  type: "direct" | "group";
  name: string | null;
  description?: string | null;
  icon_url: string | null;
  peer: ApiPeerSummary | null;
  group?: ApiGroupSummary | null;
  unread_count: number;
  is_pinned: boolean;
  is_muted: boolean;
  is_archived?: boolean;
  disappearing_timer_seconds?: number;
  last_message_at: string | null;
  last_message: ApiEncryptedMessage | null;
  created_at: string;
}

export interface ApiCursorMessages {
  items: ApiEncryptedMessage[];
  next_cursor: string | null;
  has_more: boolean;
}

export class ApiClientError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function getApiBaseUrl(): string {
  return "";
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  accessToken?: string | null
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("X-RelayChat-Client", "web");
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("X-RelayChat-Token", accessToken);
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) {
        code = data.error.code || code;
        message = data.error.message || message;
        if (Array.isArray(data.error.details) && data.error.details.length > 0) {
          message = data.error.details[0]?.msg || message;
        }
      }
    } catch {
      // ignore non-json body
    }
    throw new ApiClientError(code, message, res.status);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Phase 8: Federation Peer Status & Domain Policy Controls
// ---------------------------------------------------------------------------
export type FederationPolicyMode = "open" | "allowlist" | "denylist";

export interface FederationPeerItem {
  id: string;
  domain: string;
  node_url: string;
  inbox_url: string | null;
  public_key_ed25519: string;
  status: string;
  is_trusted: boolean;
  is_blocked: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface FederationDomainRuleItem {
  id: string;
  domain: string;
  rule: "allow" | "block";
  note: string | null;
  created_at: string;
}

export interface FederationOutboxItem {
  id: string;
  event_id: string | null;
  target_domain: string;
  target_inbox_url: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  dead_lettered_at: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface FederationStatusResponse {
  domain: string;
  app_name: string;
  node_url: string;
  public_key_ed25519: string;
  federation_enabled: boolean;
  policy_mode: FederationPolicyMode;
  can_manage: boolean;
  rules: FederationDomainRuleItem[];
  peers: FederationPeerItem[];
  outbox_stats: {
    pending: number;
    processing: number;
    delivered: number;
    dead_letter: number;
  };
  recent_outbox: FederationOutboxItem[];
  cached_remote_users: number;
}

// ---------------------------------------------------------------------------
// Phase 9: 24-Hour Encrypted Statuses & Starred Messages
// ---------------------------------------------------------------------------
export type StatusPrivacyMode = "contacts" | "except" | "only";
export type StatusFontFamily = "sans" | "serif" | "mono" | "display";

export interface ApiStatusViewer {
  user_id: string;
  global_id: string;
  display_name: string;
  avatar_url?: string | null;
  viewed_at: string;
}

export interface ApiStatusItem {
  id: string;
  user_id: string;
  author_global_id: string;
  author_display_name: string;
  author_avatar_url: string | null;
  author_public_key: string;
  media_type: "text" | "image" | "video";
  ciphertext: string;
  nonce: string;
  my_key_envelope: {
    wrapped_key: string;
    wrap_nonce: string;
  } | null;
  background_style: string | null;
  font_family: StatusFontFamily;
  attachment_id: string | null;
  privacy_mode: StatusPrivacyMode;
  is_viewed: boolean;
  view_count: number;
  viewers: ApiStatusViewer[];
  created_at: string;
  expires_at: string;
}

export interface ApiUserStatusBundle {
  user_id: string;
  global_id: string;
  display_name: string;
  avatar_url: string | null;
  public_key: string;
  is_muted: boolean;
  all_viewed: boolean;
  latest_at: string;
  statuses: ApiStatusItem[];
}

export interface ApiStatusPrivacy {
  mode: StatusPrivacyMode;
  except_user_ids: string[];
  only_user_ids: string[];
}

export interface ApiStatusFeed {
  my_statuses: ApiStatusItem[];
  recent_updates: ApiUserStatusBundle[];
  muted_updates: ApiUserStatusBundle[];
  privacy: ApiStatusPrivacy;
}

export interface ApiStatusRecipientCandidate {
  user_id: string;
  global_id: string;
  display_name: string;
  avatar_url: string | null;
  public_key: string;
}

export interface ApiStarredMessageItem {
  starred_at: string;
  conversation_id: string;
  conversation_name: string | null;
  message: ApiEncryptedMessage;
}


