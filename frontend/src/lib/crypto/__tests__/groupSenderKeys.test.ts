import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateIdentityKeyPair } from "../e2ee.ts";
import {
  buildSenderKeyEnvelopesForRoster,
  decryptGroupMessageWithSenderKey,
  encryptGroupMessageWithSenderKey,
  generateGroupSenderKey,
  unwrapSenderKeyFromMember,
} from "../groupSenderKeys.ts";

describe("Phase 7 Group Sender Keys E2EE & Key Rotation After Member Removal", () => {
  it("distributes Sender Keys across 3+ members and prevents a removed member from decrypting post-rotation messages", async () => {
    const rahul = await generateIdentityKeyPair();
    const priya = await generateIdentityKeyPair();
    const amit = await generateIdentityKeyPair();

    const groupId = "grp-india-ops-001";

    // --- KEY VERSION 1: Rahul, Priya, and Amit are all in the group ---
    const rahulSenderKeyV1 = await generateGroupSenderKey();
    const envelopesV1 = await buildSenderKeyEnvelopesForRoster({
      groupId,
      keyVersion: 1,
      senderPrivateKeyJwk: rahul.privateKeyJwk,
      senderKeyB64: rahulSenderKeyV1,
      members: [
        { userId: "rahul", publicKey: rahul.publicKeySerialized },
        { userId: "priya", publicKey: priya.publicKeySerialized },
        { userId: "amit", publicKey: amit.publicKeySerialized },
      ],
    });
    assert.equal(envelopesV1.length, 3);

    const msgV1 = await encryptGroupMessageWithSenderKey({
      groupId,
      senderId: "rahul",
      keyVersion: 1,
      senderKeyB64: rahulSenderKeyV1,
      payload: { text: "Welcome @priya and @amit to the group!" },
    });

    // Both Priya and Amit unwrap v1 and decrypt msgV1
    const priyaEnvV1 = envelopesV1.find((e) => e.recipient_id === "priya")!;
    const amitEnvV1 = envelopesV1.find((e) => e.recipient_id === "amit")!;

    const priyaUnwrappedV1 = await unwrapSenderKeyFromMember({
      groupId,
      keyVersion: 1,
      recipientPrivateKeyJwk: priya.privateKeyJwk,
      senderPublicKey: rahul.publicKeySerialized,
      wrappedKeyB64: priyaEnvV1.wrapped_key,
      nonceB64: priyaEnvV1.nonce,
    });
    const amitUnwrappedV1 = await unwrapSenderKeyFromMember({
      groupId,
      keyVersion: 1,
      recipientPrivateKeyJwk: amit.privateKeyJwk,
      senderPublicKey: rahul.publicKeySerialized,
      wrappedKeyB64: amitEnvV1.wrapped_key,
      nonceB64: amitEnvV1.nonce,
    });

    const priyaDecV1 = await decryptGroupMessageWithSenderKey({
      groupId,
      senderId: "rahul",
      keyVersion: 1,
      senderKeyB64: priyaUnwrappedV1,
      ciphertextB64: msgV1.ciphertext,
      nonceB64: msgV1.nonce,
    });
    const amitDecV1 = await decryptGroupMessageWithSenderKey({
      groupId,
      senderId: "rahul",
      keyVersion: 1,
      senderKeyB64: amitUnwrappedV1,
      ciphertextB64: msgV1.ciphertext,
      nonceB64: msgV1.nonce,
    });
    assert.equal(priyaDecV1.text, "Welcome @priya and @amit to the group!");
    assert.equal(amitDecV1.text, "Welcome @priya and @amit to the group!");

    // --- KEY ROTATION TO VERSION 2: Amit is REMOVED from the group! ---
    const rahulSenderKeyV2 = await generateGroupSenderKey();
    assert.notEqual(rahulSenderKeyV2, rahulSenderKeyV1);

    const envelopesV2 = await buildSenderKeyEnvelopesForRoster({
      groupId,
      keyVersion: 2,
      senderPrivateKeyJwk: rahul.privateKeyJwk,
      senderKeyB64: rahulSenderKeyV2,
      members: [
        { userId: "rahul", publicKey: rahul.publicKeySerialized },
        { userId: "priya", publicKey: priya.publicKeySerialized },
      ],
    });
    assert.equal(
      envelopesV2.some((e) => e.recipient_id === "amit"),
      false,
      "Removed member Amit must receive NO v2 envelope"
    );

    const msgV2 = await encryptGroupMessageWithSenderKey({
      groupId,
      senderId: "rahul",
      keyVersion: 2,
      senderKeyB64: rahulSenderKeyV2,
      payload: { text: "Post-removal confidential launch plan (v2 only)" },
    });

    // Priya unwraps v2 and reads msgV2 cleanly
    const priyaEnvV2 = envelopesV2.find((e) => e.recipient_id === "priya")!;
    const priyaUnwrappedV2 = await unwrapSenderKeyFromMember({
      groupId,
      keyVersion: 2,
      recipientPrivateKeyJwk: priya.privateKeyJwk,
      senderPublicKey: rahul.publicKeySerialized,
      wrappedKeyB64: priyaEnvV2.wrapped_key,
      nonceB64: priyaEnvV2.nonce,
    });
    const priyaDecV2 = await decryptGroupMessageWithSenderKey({
      groupId,
      senderId: "rahul",
      keyVersion: 2,
      senderKeyB64: priyaUnwrappedV2,
      ciphertextB64: msgV2.ciphertext,
      nonceB64: msgV2.nonce,
    });
    assert.equal(priyaDecV2.text, "Post-removal confidential launch plan (v2 only)");

    // Removed Amit CANNOT decrypt msgV2 using his old v1 sender key...
    await assert.rejects(() =>
      decryptGroupMessageWithSenderKey({
        groupId,
        senderId: "rahul",
        keyVersion: 2,
        senderKeyB64: amitUnwrappedV1,
        ciphertextB64: msgV2.ciphertext,
        nonceB64: msgV2.nonce,
      })
    );

    // ...AND Amit CANNOT unwrap Priya's v2 envelope even if he intercepts it!
    await assert.rejects(() =>
      unwrapSenderKeyFromMember({
        groupId,
        keyVersion: 2,
        recipientPrivateKeyJwk: amit.privateKeyJwk,
        senderPublicKey: rahul.publicKeySerialized,
        wrappedKeyB64: priyaEnvV2.wrapped_key,
        nonceB64: priyaEnvV2.nonce,
      })
    );
  });

  it("binds senderId and keyVersion into AAD so sender spoofing and version downgrade fail", async () => {
    const senderKey = await generateGroupSenderKey();
    const enc = await encryptGroupMessageWithSenderKey({
      groupId: "grp-1",
      senderId: "user-a",
      keyVersion: 3,
      senderKeyB64: senderKey,
      payload: "Authentic message from user-a",
    });

    // Spoofing senderId ("user-b") fails AAD verification
    await assert.rejects(() =>
      decryptGroupMessageWithSenderKey({
        groupId: "grp-1",
        senderId: "user-b",
        keyVersion: 3,
        senderKeyB64: senderKey,
        ciphertextB64: enc.ciphertext,
        nonceB64: enc.nonce,
      })
    );

    // Replaying as keyVersion 2 fails AAD verification
    await assert.rejects(() =>
      decryptGroupMessageWithSenderKey({
        groupId: "grp-1",
        senderId: "user-a",
        keyVersion: 2,
        senderKeyB64: senderKey,
        ciphertextB64: enc.ciphertext,
        nonceB64: enc.nonce,
      })
    );
  });
});
