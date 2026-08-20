import { describe, expect, it } from "vitest";
import {
  decryptSendblueInboxPayload,
  deriveSendblueInboxCapability,
  encryptSendblueInboxPayload,
  digestSendblueInboxPayload,
} from "../server/sendblue-inbox-crypto.js";

describe("Sendblue inbox encryption", () => {
  it("round-trips an authenticated payload without exposing plaintext", () => {
    const payload = {
      content: "private inbound text",
      fromNumber: "+15550000101",
      rawUrls: ["https://cdn.example/private.png"],
    };
    const encrypted = encryptSendblueInboxPayload(payload, "handle-1", "test-secret");

    expect(encrypted).not.toContain(payload.content);
    expect(encrypted).not.toContain(payload.fromNumber);
    expect(decryptSendblueInboxPayload(encrypted, "handle-1", "test-secret")).toEqual(payload);
  });

  it("rejects tampered payloads and the wrong secret", () => {
    const encrypted = encryptSendblueInboxPayload(
      { content: "hello", fromNumber: "+15550000101", rawUrls: [] },
      "handle-1",
      "correct-secret",
    );
    const [version, iv, tag, ciphertext] = encrypted.split(".") as [string, string, string, string];
    const tampered = `${version}.${iv}.${tag}.${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;

    expect(() => decryptSendblueInboxPayload(encrypted, "handle-1", "wrong-secret")).toThrow();
    expect(() => decryptSendblueInboxPayload(tampered, "handle-1", "correct-secret")).toThrow();
    expect(() => decryptSendblueInboxPayload(encrypted, "handle-2", "correct-secret")).toThrow();
  });

  it("binds stable payload digests to the provider handle", () => {
    const payload = { content: "hello", fromNumber: "+15550000101", rawUrls: [] };
    expect(digestSendblueInboxPayload(payload, "handle-1", "secret")).toBe(
      digestSendblueInboxPayload(payload, "handle-1", "secret"),
    );
    expect(digestSendblueInboxPayload(payload, "handle-1", "secret")).not.toBe(
      digestSendblueInboxPayload(payload, "handle-2", "secret"),
    );
  });

  it("derives a stable deployment capability without exposing the API secret", () => {
    const capability = deriveSendblueInboxCapability("private-api-secret");
    expect(capability).toHaveLength(64);
    expect(capability).not.toContain("private-api-secret");
    expect(deriveSendblueInboxCapability("private-api-secret")).toBe(capability);
    expect(deriveSendblueInboxCapability("other-secret")).not.toBe(capability);
  });
});
