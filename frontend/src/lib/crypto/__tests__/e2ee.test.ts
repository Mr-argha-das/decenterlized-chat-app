import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64ToBytes,
  bytesToBase64,
  computeKeyFingerprint,
  decryptDirectMessage,
  encryptDirectMessage,
  exportEncryptedKeyBackup,
  generateIdentityKeyPair,
  importEncryptedKeyBackup,
} from "../e2ee.ts";

describe("RelayChat E2EE Crypto Module (ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM)", () => {
  it("derives identical shared AES-GCM keys between Alice and Bob and decrypts bidirectionally", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();

    // Public serialized JSON never contains private parameter `d`
    assert.equal(alice.publicKeySerialized.includes('"d"'), false);
    assert.equal(bob.publicKeySerialized.includes('"d"'), false);

    const secretMessage = "Namaste Bob! Meet at Hawa Mahal at 18:30 — strictly E2EE 🔒";
    const encrypted = await encryptDirectMessage(
      alice.privateKeyJwk,
      bob.publicKeySerialized,
      secretMessage
    );

    // Ciphertext must never expose plaintext
    assert.equal(encrypted.ciphertext.includes("Hawa Mahal"), false);
    assert.equal(base64ToBytes(encrypted.nonce).byteLength, 12);

    // Bob decrypts using his private key + Alice's public key
    const decryptedByBob = await decryptDirectMessage(
      bob.privateKeyJwk,
      alice.publicKeySerialized,
      encrypted.ciphertext,
      encrypted.nonce
    );
    assert.equal(decryptedByBob.text, secretMessage);

    // Alice can also decrypt her own sent message from history using her private key + Bob's public key
    const decryptedByAlice = await decryptDirectMessage(
      alice.privateKeyJwk,
      bob.publicKeySerialized,
      encrypted.ciphertext,
      encrypted.nonce
    );
    assert.equal(decryptedByAlice.text, secretMessage);
  });

  it("generates a unique random 96-bit nonce and distinct ciphertext for every message", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();

    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();

    for (let i = 0; i < 64; i++) {
      const { ciphertext, nonce } = await encryptDirectMessage(
        alice.privateKeyJwk,
        bob.publicKeyJwk,
        "Identical repeated message"
      );
      nonces.add(nonce);
      ciphertexts.add(ciphertext);
    }

    assert.equal(nonces.size, 64);
    assert.equal(ciphertexts.size, 64);
  });

  it("rejects tampered ciphertext or third-party eavesdropper decryption", async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const mallory = await generateIdentityKeyPair();

    const { ciphertext, nonce } = await encryptDirectMessage(
      alice.privateKeyJwk,
      bob.publicKeyJwk,
      "Top secret node coordinates"
    );

    // Mallory cannot decrypt with her private key
    await assert.rejects(async () => {
      await decryptDirectMessage(
        mallory.privateKeyJwk,
        alice.publicKeyJwk,
        ciphertext,
        nonce
      );
    });

    // Flip 1 bit in ciphertext -> AES-GCM authentication tag must fail
    const raw = base64ToBytes(ciphertext);
    raw[0] ^= 0x01;
    const tamperedCiphertext = bytesToBase64(raw);

    await assert.rejects(async () => {
      await decryptDirectMessage(
        bob.privateKeyJwk,
        alice.publicKeyJwk,
        tamperedCiphertext,
        nonce
      );
    });
  });

  it("exports and restores PBKDF2-SHA256 + AES-256-GCM key backups and computes safety numbers", async () => {
    const identity = await generateIdentityKeyPair();
    const fp1 = await computeKeyFingerprint(identity.publicKeySerialized);
    const fp2 = await computeKeyFingerprint(identity.publicKeyJwk);
    assert.equal(fp1, fp2);
    assert.equal(fp1.split(" ").length, 8);

    const backup = await exportEncryptedKeyBackup(
      "rahul@chatapp.in",
      identity.publicKeyJwk,
      identity.privateKeyJwk,
      "StrongPassphrase!99"
    );
    const restored = await importEncryptedKeyBackup(
      JSON.stringify(backup),
      "StrongPassphrase!99"
    );
    assert.equal(restored.globalId, "rahul@chatapp.in");
    assert.equal(restored.privateKeyJwk.d, identity.privateKeyJwk.d);
  });
});
