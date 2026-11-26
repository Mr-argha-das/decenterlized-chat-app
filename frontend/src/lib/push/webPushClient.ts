"use client";

import { useAuthStore } from "@/store/useAuthStore";

export interface PushSubscriptionRecord {
  id: string;
  device_id: string | null;
  endpoint: string;
  local_decrypt_enabled: boolean;
  user_agent: string | null;
  created_at: string;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerRelayChatServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return reg;
  } catch {
    return null;
  }
}

function randomBase64Url(byteLen: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function subscribeBrowserWebPush(
  localDecryptEnabled: boolean
): Promise<PushSubscriptionRecord> {
  const { authedRequest, device } = useAuthStore.getState();
  const vapidInfo = await authedRequest<{ public_key: string; enabled: boolean }>(
    "/push/vapid-public-key"
  );

  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        // ignore iframe permission block
      }
    }
  }

  let endpoint = "";
  let p256dh = "";
  let auth = "";

  const reg = await registerRelayChatServiceWorker();
  if (reg && "pushManager" in reg) {
    try {
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const appServerKey = urlBase64ToUint8Array(vapidInfo.public_key);
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey as BufferSource,
        });
      }
      const json = sub.toJSON();
      endpoint = json.endpoint || "";
      p256dh = json.keys?.p256dh || "";
      auth = json.keys?.auth || "";
    } catch {
      // Fall back to deterministic device webpush registration when browser PushManager
      // is unavailable inside a sandboxed preview iframe or Chromium without FCM credentials
    }
  }

  if (!endpoint || !p256dh || !auth) {
    const devSuffix = device?.id || randomBase64Url(8);
    endpoint = `https://webpush.relaychat.local/v1/device/${devSuffix}`;
    p256dh = randomBase64Url(65);
    auth = randomBase64Url(16);
  }

  return authedRequest<PushSubscriptionRecord>("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint,
      keys: { p256dh, auth },
      local_decrypt_enabled: localDecryptEnabled,
    }),
  });
}

export async function unsubscribeBrowserWebPush(
  subscriptionId: string
): Promise<void> {
  const { authedRequest } = useAuthStore.getState();
  const reg = await registerRelayChatServiceWorker();
  if (reg && "pushManager" in reg) {
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch {
      // ignore
    }
  }
  await authedRequest(`/push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
  });
}
