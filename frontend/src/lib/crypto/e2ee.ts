/**
 * End-to-End Encryption Primitives (Web Crypto API — Browser & Node 20+ compatible)
 * - Identity: ECDH P-256 (private key never leaves browser IndexedDB)
 * - Shared secret -> KDF: ECDH P-256 deriveBits(256) -> HKDF-SHA256 -> AES-256-GCM
 * - Symmetric content encryption: AES-256-GCM with fresh 96-bit (12-byte) random nonce per message
 * - Portable key backup: PBKDF2-SHA256 (250,000 iterations) + AES-256-GCM
 */

export interface EncryptedKeyBackupFile {
  format: "relaychat-key-backup-v1";
  globalId: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  publicKeyJwk: JsonWebKey;
}

export interface DecryptedMessagePayload {
  v: 1;
  text: string;
  // Encrypted attachment key & chunk geometry (travels ONLY inside E2EE ciphertext)
  attachmentId?: string;
  fileKeyB64?: string;
  baseNonceB64?: string;
  chunkSize?: number;
  chunkCount?: number;
  encryptedChunkLengths?: number[];
  totalSizeBytes?: number;
  downloadUrl?: string;
  fileName?: string;
  fileSize?: string;
  mimeType?: string;
  extension?: string;
  // Client-generated encrypted thumbnail (for image & video previews)
  thumbCiphertext?: string;
  thumbNonce?: string;
  width?: number;
  height?: number;
  // Voice & Audio metadata
  durationSec?: number;
  waveform?: number[];
  // Static & Live Location metadata
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  label?: string;
  address?: string;
  isLive?: boolean;
  liveStopped?: boolean;
  durationMinutes?: number;
  expiresAt?: string;
  updatedAt?: string;
  // Phase 9: Forwarded flag & Status Reply context (travels strictly inside E2EE ciphertext)
  forwarded?: boolean;
  statusReply?: {
    statusId: string;
    authorName?: string;
    mediaType: string;
    previewText?: string;
    backgroundStyle?: string | null;
  };
}

const HKDF_SALT = new TextEncoder().encode("RelayChat-ECDH-HKDF-SHA256-v1");
const derivedPairKeyCache = new Map<string, CryptoKey>();

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API is not available in this environment.");
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function parsePublicKeyJwk(raw: string | JsonWebKey): JsonWebKey {
  const jwk: JsonWebKey = typeof raw === "string" ? (JSON.parse(raw) as JsonWebKey) : raw;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Invalid peer P-256 public key JWK.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };
}

export async function generateIdentityKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  publicKeySerialized: string;
}> {
  const webCrypto = getWebCrypto();
  const keyPair = await webCrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );

  const rawPub = await webCrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await webCrypto.subtle.exportKey("jwk", keyPair.privateKey);

  // Explicitly strip any private parameters so only public coordinates leave the browser
  const publicKeyJwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: rawPub.x,
    y: rawPub.y,
    ext: true,
  };

  return {
    publicKeyJwk,
    privateKeyJwk,
    publicKeySerialized: JSON.stringify(publicKeyJwk),
  };
}

export async function computeKeyFingerprint(
  publicKeyJsonOrJwk: string | JsonWebKey
): Promise<string> {
  const webCrypto = getWebCrypto();
  const jwk = parsePublicKeyJwk(publicKeyJsonOrJwk);
  const canonical = `ECDH-P256:${jwk.x ?? ""}:${jwk.y ?? ""}`;
  const digest = await webCrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  );
  const bytes = new Uint8Array(digest);
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 3) {
    const val = ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) % 100000;
    groups.push(val.toString().padStart(5, "0"));
  }
  return groups.join(" ");
}

export function publicKeysMatch(a: string | JsonWebKey, b: string | JsonWebKey): boolean {
  try {
    const jwkA = parsePublicKeyJwk(a);
    const jwkB = parsePublicKeyJwk(b);
    return jwkA.x === jwkB.x && jwkA.y === jwkB.y;
  } catch {
    return false;
  }
}

/**
 * Derives a shared 256-bit AES-GCM key between `myPrivateKeyJwk` and `peerPublicKey`
 * using ECDH P-256 shared secret bits -> HKDF-SHA256 domain-separated key expansion.
 * Both participants derive the exact same symmetric key without ever transmitting secrets.
 */
export async function deriveSharedAesKey(
  myPrivateKeyJwk: JsonWebKey,
  peerPublicKeyInput: string | JsonWebKey
): Promise<CryptoKey> {
  const webCrypto = getWebCrypto();
  const peerPubJwk = parsePublicKeyJwk(peerPublicKeyInput);

  const myCoord = `${myPrivateKeyJwk.x ?? ""}:${myPrivateKeyJwk.y ?? ""}`;
  const peerCoord = `${peerPubJwk.x ?? ""}:${peerPubJwk.y ?? ""}`;
  const cacheKey = `${myPrivateKeyJwk.d?.slice(0, 12) ?? myCoord}|${peerCoord}`;
  const cached = derivedPairKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const privKey = await webCrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: myPrivateKeyJwk.x,
      y: myPrivateKeyJwk.y,
      d: myPrivateKeyJwk.d,
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  const pubKey = await webCrypto.subtle.importKey(
    "jwk",
    peerPubJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 1. Raw 256-bit ECDH shared secret Z
  const sharedBits = await webCrypto.subtle.deriveBits(
    { name: "ECDH", public: pubKey },
    privKey,
    256
  );

  // 2. Import Z into HKDF and bind sorted public coordinates in `info`
  const hkdfBaseKey = await webCrypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );
  const sortedCoords = [myCoord, peerCoord].sort().join("|");
  const infoBytes = new TextEncoder().encode(`RelayChat-1to1-AES256GCM|${sortedCoords}`);

  const aesKey = await webCrypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT as BufferSource,
      info: infoBytes as BufferSource,
    },
    hkdfBaseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  derivedPairKeyCache.set(cacheKey, aesKey);
  return aesKey;
}

export async function encryptAesGcm(
  aesKey: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; nonce: string }> {
  const webCrypto = getWebCrypto();
  // Fresh 96-bit (12-byte) cryptographically random nonce per message
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    encoded as BufferSource
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(iv),
  };
}

export async function decryptAesGcm(
  aesKey: CryptoKey,
  ciphertextB64: string,
  nonceB64: string
): Promise<string> {
  const webCrypto = getWebCrypto();
  const iv = base64ToBytes(nonceB64);
  if (iv.byteLength < 12) {
    throw new Error("Invalid AES-GCM nonce length.");
  }
  const data = base64ToBytes(ciphertextB64);
  const decrypted = await webCrypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    data as BufferSource
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptDirectMessage(
  myPrivateKeyJwk: JsonWebKey,
  peerPublicKey: string | JsonWebKey,
  payload: string | Omit<DecryptedMessagePayload, "v">
): Promise<{ ciphertext: string; nonce: string }> {
  const aesKey = await deriveSharedAesKey(myPrivateKeyJwk, peerPublicKey);
  const envelope: DecryptedMessagePayload =
    typeof payload === "string" ? { v: 1, text: payload } : { v: 1, ...payload };
  return encryptAesGcm(aesKey, JSON.stringify(envelope));
}

export async function decryptDirectMessage(
  myPrivateKeyJwk: JsonWebKey,
  peerPublicKey: string | JsonWebKey,
  ciphertextB64: string,
  nonceB64: string
): Promise<DecryptedMessagePayload> {
  const aesKey = await deriveSharedAesKey(myPrivateKeyJwk, peerPublicKey);
  const raw = await decryptAesGcm(aesKey, ciphertextB64, nonceB64);
  try {
    const parsed = JSON.parse(raw) as Partial<DecryptedMessagePayload>;
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      return {
        ...parsed,
        v: 1,
        text: parsed.text,
      };
    }
  } catch {
    // Plain string fallback
  }
  return { v: 1, text: raw };
}

async function deriveBackupAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = 250_000
): Promise<CryptoKey> {
  const webCrypto = getWebCrypto();
  const baseKey = await webCrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return webCrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function exportEncryptedKeyBackup(
  globalId: string,
  publicKeyJwk: JsonWebKey,
  privateKeyJwk: JsonWebKey,
  passphrase: string
): Promise<EncryptedKeyBackupFile> {
  if (passphrase.length < 8) {
    throw new Error("Backup passphrase must be at least 8 characters.");
  }
  const webCrypto = getWebCrypto();
  const iterations = 250_000;
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveBackupAesKey(passphrase, salt, iterations);

  const payload = JSON.stringify({
    globalId,
    publicKeyJwk,
    privateKeyJwk,
  });

  const encrypted = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    new TextEncoder().encode(payload) as BufferSource
  );

  return {
    format: "relaychat-key-backup-v1",
    globalId,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    publicKeyJwk,
  };
}

export async function importEncryptedKeyBackup(
  rawJson: string,
  passphrase: string
): Promise<{
  globalId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}> {
  const webCrypto = getWebCrypto();
  let parsed: EncryptedKeyBackupFile;
  try {
    parsed = JSON.parse(rawJson) as EncryptedKeyBackupFile;
  } catch {
    throw new Error("Invalid key backup file: not valid JSON.");
  }
  if (
    parsed.format !== "relaychat-key-backup-v1" ||
    !parsed.salt ||
    !parsed.iv ||
    !parsed.ciphertext
  ) {
    throw new Error("Unsupported or corrupted RelayChat key backup file.");
  }

  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const ciphertext = base64ToBytes(parsed.ciphertext);
  const aesKey = await deriveBackupAesKey(passphrase, salt, parsed.iterations || 250_000);

  let plaintextBytes: ArrayBuffer;
  try {
    plaintextBytes = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aesKey,
      ciphertext as BufferSource
    );
  } catch {
    throw new Error("Incorrect backup passphrase or tampered backup file.");
  }

  const inner = JSON.parse(new TextDecoder().decode(plaintextBytes)) as {
    globalId: string;
    publicKeyJwk: JsonWebKey;
    privateKeyJwk: JsonWebKey;
  };

  if (!inner.privateKeyJwk?.d || inner.privateKeyJwk.crv !== "P-256") {
    throw new Error("Decrypted backup does not contain a valid P-256 private key.");
  }

  await webCrypto.subtle.importKey(
    "jwk",
    inner.privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  return inner;
}
