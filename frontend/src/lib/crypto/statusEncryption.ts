/**
 * 24-Hour Status / Story End-to-End Encryption (Web Crypto API)
 * - Content payload encrypted once with a fresh random 256-bit AES-GCM key (`RelayChat-StatusPayload-v1` AAD).
 * - Content key wrapped individually for the author + each chosen contact via pairwise
 *   ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM (`RelayChat-StatusKey-v1|{recipientUserId}` AAD).
 */
import {
  base64ToBytes,
  bytesToBase64,
  deriveSharedAesKey,
} from "./e2ee.ts";
import { type EncryptedBlobRef } from "../../../mocks/types.ts";

export interface DecryptedStatusPayload {
  v: 1;
  kind: "text" | "image" | "video";
  text?: string;
  caption?: string;
  fontFamily?: "sans" | "serif" | "mono" | "display";
  backgroundStyle?: string;
  encryptedRef?: EncryptedBlobRef;
  thumbCiphertext?: string;
  thumbNonce?: string;
}

export interface WrappedStatusKeyEnvelope {
  wrapped_key: string;
  wrap_nonce: string;
}

export interface StatusRecipientKeyTarget {
  userId: string;
  publicKey: string | JsonWebKey;
}

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API is required for Status E2EE.");
}

export async function encryptStatusForRecipients(params: {
  authorUserId: string;
  authorPrivateKeyJwk: JsonWebKey;
  authorPublicKeyJwk: string | JsonWebKey;
  recipients: StatusRecipientKeyTarget[];
  payload: Omit<DecryptedStatusPayload, "v">;
}): Promise<{
  ciphertext: string;
  nonce: string;
  keyEnvelopes: Record<string, WrappedStatusKeyEnvelope>;
}> {
  const webCrypto = getWebCrypto();
  const contentKeyBytes = webCrypto.getRandomValues(new Uint8Array(32));
  const contentKey = await webCrypto.subtle.importKey(
    "raw",
    contentKeyBytes as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const contentIv = webCrypto.getRandomValues(new Uint8Array(12));
  const fullPayload: DecryptedStatusPayload = { v: 1, ...params.payload };
  const plaintext = new TextEncoder().encode(JSON.stringify(fullPayload));
  const payloadAad = new TextEncoder().encode("RelayChat-StatusPayload-v1");

  const cipherBuf = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: contentIv as BufferSource,
      additionalData: payloadAad as BufferSource,
    },
    contentKey,
    plaintext as BufferSource
  );

  const allTargets = new Map<string, string | JsonWebKey>();
  allTargets.set(params.authorUserId, params.authorPublicKeyJwk);
  for (const r of params.recipients) {
    if (r.userId && r.publicKey) {
      allTargets.set(r.userId, r.publicKey);
    }
  }

  const keyEnvelopes: Record<string, WrappedStatusKeyEnvelope> = {};
  for (const [uid, pubKey] of Array.from(allTargets.entries())) {
    const sharedAes = await deriveSharedAesKey(params.authorPrivateKeyJwk, pubKey);
    const wrapIv = webCrypto.getRandomValues(new Uint8Array(12));
    const keyAad = new TextEncoder().encode(`RelayChat-StatusKey-v1|${uid}`);
    const wrappedBuf = await webCrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: wrapIv as BufferSource,
        additionalData: keyAad as BufferSource,
      },
      sharedAes,
      contentKeyBytes as BufferSource
    );
    keyEnvelopes[uid] = {
      wrapped_key: bytesToBase64(new Uint8Array(wrappedBuf)),
      wrap_nonce: bytesToBase64(wrapIv),
    };
  }

  return {
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    nonce: bytesToBase64(contentIv),
    keyEnvelopes,
  };
}

export async function decryptStatusForViewer(params: {
  viewerUserId: string;
  viewerPrivateKeyJwk: JsonWebKey;
  authorPublicKey: string | JsonWebKey;
  ciphertext: string;
  nonce: string;
  myKeyEnvelope: WrappedStatusKeyEnvelope;
}): Promise<DecryptedStatusPayload> {
  const webCrypto = getWebCrypto();
  const sharedAes = await deriveSharedAesKey(
    params.viewerPrivateKeyJwk,
    params.authorPublicKey
  );

  const wrapIv = base64ToBytes(params.myKeyEnvelope.wrap_nonce);
  const wrappedBytes = base64ToBytes(params.myKeyEnvelope.wrapped_key);
  const keyAad = new TextEncoder().encode(
    `RelayChat-StatusKey-v1|${params.viewerUserId}`
  );

  const rawContentKey = await webCrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: wrapIv as BufferSource,
      additionalData: keyAad as BufferSource,
    },
    sharedAes,
    wrappedBytes as BufferSource
  );

  const contentKey = await webCrypto.subtle.importKey(
    "raw",
    rawContentKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const payloadIv = base64ToBytes(params.nonce);
  const payloadCipher = base64ToBytes(params.ciphertext);
  const payloadAad = new TextEncoder().encode("RelayChat-StatusPayload-v1");

  const plainBuf = await webCrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: payloadIv as BufferSource,
      additionalData: payloadAad as BufferSource,
    },
    contentKey,
    payloadCipher as BufferSource
  );

  return JSON.parse(new TextDecoder().decode(plainBuf)) as DecryptedStatusPayload;
}
