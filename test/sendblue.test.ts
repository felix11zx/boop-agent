import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySendblueInboxFailure,
  sendImessage,
  SendblueDeliveryError,
} from "../server/sendblue.js";

const originalApiKey = process.env.SENDBLUE_API_KEY;
const originalApiSecret = process.env.SENDBLUE_API_SECRET;
const originalFromNumber = process.env.SENDBLUE_FROM_NUMBER;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) {
    delete process.env.SENDBLUE_API_KEY;
  } else {
    process.env.SENDBLUE_API_KEY = originalApiKey;
  }
  if (originalApiSecret === undefined) {
    delete process.env.SENDBLUE_API_SECRET;
  } else {
    process.env.SENDBLUE_API_SECRET = originalApiSecret;
  }
  if (originalFromNumber === undefined) {
    delete process.env.SENDBLUE_FROM_NUMBER;
  } else {
    process.env.SENDBLUE_FROM_NUMBER = originalFromNumber;
  }
});

describe("sendImessage", () => {
  it("redacts phone numbers from the delivered message body", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
    const recipient = ["+", "1", "555", "000", "0101"].join("");
    const leakedPhone = ["+", "1", "555", "555", "0102"].join("");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendImessage(recipient, `Call ${leakedPhone}`);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: recipient,
      content: "Call [phone number hidden]",
    });
  });

  it("rejects failed deliveries so the durable inbox can retry them", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = "+15550000100";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(sendImessage("+15550000101", "Try again")).rejects.toThrow(
      "Sendblue send failed with HTTP 503",
    );
  });

  it("classifies ambiguous transport outcomes as non-retryable", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = "+15550000100";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("socket closed");
    }));

    let failure: unknown;
    try {
      await sendImessage("+15550000101", "Do not duplicate me");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SendblueDeliveryError);
    expect(classifySendblueInboxFailure(failure)).toEqual({
      action: "dead_letter",
      reason: "delivery_outcome_unknown",
    });
  });

  it("does not retry permanent Sendblue rejections", () => {
    expect(
      classifySendblueInboxFailure(
        new SendblueDeliveryError("unauthorized", "rejected", false),
      ),
    ).toEqual({ action: "dead_letter", reason: "permanent_delivery_failure" });
    expect(
      classifySendblueInboxFailure(
        new SendblueDeliveryError("busy", "rejected", true),
      ),
    ).toEqual({ action: "retry" });
  });
});
