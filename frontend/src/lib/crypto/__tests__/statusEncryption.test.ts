import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentityKeyPair } from "../e2ee.ts";
import {
  decryptStatusForViewer,
  encryptStatusForRecipients,
} from "../statusEncryption.ts";

test("Status E2EE encrypts once for chosen contacts and rejects excluded contacts", async () => {
  const alice = await generateIdentityKeyPair();
  const bob = await generateIdentityKeyPair();
  const eve = await generateIdentityKeyPair();

  const encrypted = await encryptStatusForRecipients({
    authorUserId: "alice-uuid",
    authorPrivateKeyJwk: alice.privateKeyJwk,
    authorPublicKeyJwk: alice.publicKeyJwk,
    recipients: [{ userId: "bob-uuid", publicKey: bob.publicKeySerialized }],
    payload: {
      kind: "text",
      text: "24hr E2EE story from Jaipur",
      fontFamily: "serif",
      backgroundStyle: "linear-gradient(135deg, #00a884 0%, #0f172a 100%)",
    },
  });

  assert.ok(encrypted.keyEnvelopes["alice-uuid"]);
  assert.ok(encrypted.keyEnvelopes["bob-uuid"]);
  assert.equal(encrypted.keyEnvelopes["eve-uuid"], undefined);

  // Bob decrypts cleanly
  const bobDecrypted = await decryptStatusForViewer({
    viewerUserId: "bob-uuid",
    viewerPrivateKeyJwk: bob.privateKeyJwk,
    authorPublicKey: alice.publicKeySerialized,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    myKeyEnvelope: encrypted.keyEnvelopes["bob-uuid"],
  });
  assert.equal(bobDecrypted.text, "24hr E2EE story from Jaipur");
  assert.equal(bobDecrypted.fontFamily, "serif");

  // Author decrypts own status cleanly
  const aliceDecrypted = await decryptStatusForViewer({
    viewerUserId: "alice-uuid",
    viewerPrivateKeyJwk: alice.privateKeyJwk,
    authorPublicKey: alice.publicKeySerialized,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    myKeyEnvelope: encrypted.keyEnvelopes["alice-uuid"],
  });
  assert.equal(aliceDecrypted.text, "24hr E2EE story from Jaipur");

  // Eve cannot unwrap Bob's envelope
  await assert.rejects(() =>
    decryptStatusForViewer({
      viewerUserId: "bob-uuid",
      viewerPrivateKeyJwk: eve.privateKeyJwk,
      authorPublicKey: alice.publicKeySerialized,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      myKeyEnvelope: encrypted.keyEnvelopes["bob-uuid"],
    })
  );
});
