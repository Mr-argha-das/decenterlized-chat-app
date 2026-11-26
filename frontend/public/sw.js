/* RelayChat Service Worker (PWA Shell + E2EE-Preserving Web Push) */
const CACHE_NAME = "relaychat-pwa-v1";
const DB_NAME = "relaychat-keystore-v1";
const IDENTITY_STORE = "identities";
const HKDF_SALT = new TextEncoder().encode("RelayChat-ECDH-HKDF-SHA256-v1");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(["/manifest.json", "/icon.svg"]).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function b64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function loadFirstIdentityFromIndexedDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
          db.close();
          resolve(null);
          return;
        }
        const tx = db.transaction(IDENTITY_STORE, "readonly");
        const allReq = tx.objectStore(IDENTITY_STORE).getAll();
        allReq.onsuccess = () => {
          db.close();
          const list = allReq.result || [];
          resolve(list.length > 0 ? list[0] : null);
        };
        allReq.onerror = () => {
          db.close();
          resolve(null);
        };
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tryDecryptDirectPushPayload(data) {
  if (
    !data ||
    !data.local_decrypt ||
    data.is_group ||
    !data.ciphertext ||
    !data.nonce ||
    !data.sender_public_key
  ) {
    return null;
  }

  const identity = await loadFirstIdentityFromIndexedDB();
  if (!identity || !identity.privateKeyJwk) return null;

  const peerPubJwk =
    typeof data.sender_public_key === "string"
      ? JSON.parse(data.sender_public_key)
      : data.sender_public_key;

  const privKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: identity.privateKeyJwk.x,
      y: identity.privateKeyJwk.y,
      d: identity.privateKeyJwk.d,
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  const pubKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: peerPubJwk.x,
      y: peerPubJwk.y,
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: pubKey },
    privKey,
    256
  );

  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );

  const myCoord = `${identity.privateKeyJwk.x}:${identity.privateKeyJwk.y}`;
  const peerCoord = `${peerPubJwk.x}:${peerPubJwk.y}`;
  const sortedCoords = [myCoord, peerCoord].sort().join("|");
  const info = new TextEncoder().encode(
    `RelayChat-1to1-AES256GCM|${sortedCoords}`
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info,
    },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(data.nonce) },
    aesKey,
    b64ToBytes(data.ciphertext)
  );
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
  const senderLabel =
    data.sender_display_name || data.sender_global_id || "RelayChat";
  const bodyText =
    parsed.text && parsed.text.trim()
      ? parsed.text.trim().slice(0, 140)
      : data.message_type === "image"
        ? "📷 Encrypted photo"
        : data.message_type === "voice"
          ? "🎤 Voice message"
          : "📎 Encrypted attachment";
  return { title: senderLabel, body: bodyText };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = { title: "RelayChat", body: "New message" };
      }

      let title = "RelayChat";
      let body = "New message";

      if (data.local_decrypt) {
        try {
          const decrypted = await tryDecryptDirectPushPayload(data);
          if (decrypted) {
            title = decrypted.title;
            body = decrypted.body;
          }
        } catch {
          // Keep privacy-preserving "New message" fallback if key is unavailable
        }
      }

      await self.registration.showNotification(title, {
        body,
        icon: "/icon.svg",
        badge: "/icon.svg",
        tag: data.conversation_id
          ? `relaychat-conv-${data.conversation_id}`
          : "relaychat-push",
        data: {
          conversationId: data.conversation_id || null,
          messageId: data.message_id || null,
        },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId || null;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if ("focus" in client) {
            client.focus();
            if (conversationId) {
              client.postMessage({
                type: "RELAYCHAT_OPEN_CONVERSATION",
                conversationId,
              });
            }
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(
            conversationId ? `/?chat=${encodeURIComponent(conversationId)}` : "/"
          );
        }
      })
  );
});
