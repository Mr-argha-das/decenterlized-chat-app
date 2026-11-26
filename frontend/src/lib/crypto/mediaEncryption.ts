/**
 * Phase 5 Chunked Per-File AES-256-GCM Media Encryption & Decryption
 * - Random 256-bit AES-GCM key + 96-bit base nonce generated per file on the client.
 * - Splits files into 1 MB chunks (configurable) and binds each chunk index + total chunk count
 *   into both a deterministic per-chunk IV XOR and AES-GCM Additional Authenticated Data (AAD),
 *   preventing chunk reordering, truncation, or cross-file splicing.
 * - Server receives and stores ONLY encrypted ciphertext blobs; file keys travel inside E2EE messages.
 */

import { base64ToBytes, bytesToBase64 } from "./e2ee.ts";

export const DEFAULT_FILE_CHUNK_SIZE = 1_048_576; // 1 MB
export const AES_GCM_TAG_BYTES = 16;
export const MAX_ATTACHMENT_SIZE_BYTES = 104_857_600; // 100 MB

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API is required for media encryption.");
}

export function formatHumanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function generateRandomFileKeyMaterial(): Promise<{
  fileKeyB64: string;
  baseNonceB64: string;
}> {
  const webCrypto = getWebCrypto();
  const rawKey = webCrypto.getRandomValues(new Uint8Array(32));
  const baseNonce = webCrypto.getRandomValues(new Uint8Array(12));
  return {
    fileKeyB64: bytesToBase64(rawKey),
    baseNonceB64: bytesToBase64(baseNonce),
  };
}

async function importRawAesGcmKey(
  fileKeyB64: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const webCrypto = getWebCrypto();
  const raw = base64ToBytes(fileKeyB64);
  if (raw.byteLength !== 32) {
    throw new Error("Per-file AES-GCM key must be 256 bits (32 bytes).");
  }
  return webCrypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

/**
 * Derives a unique 12-byte IV for `chunkIndex` by XORing the big-endian 32-bit chunk counter
 * into the last 4 bytes of the random 12-byte `baseNonce`.
 */
export function deriveChunkIv(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
  if (baseNonce.byteLength !== 12) {
    throw new Error("Base file nonce must be exactly 12 bytes.");
  }
  const iv = new Uint8Array(baseNonce);
  const c = chunkIndex >>> 0;
  iv[8] ^= (c >>> 24) & 0xff;
  iv[9] ^= (c >>> 16) & 0xff;
  iv[10] ^= (c >>> 8) & 0xff;
  iv[11] ^= c & 0xff;
  return iv;
}

export function buildChunkAad(chunkIndex: number, chunkCount: number): Uint8Array {
  return new TextEncoder().encode(`RelayChat-FileChunk-v1|${chunkIndex}/${chunkCount}`);
}

export interface EncryptedChunkedFileResult {
  fileKeyB64: string;
  baseNonceB64: string;
  chunkSize: number;
  chunkCount: number;
  encryptedChunks: Uint8Array[];
  encryptedChunkLengths: number[];
  totalPlainSize: number;
  totalCipherSize: number;
}

/**
 * Encrypts `plainBytes` into `chunkSize` (default 1 MB) AES-256-GCM chunks using a random per-file key.
 */
export async function encryptFileIntoChunks(
  plainBytes: Uint8Array,
  options?: {
    chunkSize?: number;
    fileKeyB64?: string;
    baseNonceB64?: string;
  }
): Promise<EncryptedChunkedFileResult> {
  const webCrypto = getWebCrypto();
  const chunkSize = options?.chunkSize ?? DEFAULT_FILE_CHUNK_SIZE;
  if (chunkSize < 16) {
    throw new Error("chunkSize must be at least 16 bytes.");
  }

  const generated =
    options?.fileKeyB64 && options?.baseNonceB64
      ? { fileKeyB64: options.fileKeyB64, baseNonceB64: options.baseNonceB64 }
      : await generateRandomFileKeyMaterial();

  const aesKey = await importRawAesGcmKey(generated.fileKeyB64, ["encrypt"]);
  const baseNonce = base64ToBytes(generated.baseNonceB64);

  const totalPlainSize = plainBytes.byteLength;
  const chunkCount = Math.max(1, Math.ceil(totalPlainSize / chunkSize));
  const encryptedChunks: Uint8Array[] = [];
  const encryptedChunkLengths: number[] = [];
  let totalCipherSize = 0;

  for (let idx = 0; idx < chunkCount; idx++) {
    const start = idx * chunkSize;
    const end = Math.min(totalPlainSize, start + chunkSize);
    const slice = plainBytes.subarray(start, end);
    const iv = deriveChunkIv(baseNonce, idx);
    const aad = buildChunkAad(idx, chunkCount);

    const ctBuf = await webCrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
      },
      aesKey,
      slice as BufferSource
    );
    const ctBytes = new Uint8Array(ctBuf);
    encryptedChunks.push(ctBytes);
    encryptedChunkLengths.push(ctBytes.byteLength);
    totalCipherSize += ctBytes.byteLength;
  }

  return {
    fileKeyB64: generated.fileKeyB64,
    baseNonceB64: generated.baseNonceB64,
    chunkSize,
    chunkCount,
    encryptedChunks,
    encryptedChunkLengths,
    totalPlainSize,
    totalCipherSize,
  };
}

/**
 * Reassembles & authenticates an encrypted blob back into exact plaintext bytes.
 * Fails immediately if any byte, chunk order, or chunk count was tampered with.
 */
export async function decryptChunksToBytes(
  assembledCiphertext: Uint8Array,
  params: {
    fileKeyB64: string;
    baseNonceB64: string;
    chunkSize: number;
    chunkCount: number;
    encryptedChunkLengths?: number[];
  }
): Promise<Uint8Array> {
  const webCrypto = getWebCrypto();
  const aesKey = await importRawAesGcmKey(params.fileKeyB64, ["decrypt"]);
  const baseNonce = base64ToBytes(params.baseNonceB64);
  const { chunkCount, chunkSize, encryptedChunkLengths } = params;

  if (chunkCount < 1) {
    throw new Error("Invalid chunkCount.");
  }

  const decryptedSlices: Uint8Array[] = [];
  let offset = 0;
  let totalPlain = 0;

  for (let idx = 0; idx < chunkCount; idx++) {
    let ctLen: number;
    if (encryptedChunkLengths && encryptedChunkLengths.length === chunkCount) {
      ctLen = encryptedChunkLengths[idx];
    } else if (idx < chunkCount - 1) {
      ctLen = chunkSize + AES_GCM_TAG_BYTES;
    } else {
      ctLen = assembledCiphertext.byteLength - offset;
    }

    if (ctLen < AES_GCM_TAG_BYTES || offset + ctLen > assembledCiphertext.byteLength) {
      throw new Error(`Corrupted or truncated encrypted chunk at index ${idx}.`);
    }

    const ctSlice = assembledCiphertext.subarray(offset, offset + ctLen);
    offset += ctLen;

    const iv = deriveChunkIv(baseNonce, idx);
    const aad = buildChunkAad(idx, chunkCount);

    const plainBuf = await webCrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
      },
      aesKey,
      ctSlice as BufferSource
    );
    const plainChunk = new Uint8Array(plainBuf);
    decryptedSlices.push(plainChunk);
    totalPlain += plainChunk.byteLength;
  }

  if (offset !== assembledCiphertext.byteLength) {
    throw new Error("Trailing unauthenticated bytes detected in encrypted blob.");
  }

  const output = new Uint8Array(totalPlain);
  let writePos = 0;
  for (const part of decryptedSlices) {
    output.set(part, writePos);
    writePos += part.byteLength;
  }
  return output;
}

export async function encryptBytesWithFileKey(
  fileKeyB64: string,
  plainBytes: Uint8Array
): Promise<{ ciphertextB64: string; nonceB64: string }> {
  const webCrypto = getWebCrypto();
  const aesKey = await importRawAesGcmKey(fileKeyB64, ["encrypt"]);
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const ct = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    plainBytes as BufferSource
  );
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(ct)),
    nonceB64: bytesToBase64(iv),
  };
}

export async function decryptBytesWithFileKey(
  fileKeyB64: string,
  ciphertextB64: string,
  nonceB64: string
): Promise<Uint8Array> {
  const webCrypto = getWebCrypto();
  const aesKey = await importRawAesGcmKey(fileKeyB64, ["decrypt"]);
  const iv = base64ToBytes(nonceB64);
  const ct = base64ToBytes(ciphertextB64);
  const plain = await webCrypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    ct as BufferSource
  );
  return new Uint8Array(plain);
}

/**
 * Client-side thumbnail & dimension extractor for images and videos.
 * Runs exclusively inside the user's browser before encryption.
 */
export async function generateClientThumbnail(file: Blob, mimeType: string): Promise<{
  thumbBytes?: Uint8Array;
  thumbDataUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}> {
  if (typeof document === "undefined") {
    return {};
  }

  const cleanMime = mimeType.split(";")[0].trim().toLowerCase();

  if (cleanMime.startsWith("image/")) {
    const objUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image decode failed"));
        el.src = objUrl;
      });
      const width = img.naturalWidth || 640;
      const height = img.naturalHeight || 480;
      const maxDim = 280;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const tw = Math.max(1, Math.round(width * scale));
      const th = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { width, height };
      ctx.drawImage(img, 0, 0, tw, th);

      const thumbDataUrl = canvas.toDataURL("image/jpeg", 0.76);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), "image/jpeg", 0.76)
      );
      const thumbBytes = blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
      return { thumbBytes, thumbDataUrl, width, height };
    } catch {
      return {};
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  if (cleanMime.startsWith("video/")) {
    const objUrl = URL.createObjectURL(file);
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = objUrl;

      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Video metadata timeout")), 4000);
        video.onloadeddata = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error("Video decode error"));
        };
      });

      const durationSec = Number.isFinite(video.duration) ? Math.round(video.duration) : undefined;
      const seekTo = durationSec && durationSec > 1 ? 0.2 : 0;
      if (seekTo > 0) {
        video.currentTime = seekTo;
        await new Promise<void>((res) => {
          const t = window.setTimeout(res, 600);
          video.onseeked = () => {
            window.clearTimeout(t);
            res();
          };
        });
      }

      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const maxDim = 300;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const tw = Math.max(1, Math.round(width * scale));
      const th = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { width, height, durationSec };
      ctx.drawImage(video, 0, 0, tw, th);

      const thumbDataUrl = canvas.toDataURL("image/jpeg", 0.76);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), "image/jpeg", 0.76)
      );
      const thumbBytes = blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
      return { thumbBytes, thumbDataUrl, width, height, durationSec };
    } catch {
      return {};
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  return {};
}
