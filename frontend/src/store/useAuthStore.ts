"use client";

import { create } from "zustand";
import {
  ApiClientError,
  AuthResponse,
  DeviceSession,
  NodeKeyInfo,
  UserProfile,
  apiFetch,
} from "@/lib/api/client";
import {
  computeKeyFingerprint,
  exportEncryptedKeyBackup,
  generateIdentityKeyPair,
  importEncryptedKeyBackup,
  publicKeysMatch,
} from "@/lib/crypto/e2ee";
import {
  deleteIdentityKeyFromIndexedDB,
  loadIdentityKeyFromIndexedDB,
  saveIdentityKeyToIndexedDB,
} from "@/lib/crypto/keystore";

const SESSION_STORAGE_KEY = "relaychat-auth-v1";

interface PersistedSession {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
  device: DeviceSession;
}

let memorySessionFallback: PersistedSession | null = null;
let inflightRefreshPromise: Promise<AuthResponse> | null = null;
let inflightHydratePromise: Promise<void> | null = null;

function detectBrowserDeviceName(): string {
  if (typeof navigator === "undefined") return "Web Browser";
  const ua = navigator.userAgent;
  const browser = ua.includes("Firefox")
    ? "Firefox"
    : ua.includes("Edg")
      ? "Edge"
      : ua.includes("Chrome")
        ? "Chrome"
        : ua.includes("Safari")
          ? "Safari"
          : "Browser";
  const os = ua.includes("Mac")
    ? "macOS"
    : ua.includes("Win")
      ? "Windows"
      : ua.includes("Linux")
        ? "Linux"
        : ua.includes("Android")
          ? "Android"
          : ua.includes("iPhone")
            ? "iOS"
            : "Web";
  return `${browser} on ${os}`;
}

function persistSession(data: PersistedSession) {
  memorySessionFallback = data;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Kept in memorySessionFallback
    }
  }
}

function readPersistedSession(): PersistedSession | null {
  if (typeof window === "undefined") return memorySessionFallback;
  try {
    const raw =
      window.localStorage.getItem(SESSION_STORAGE_KEY) ||
      window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as PersistedSession;
    }
  } catch {
    // ignore storage access errors in strict iframes
  }
  return memorySessionFallback;
}

function clearPersistedSession() {
  memorySessionFallback = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function applyDocumentTheme(theme: "light" | "dark", wallpaper?: string) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (wallpaper) {
    document.documentElement.dataset.wallpaper = wallpaper;
  }
}

interface AuthState {
  hydrated: boolean;
  user: UserProfile | null;
  device: DeviceSession | null;
  accessToken: string | null;
  refreshToken: string | null;
  hasLocalPrivateKey: boolean;
  needsKeyRestore: boolean;
  keyFingerprint: string | null;
  theme: "light" | "dark";
  nodeInfo: NodeKeyInfo | null;

  hydrate: () => Promise<void>;
  setTheme: (theme: "light" | "dark") => void;
  signup: (params: {
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<UserProfile>;
  login: (params: {
    username: string;
    password: string;
  }) => Promise<{ user: UserProfile; needsKeyRestore: boolean }>;
  logout: () => Promise<void>;
  authedRequest: <T>(path: string, options?: RequestInit) => Promise<T>;
  updateProfile: (
    patch: Partial<
      Pick<
        UserProfile,
        | "display_name"
        | "about"
        | "privacy_last_seen"
        | "privacy_profile_photo"
        | "privacy_read_receipts"
        | "privacy_read_receipts_visibility"
        | "notifications_enabled"
        | "notification_sound"
        | "chat_wallpaper"
        | "theme"
      >
    >
  ) => Promise<void>;
  uploadAvatar: (file: File | Blob) => Promise<void>;
  exportKeyBackup: (passphrase: string) => Promise<string>;
  importKeyBackup: (backupJson: string, passphrase: string) => Promise<void>;
  rotateNewDeviceKeyPair: () => Promise<void>;
  fetchDevices: () => Promise<DeviceSession[]>;
  unlinkDevice: (deviceId: string) => Promise<void>;
  logoutAllOtherDevices: () => Promise<number>;
  deleteAccount: (password?: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  user: null,
  device: null,
  accessToken: null,
  refreshToken: null,
  hasLocalPrivateKey: false,
  needsKeyRestore: false,
  keyFingerprint: null,
  theme: "dark",
  nodeInfo: null,

  setTheme: (theme) => {
    applyDocumentTheme(theme);
    set({ theme });
  },

  authedRequest: async <T>(path: string, options: RequestInit = {}): Promise<T> => {
    const { accessToken, refreshToken } = get();
    try {
      return await apiFetch<T>(path, options, accessToken);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        if (!inflightRefreshPromise) {
          inflightRefreshPromise = apiFetch<AuthResponse>("/auth/refresh", {
            method: "POST",
            body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
          }).finally(() => {
            inflightRefreshPromise = null;
          });
        }
        const refreshed = await inflightRefreshPromise;
        persistSession({
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          user: refreshed.user,
          device: refreshed.device,
        });
        set({
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          user: refreshed.user,
          device: refreshed.device,
        });
        return apiFetch<T>(path, options, refreshed.access_token);
      }
      throw err;
    }
  },

  hydrate: async () => {
    if (typeof window === "undefined") return;

    if (!get().nodeInfo) {
      apiFetch<NodeKeyInfo>("/.well-known/node-key")
        .then((nodeInfo) => set({ nodeInfo }))
        .catch(() => undefined);
    }

    // If login() or signup() already populated the active session in memory, keep it!
    const current = get();
    if (current.hydrated && current.user && current.accessToken) {
      return;
    }

    if (inflightHydratePromise) {
      return inflightHydratePromise;
    }

    inflightHydratePromise = (async () => {
      const saved = readPersistedSession();

      try {
        let accessToken = current.accessToken || saved?.accessToken || null;
        let refreshToken = current.refreshToken || saved?.refreshToken || null;
        let user: UserProfile;
        let device = current.device || saved?.device || null;

        try {
          user = await apiFetch<UserProfile>("/users/me", {}, accessToken);
        } catch (err) {
          if (err instanceof ApiClientError && err.status === 401) {
            if (!inflightRefreshPromise) {
              inflightRefreshPromise = apiFetch<AuthResponse>("/auth/refresh", {
                method: "POST",
                body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
              }).finally(() => {
                inflightRefreshPromise = null;
              });
            }
            const refreshed = await inflightRefreshPromise;
            accessToken = refreshed.access_token;
            refreshToken = refreshed.refresh_token;
            user = refreshed.user;
            device = refreshed.device;
            persistSession({ accessToken, refreshToken, user, device });
          } else {
            throw err;
          }
        }

        const storedKey = await loadIdentityKeyFromIndexedDB(user.global_id);
        const matchesServer =
          !!storedKey && publicKeysMatch(storedKey.publicKeyJwk, user.public_key);
        const fingerprint = await computeKeyFingerprint(user.public_key);
        const resolvedTheme = user.theme === "light" ? "light" : "dark";
        applyDocumentTheme(resolvedTheme, user.chat_wallpaper || "default");

        set({
          hydrated: true,
          user,
          device,
          accessToken,
          refreshToken,
          hasLocalPrivateKey: matchesServer,
          needsKeyRestore: !matchesServer,
          keyFingerprint: fingerprint,
          theme: resolvedTheme,
        });
      } catch {
        clearPersistedSession();
        applyDocumentTheme("dark");
        set({
          hydrated: true,
          user: null,
          device: null,
          accessToken: null,
          refreshToken: null,
          hasLocalPrivateKey: false,
          needsKeyRestore: false,
        });
      }
    })().finally(() => {
      inflightHydratePromise = null;
    });

    return inflightHydratePromise;
  },

  signup: async ({ username, password, displayName }) => {
    const { publicKeyJwk, privateKeyJwk, publicKeySerialized } =
      await generateIdentityKeyPair();

    const auth = await apiFetch<AuthResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: username.trim().toLowerCase(),
        password,
        display_name: displayName?.trim() || undefined,
        public_key: publicKeySerialized,
        device_name: detectBrowserDeviceName(),
      }),
    });

    await saveIdentityKeyToIndexedDB({
      globalId: auth.user.global_id,
      publicKeyJwk,
      privateKeyJwk,
      createdAt: new Date().toISOString(),
    });

    const fingerprint = await computeKeyFingerprint(publicKeyJwk);
    const resolvedTheme = auth.user.theme === "light" ? "light" : "dark";
    applyDocumentTheme(resolvedTheme);
    persistSession({
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      user: auth.user,
      device: auth.device,
    });

    set({
      hydrated: true,
      user: auth.user,
      device: auth.device,
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      hasLocalPrivateKey: true,
      needsKeyRestore: false,
      keyFingerprint: fingerprint,
      theme: resolvedTheme,
    });
    return auth.user;
  },

  login: async ({ username, password }) => {
    const auth = await apiFetch<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: username.trim().toLowerCase(),
        password,
        device_name: detectBrowserDeviceName(),
      }),
    });

    const storedKey = await loadIdentityKeyFromIndexedDB(auth.user.global_id);
    const matchesServer =
      !!storedKey && publicKeysMatch(storedKey.publicKeyJwk, auth.user.public_key);
    const fingerprint = await computeKeyFingerprint(auth.user.public_key);
    const resolvedTheme = auth.user.theme === "light" ? "light" : "dark";
    applyDocumentTheme(resolvedTheme);

    persistSession({
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      user: auth.user,
      device: auth.device,
    });

    const needsKeyRestore = !matchesServer;
    set({
      hydrated: true,
      user: auth.user,
      device: auth.device,
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      hasLocalPrivateKey: matchesServer,
      needsKeyRestore,
      keyFingerprint: fingerprint,
      theme: resolvedTheme,
    });
    return { user: auth.user, needsKeyRestore };
  },

  logout: async () => {
    const { accessToken } = get();
    try {
      await apiFetch("/auth/logout", { method: "POST" }, accessToken);
    } catch {
      // ignore network/revoked errors during logout
    }
    clearPersistedSession();
    set({
      hydrated: true,
      user: null,
      device: null,
      accessToken: null,
      refreshToken: null,
      hasLocalPrivateKey: false,
      needsKeyRestore: false,
      keyFingerprint: null,
    });
  },

  updateProfile: async (patch) => {
    const updated = await get().authedRequest<UserProfile>("/users/me", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (patch.theme && (patch.theme === "light" || patch.theme === "dark")) {
      applyDocumentTheme(patch.theme, updated.chat_wallpaper);
      set({ theme: patch.theme });
    } else if (patch.chat_wallpaper) {
      applyDocumentTheme(get().theme, updated.chat_wallpaper);
    }
    const { accessToken, refreshToken, device } = get();
    if (accessToken && refreshToken && device) {
      persistSession({ accessToken, refreshToken, user: updated, device });
    }
    set({ user: updated });
  },

  uploadAvatar: async (file) => {
    const form = new FormData();
    if (file instanceof File) {
      form.append("file", file);
    } else {
      form.append("file", file, "avatar.jpg");
    }
    const updated = await get().authedRequest<UserProfile>("/users/me/avatar", {
      method: "POST",
      body: form,
    });
    const { accessToken, refreshToken, device } = get();
    if (accessToken && refreshToken && device) {
      persistSession({ accessToken, refreshToken, user: updated, device });
    }
    set({ user: updated });
  },

  exportKeyBackup: async (passphrase) => {
    const { user } = get();
    if (!user) throw new Error("Not signed in.");
    const stored = await loadIdentityKeyFromIndexedDB(user.global_id);
    if (!stored) {
      throw new Error("No private key found in this browser's IndexedDB.");
    }
    const backup = await exportEncryptedKeyBackup(
      user.global_id,
      stored.publicKeyJwk,
      stored.privateKeyJwk,
      passphrase
    );
    return JSON.stringify(backup, null, 2);
  },

  importKeyBackup: async (backupJson, passphrase) => {
    const { user } = get();
    if (!user) throw new Error("Not signed in.");
    const restored = await importEncryptedKeyBackup(backupJson, passphrase);
    if (!publicKeysMatch(restored.publicKeyJwk, user.public_key)) {
      throw new Error(
        `This backup belongs to a different keypair than ${user.global_id}'s registered public key.`
      );
    }
    await saveIdentityKeyToIndexedDB({
      globalId: user.global_id,
      publicKeyJwk: restored.publicKeyJwk,
      privateKeyJwk: restored.privateKeyJwk,
      createdAt: new Date().toISOString(),
    });
    const fingerprint = await computeKeyFingerprint(restored.publicKeyJwk);
    set({
      hasLocalPrivateKey: true,
      needsKeyRestore: false,
      keyFingerprint: fingerprint,
    });
  },

  rotateNewDeviceKeyPair: async () => {
    const { user } = get();
    if (!user) throw new Error("Not signed in.");
    const { publicKeyJwk, privateKeyJwk, publicKeySerialized } =
      await generateIdentityKeyPair();
    const updated = await get().authedRequest<UserProfile>("/users/me/public-key", {
      method: "PUT",
      body: JSON.stringify({ public_key: publicKeySerialized }),
    });
    await saveIdentityKeyToIndexedDB({
      globalId: updated.global_id,
      publicKeyJwk,
      privateKeyJwk,
      createdAt: new Date().toISOString(),
    });
    const fingerprint = await computeKeyFingerprint(publicKeyJwk);
    const { accessToken, refreshToken, device } = get();
    if (accessToken && refreshToken && device) {
      persistSession({ accessToken, refreshToken, user: updated, device });
    }
    set({
      user: updated,
      hasLocalPrivateKey: true,
      needsKeyRestore: false,
      keyFingerprint: fingerprint,
    });
  },

  fetchDevices: async () => {
    return get().authedRequest<DeviceSession[]>("/users/me/devices");
  },

  unlinkDevice: async (deviceId) => {
    await get().authedRequest(`/users/me/devices/${deviceId}`, { method: "DELETE" });
  },

  logoutAllOtherDevices: async () => {
    const res = await get().authedRequest<{ revoked_count: number }>("/users/me/devices", {
      method: "DELETE",
    });
    return res.revoked_count;
  },

  deleteAccount: async (password) => {
    const { user } = get();
    await get().authedRequest("/users/me", {
      method: "DELETE",
      body: JSON.stringify(password ? { password } : { confirm: "DELETE" }),
    });
    if (user) {
      await deleteIdentityKeyFromIndexedDB(user.global_id);
    }
    clearPersistedSession();
    set({
      hydrated: true,
      user: null,
      device: null,
      accessToken: null,
      refreshToken: null,
      hasLocalPrivateKey: false,
      needsKeyRestore: false,
      keyFingerprint: null,
    });
  },
}));
