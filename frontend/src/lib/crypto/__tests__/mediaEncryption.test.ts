import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decryptDirectMessage,
  encryptDirectMessage,
  generateIdentityKeyPair,
} from "../e2ee.ts";
import {
  AES_GCM_TAG_BYTES,
  DEFAULT_FILE_CHUNK_SIZE,
  decryptBytesWithFileKey,
  decryptChunksToBytes,
  deriveChunkIv,
  encryptBytesWithFileKey,
  encryptFileIntoChunks,
  generateRandomFileKeyMaterial,
} from "../mediaEncryption.ts";

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

describe("Phase 5 Chunked Per-File AES-256-GCM Media Encryption", () => {
  it("encrypts a 2.6 MB multi-chunk binary file into 1 MB AES-GCM chunks and decrypts byte-for-byte", async () => {
    // 2.6 MB payload (> 2 full 1 MB chunks + partial 3rd chunk) with recognizable marker header
    const size = Math.floor(2.6 * DEFAULT_FILE_CHUNK_SIZE);
    const plain = new Uint8Array(size);
    const marker = new TextEncoder().encode("SECRET-PDF-HEADER-%PDF-1.7-RELAYCHAT-E2EE");
    plain.set(marker, 0);
    for (let i = marker.byteLength; i < size; i++) {
      plain[i] = (i * 131 + 17) & 0xff;
    }

    const encrypted = await encryptFileIntoChunks(plain);
    assert.equal(encrypted.chunkSize, DEFAULT_FILE_CHUNK_SIZE);
    assert.equal(encrypted.chunkCount, 3);
    assert.equal(encrypted.encryptedChunks.length, 3);
    assert.equal(
      encrypted.totalCipherSize,
      size + 3 * AES_GCM_TAG_BYTES
    );

    const assembledBlob = concatChunks(encrypted.encryptedChunks);

    // Server-side blob must NOT contain plaintext marker bytes
    const blobAsLatin1 = Buffer.from(assembledBlob).toString("latin1");
    assert.equal(
      blobAsLatin1.includes("SECRET-PDF-HEADER-%PDF-1.7"),
      false,
      "Plaintext marker leaked into encrypted blob"
    );

    // Decrypt without explicit chunk lengths (standard 1 MB geometry) AND with explicit chunk lengths
    const recoveredFromGeometry = await decryptChunksToBytes(assembledBlob, {
      fileKeyB64: encrypted.fileKeyB64,
      baseNonceB64: encrypted.baseNonceB64,
      chunkSize: encrypted.chunkSize,
      chunkCount: encrypted.chunkCount,
    });
    assert.deepEqual(recoveredFromGeometry, plain);

    const recoveredWithLengths = await decryptChunksToBytes(assembledBlob, {
      fileKeyB64: encrypted.fileKeyB64,
      baseNonceB64: encrypted.baseNonceB64,
      chunkSize: encrypted.chunkSize,
      chunkCount: encrypted.chunkCount,
      encryptedChunkLengths: encrypted.encryptedChunkLengths,
    });
    assert.deepEqual(recoveredWithLengths, plain);
  });

  it("generates distinct random keys/nonces per file and derives unique per-chunk IVs", async () => {
    const sample = new TextEncoder().encode("Identical attachment bytes across two sends");
    const encA = await encryptFileIntoChunks(sample, { chunkSize: 16 });
    const encB = await encryptFileIntoChunks(sample, { chunkSize: 16 });

    assert.notEqual(encA.fileKeyB64, encB.fileKeyB64);
    assert.notEqual(encA.baseNonceB64, encB.baseNonceB64);
    assert.notDeepEqual(
      concatChunks(encA.encryptedChunks),
      concatChunks(encB.encryptedChunks)
    );

    const base = new Uint8Array(12).fill(0xaa);
    const iv0 = deriveChunkIv(base, 0);
    const iv1 = deriveChunkIv(base, 1);
    const iv2 = deriveChunkIv(base, 2);
    assert.deepEqual(iv0, base);
    assert.notDeepEqual(iv0, iv1);
    assert.notDeepEqual(iv1, iv2);
  });

  it("rejects bit-flips, swapped chunk order, truncated chunks, and wrong file keys", async () => {
    const plain = new Uint8Array(96);
    for (let i = 0; i < plain.length; i++) plain[i] = i;

    const enc = await encryptFileIntoChunks(plain, { chunkSize: 32 });
    assert.equal(enc.chunkCount, 3);

    // 1. Flip a single bit inside chunk 1
    const bitFlipped = concatChunks(enc.encryptedChunks);
    bitFlipped[50] ^= 0x01;
    await assert.rejects(() =>
      decryptChunksToBytes(bitFlipped, {
        fileKeyB64: enc.fileKeyB64,
        baseNonceB64: enc.baseNonceB64,
        chunkSize: 32,
        chunkCount: 3,
      })
    );

    // 2. Swap chunk 0 and chunk 1 (same lengths, valid individual tags, wrong index AAD/IV!)
    const reordered = concatChunks([
      enc.encryptedChunks[1],
      enc.encryptedChunks[0],
      enc.encryptedChunks[2],
    ]);
    await assert.rejects(() =>
      decryptChunksToBytes(reordered, {
        fileKeyB64: enc.fileKeyB64,
        baseNonceB64: enc.baseNonceB64,
        chunkSize: 32,
        chunkCount: 3,
      })
    );

    // 3. Truncate final chunk (drop chunk 2 and claim chunkCount = 2 -> fails AAD "0/3" vs "0/2"!)
    const truncatedTwoChunks = concatChunks([
      enc.encryptedChunks[0],
      enc.encryptedChunks[1],
    ]);
    await assert.rejects(() =>
      decryptChunksToBytes(truncatedTwoChunks, {
        fileKeyB64: enc.fileKeyB64,
        baseNonceB64: enc.baseNonceB64,
        chunkSize: 32,
        chunkCount: 2,
      })
    );

    // 4. Wrong per-file key
    const wrongKey = await generateRandomFileKeyMaterial();
    await assert.rejects(() =>
      decryptChunksToBytes(concatChunks(enc.encryptedChunks), {
        fileKeyB64: wrongKey.fileKeyB64,
        baseNonceB64: enc.baseNonceB64,
        chunkSize: 32,
        chunkCount: 3,
      })
    );
  });

  it("transports file key, encrypted thumbnail, and chunk metadata inside an Alice->Bob E2EE message", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();

    const voicePlain = new TextEncoder().encode("RIFF-OPUS-VOICE-FRAME-PAYLOAD-0123456789");
    const encFile = await encryptFileIntoChunks(voicePlain, { chunkSize: 20 });

    const fakeThumbJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const encThumb = await encryptBytesWithFileKey(encFile.fileKeyB64, fakeThumbJpeg);

    const wireEnvelope = await encryptDirectMessage(
      alice.privateKeyJwk,
      bob.publicKeySerialized,
      {
        text: "Voice message",
        attachmentId: "att-1234",
        fileKeyB64: encFile.fileKeyB64,
        baseNonceB64: encFile.baseNonceB64,
        chunkSize: encFile.chunkSize,
        chunkCount: encFile.chunkCount,
        encryptedChunkLengths: encFile.encryptedChunkLengths,
        totalSizeBytes: encFile.totalCipherSize,
        fileName: "voice-note.webm",
        mimeType: "audio/webm",
        durationSec: 6,
        waveform: [0.25, 0.7, 0.9, 0.4],
        thumbCiphertext: encThumb.ciphertextB64,
        thumbNonce: encThumb.nonceB64,
      }
    );

    const bobDecryptedMsg = await decryptDirectMessage(
      bob.privateKeyJwk,
      alice.publicKeySerialized,
      wireEnvelope.ciphertext,
      wireEnvelope.nonce
    );

    assert.equal(bobDecryptedMsg.attachmentId, "att-1234");
    assert.equal(bobDecryptedMsg.fileName, "voice-note.webm");
    assert.deepEqual(bobDecryptedMsg.waveform, [0.25, 0.7, 0.9, 0.4]);

    const bobRecoveredThumb = await decryptBytesWithFileKey(
      bobDecryptedMsg.fileKeyB64!,
      bobDecryptedMsg.thumbCiphertext!,
      bobDecryptedMsg.thumbNonce!
    );
    assert.deepEqual(bobRecoveredThumb, fakeThumbJpeg);

    const bobRecoveredVoice = await decryptChunksToBytes(
      concatChunks(encFile.encryptedChunks),
      {
        fileKeyB64: bobDecryptedMsg.fileKeyB64!,
        baseNonceB64: bobDecryptedMsg.baseNonceB64!,
        chunkSize: bobDecryptedMsg.chunkSize!,
        chunkCount: bobDecryptedMsg.chunkCount!,
        encryptedChunkLengths: bobDecryptedMsg.encryptedChunkLengths,
      }
    );
    assert.deepEqual(bobRecoveredVoice, voicePlain);
  });
});
