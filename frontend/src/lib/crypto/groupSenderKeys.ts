/**
 * Phase 7 Group E2EE — Sender Keys Protocol (Web Crypto API)
 *
 * Architecture:
 * 1. Each group member generates a random 256-bit AES-GCM Sender Key for the group's
 *    current `keyVersion`.
 * 2. The sender wraps that 32-byte Sender Key individually for every active member
 *    (including themselves for multi-session history recovery) using pairwise
 *    ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM (`deriveSharedAesKey`) bound with
 *    group/version AAD (`RelayChat-SenderKeyWrap-v1|{groupId}|v{keyVersion}`).
 * 3. Group messages are encrypted ONCE with the sender's current Sender Key + random
 *    96-bit nonce + AAD (`RelayChat-GroupMsg-v1|{groupId}|{senderId}|v{keyVersion}`).
 * 4. Whenever a member is added, joins, leaves, or is removed, `keyVersion` increments
 *    and every active sender generates & distributes a brand-new Sender Key ONLY to
 *    current members — guaranteeing a removed user cannot decrypt any subsequent message.
 */

import {
  type DecryptedMessagePayload,
  base64ToBytes,
  bytesToBase64,
  deriveSharedAesKey,
} from "./e2ee.ts";

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API is required for group Sender Keys E2EE.");
}

export interface SenderKeyWrapEnvelope {
  recipient_id: string;
  wrapped_key: string;
  nonce: string;
}

export function buildSenderKeyWrapAad(groupId: string, keyVersion: number): Uint8Array {
  return new TextEncoder().encode(`RelayChat-SenderKeyWrap-v1|${groupId}|v${keyVersion}`);
}

export function buildGroupMessageAad(
  groupId: string,
  senderId: string,
  keyVersion: number
): Uint8Array {
  return new TextEncoder().encode(
    `RelayChat-GroupMsg-v1|${groupId}|${senderId}|v${keyVersion}`
  );
}

export async function generateGroupSenderKey(): Promise<string> {
  const raw = getWebCrypto().getRandomValues(new Uint8Array(32));
  return bytesToBase64(raw);
}

async function importSenderAesKey(
  senderKeyB64: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const raw = base64ToBytes(senderKeyB64);
  if (raw.byteLength !== 32) {
    throw new Error("Group Sender Key must be 256 bits (32 bytes).");
  }
  return getWebCrypto().subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function wrapSenderKeyForMember(params: {
  groupId: string;
  keyVersion: number;
  senderPrivateKeyJwk: JsonWebKey;
  recipientPublicKey: string | JsonWebKey;
  senderKeyB64: string;
}): Promise<{ wrappedKeyB64: string; nonceB64: string }> {
  const webCrypto = getWebCrypto();
  const pairwiseKey = await deriveSharedAesKey(
    params.senderPrivateKeyJwk,
    params.recipientPublicKey
  );
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const aad = buildSenderKeyWrapAad(params.groupId, params.keyVersion);
  const rawSenderKey = base64ToBytes(params.senderKeyB64);

  const ct = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    pairwiseKey,
    rawSenderKey as BufferSource
  );

  return {
    wrappedKeyB64: bytesToBase64(new Uint8Array(ct)),
    nonceB64: bytesToBase64(iv),
  };
}

export async function unwrapSenderKeyFromMember(params: {
  groupId: string;
  keyVersion: number;
  recipientPrivateKeyJwk: JsonWebKey;
  senderPublicKey: string | JsonWebKey;
  wrappedKeyB64: string;
  nonceB64: string;
}): Promise<string> {
  const webCrypto = getWebCrypto();
  const pairwiseKey = await deriveSharedAesKey(
    params.recipientPrivateKeyJwk,
    params.senderPublicKey
  );
  const iv = base64ToBytes(params.nonceB64);
  const aad = buildSenderKeyWrapAad(params.groupId, params.keyVersion);
  const ct = base64ToBytes(params.wrappedKeyB64);

  const rawBuf = await webCrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    pairwiseKey,
    ct as BufferSource
  );
  const rawBytes = new Uint8Array(rawBuf);
  if (rawBytes.byteLength !== 32) {
    throw new Error("Unwrapped Sender Key has invalid length.");
  }
  return bytesToBase64(rawBytes);
}

export async function buildSenderKeyEnvelopesForRoster(params: {
  groupId: string;
  keyVersion: number;
  senderPrivateKeyJwk: JsonWebKey;
  senderKeyB64: string;
  members: { userId: string; publicKey: string }[];
}): Promise<SenderKeyWrapEnvelope[]> {
  const envelopes: SenderKeyWrapEnvelope[] = [];
  for (const m of params.members) {
    const wrapped = await wrapSenderKeyForMember({
      groupId: params.groupId,
      keyVersion: params.keyVersion,
      senderPrivateKeyJwk: params.senderPrivateKeyJwk,
      recipientPublicKey: m.publicKey,
      senderKeyB64: params.senderKeyB64,
    });
    envelopes.push({
      recipient_id: m.userId,
      wrapped_key: wrapped.wrappedKeyB64,
      nonce: wrapped.nonceB64,
    });
  }
  return envelopes;
}

export async function encryptGroupMessageWithSenderKey(params: {
  groupId: string;
  senderId: string;
  keyVersion: number;
  senderKeyB64: string;
  payload: string | Omit<DecryptedMessagePayload, "v">;
}): Promise<{ ciphertext: string; nonce: string }> {
  const webCrypto = getWebCrypto();
  const aesKey = await importSenderAesKey(params.senderKeyB64, ["encrypt"]);
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const aad = buildGroupMessageAad(params.groupId, params.senderId, params.keyVersion);

  const envelope: DecryptedMessagePayload =
    typeof params.payload === "string"
      ? { v: 1, text: params.payload }
      : { v: 1, ...params.payload };

  const plainBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const ctBuf = await webCrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    aesKey,
    plainBytes as BufferSource
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ctBuf)),
    nonce: bytesToBase64(iv),
  };
}

export async function decryptGroupMessageWithSenderKey(params: {
  groupId: string;
  senderId: string;
  keyVersion: number;
  senderKeyB64: string;
  ciphertextB64: string;
  nonceB64: string;
}): Promise<DecryptedMessagePayload> {
  const webCrypto = getWebCrypto();
  const aesKey = await importSenderAesKey(params.senderKeyB64, ["decrypt"]);
  const iv = base64ToBytes(params.nonceB64);
  const ct = base64ToBytes(params.ciphertextB64);
  const aad = buildGroupMessageAad(params.groupId, params.senderId, params.keyVersion);

  const plainBuf = await webCrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    aesKey,
    ct as BufferSource
  );

  const decoded = new TextDecoder().decode(plainBuf);
  try {
    const parsed = JSON.parse(decoded) as DecryptedMessagePayload;
    if (parsed && typeof parsed.text === "string") {
      return {
        ...parsed,
        v: 1,
        text: parsed.text,
      };
    }
  } catch {
    // fallback raw string
  }
  return { v: 1, text: decoded };
}
