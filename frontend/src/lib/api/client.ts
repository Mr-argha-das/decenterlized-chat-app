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

export interface ApiEncryptedMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_global_id: string;
  ciphertext: string;
  nonce: string;
  type: string;
  status: "sent" | "delivered" | "read";
  reply_to_id: string | null;
  client_msg_id?: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_for_everyone: boolean;
  delivered_at?: string | null;
  read_at?: string | null;
}

export interface ApiConversation {
  id: string;
  type: "direct" | "group";
  name: string | null;
  icon_url: string | null;
  peer: ApiPeerSummary | null;
  unread_count: number;
  is_pinned: boolean;
  is_muted: boolean;
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
