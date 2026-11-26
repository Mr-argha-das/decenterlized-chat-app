"use client";

import { getApiBaseUrl } from "@/lib/api/client";
import {
  DEFAULT_FILE_CHUNK_SIZE,
  decryptChunksToBytes,
  encryptBytesWithFileKey,
  encryptFileIntoChunks,
  generateClientThumbnail,
} from "@/lib/crypto/mediaEncryption";
import { EncryptedBlobRef } from "@/mocks";
import { useAuthStore } from "@/store/useAuthStore";

export interface AttachmentInitResponse {
  attachment_id: string;
  chunk_size: number;
  chunk_count: number;
  upload_urls: {
    chunk_index: number;
    upload_url: string;
    expires_at: string;
  }[];
  expires_in_seconds: number;
}

export interface AttachmentCompleteResponse {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  uploader_id: string;
  mime_type: string;
  total_size: number;
  ciphertext_size: number;
  chunk_size: number;
  chunk_count: number;
  sha256_ciphertext: string | null;
  is_complete: boolean;
  download_url: string;
  created_at: string;
}

export interface CompletedClientEncryptedUpload {
  attachmentId: string;
  downloadUrl: string;
  fileKeyB64: string;
  baseNonceB64: string;
  chunkSize: number;
  chunkCount: number;
  encryptedChunkLengths: number[];
  totalSizeBytes: number;
  mimeType: string;
  thumbCiphertext?: string;
  thumbNonce?: string;
  localThumbDataUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

const decryptedCache = new Map<string, { url: string; blob: Blob }>();

function resolveRelativeOrFullUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getApiBaseUrl();
  return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function putRawChunkWithProgress(
  uploadUrl: string,
  chunkBytes: Uint8Array,
  signal: AbortSignal,
  onChunkByteProgress: (loadedBytes: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", resolveRelativeOrFullUrl(uploadUrl), true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onChunkByteProgress(ev.loaded);
      }
    };

    xhr.onload = () => {
      signal.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        onChunkByteProgress(chunkBytes.byteLength);
        resolve();
      } else {
        let msg = `Chunk upload failed (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          msg = parsed?.error?.message || parsed?.detail || msg;
        } catch {
          // ignore
        }
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Network error while uploading encrypted chunk."));
    };

    xhr.send(chunkBytes as unknown as XMLHttpRequestBodyInit);
  });
}

export async function encryptAndUploadAttachment(params: {
  conversationId?: string | null;
  blob: Blob;
  fileName: string;
  mimeType: string;
  chunkSize?: number;
  signal: AbortSignal;
  onStatus?: (status: "encrypting" | "uploading" | "finalizing") => void;
  onProgress?: (percent: number, uploadedChunks: number, totalChunks: number) => void;
}): Promise<CompletedClientEncryptedUpload> {
  const {
    conversationId,
    blob,
    fileName,
    mimeType,
    chunkSize = DEFAULT_FILE_CHUNK_SIZE,
    signal,
    onStatus,
    onProgress,
  } = params;

  const auth = useAuthStore.getState();
  onStatus?.("encrypting");

  const plainBytes = new Uint8Array(await blob.arrayBuffer());
  if (signal.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }

  // 1. Encrypt file into 1 MB chunks with a fresh random AES-256-GCM key
  const encrypted = await encryptFileIntoChunks(plainBytes, { chunkSize });

  // 2. Generate & encrypt thumbnail + encrypt filename so server never sees plaintext metadata
  const thumbInfo = await generateClientThumbnail(blob, mimeType);
  let thumbCiphertext: string | undefined;
  let thumbNonce: string | undefined;
  if (thumbInfo.thumbBytes && thumbInfo.thumbBytes.byteLength > 0) {
    const encThumb = await encryptBytesWithFileKey(
      encrypted.fileKeyB64,
      thumbInfo.thumbBytes
    );
    thumbCiphertext = encThumb.ciphertextB64;
    thumbNonce = encThumb.nonceB64;
  }

  const encFilename = await encryptBytesWithFileKey(
    encrypted.fileKeyB64,
    new TextEncoder().encode(fileName)
  );

  if (signal.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }

  // 3. Request signed upload URLs from node
  const cleanMime = (mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const initRes = await auth.authedRequest<AttachmentInitResponse>("/attachments/init", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: conversationId || null,
      mime_type: cleanMime,
      total_size: plainBytes.byteLength || 1,
      chunk_size: encrypted.chunkSize,
      chunk_count: encrypted.chunkCount,
      file_nonce: encrypted.baseNonceB64,
      encrypted_filename: `${encFilename.nonceB64}.${encFilename.ciphertextB64}`,
      thumbnail_ciphertext: thumbCiphertext || null,
      thumbnail_nonce: thumbNonce || null,
    }),
  });

  const attachmentId = initRes.attachment_id;

  try {
    onStatus?.("uploading");
    let completedCipherBytes = 0;

    for (let i = 0; i < encrypted.chunkCount; i++) {
      const slot = initRes.upload_urls.find((u) => u.chunk_index === i);
      if (!slot) throw new Error(`Missing signed upload URL for chunk ${i}`);

      const chunkData = encrypted.encryptedChunks[i];
      await putRawChunkWithProgress(slot.upload_url, chunkData, signal, (inChunkLoaded) => {
        const currentTotal = completedCipherBytes + inChunkLoaded;
        const pct = Math.min(
          99,
          Math.round((currentTotal / Math.max(1, encrypted.totalCipherSize)) * 100)
        );
        onProgress?.(pct, i, encrypted.chunkCount);
      });

      completedCipherBytes += chunkData.byteLength;
      const pctAfter = Math.min(
        99,
        Math.round((completedCipherBytes / Math.max(1, encrypted.totalCipherSize)) * 100)
      );
      onProgress?.(pctAfter, i + 1, encrypted.chunkCount);
    }

    onStatus?.("finalizing");
    const completed = await auth.authedRequest<AttachmentCompleteResponse>(
      `/attachments/${attachmentId}/complete`,
      { method: "POST" }
    );
    onProgress?.(100, encrypted.chunkCount, encrypted.chunkCount);

    // Pre-seed local decrypted cache so sender sees instant playback without re-downloading!
    const localUrl = URL.createObjectURL(blob);
    decryptedCache.set(attachmentId, { url: localUrl, blob });

    return {
      attachmentId,
      downloadUrl: completed.download_url,
      fileKeyB64: encrypted.fileKeyB64,
      baseNonceB64: encrypted.baseNonceB64,
      chunkSize: encrypted.chunkSize,
      chunkCount: encrypted.chunkCount,
      encryptedChunkLengths: encrypted.encryptedChunkLengths,
      totalSizeBytes: plainBytes.byteLength,
      mimeType: cleanMime,
      thumbCiphertext,
      thumbNonce,
      localThumbDataUrl: thumbInfo.thumbDataUrl,
      width: thumbInfo.width,
      height: thumbInfo.height,
      durationSec: thumbInfo.durationSec,
    };
  } catch (err) {
    // Clean up partial staged chunks on cancel or failure
    auth
      .authedRequest(`/attachments/${attachmentId}`, { method: "DELETE" })
      .catch(() => undefined);
    throw err;
  }
}

export async function fetchAndDecryptAttachmentBlob(
  ref: EncryptedBlobRef
): Promise<{ url: string; blob: Blob }> {
  const cached = decryptedCache.get(ref.attachmentId);
  if (cached) return cached;

  const auth = useAuthStore.getState();
  const targetPath = ref.downloadUrl || `/attachments/${ref.attachmentId}/download`;
  const headers: Record<string, string> = {};
  if (auth.accessToken) {
    headers["Authorization"] = `Bearer ${auth.accessToken}`;
  }

  const resp = await fetch(resolveRelativeOrFullUrl(targetPath), {
    method: "GET",
    headers,
    credentials: "include",
  });

  if (!resp.ok) {
    throw new Error(`Failed to download encrypted blob (${resp.status})`);
  }

  const assembledCipher = new Uint8Array(await resp.arrayBuffer());
  const decryptedBytes = await decryptChunksToBytes(assembledCipher, {
    fileKeyB64: ref.fileKeyB64,
    baseNonceB64: ref.baseNonceB64,
    chunkSize: ref.chunkSize,
    chunkCount: ref.chunkCount,
    encryptedChunkLengths: ref.encryptedChunkLengths,
  });

  const blob = new Blob([decryptedBytes as BlobPart], {
    type: ref.mimeType || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  decryptedCache.set(ref.attachmentId, { url, blob });
  return { url, blob };
}
