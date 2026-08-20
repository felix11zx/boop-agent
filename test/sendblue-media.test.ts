import { describe, expect, it, vi } from "vitest";
import {
  extractSendblueMediaUrls,
  parseSendblueInboundPage,
  parseSendblueInboundMessages,
  recoverSendblueInboundMessages,
} from "../server/sendblue.js";

describe("Sendblue media payloads", () => {
  it("keeps the legacy media_url when media_urls is an empty array", () => {
    expect(
      extractSendblueMediaUrls("https://cdn.example/image.png", []),
    ).toEqual(["https://cdn.example/image.png"]);
  });

  it("combines and deduplicates both supported media fields", () => {
    expect(
      extractSendblueMediaUrls("https://cdn.example/one.png", [
        "https://cdn.example/one.png",
        "https://cdn.example/two.jpg",
      ]),
    ).toEqual([
      "https://cdn.example/one.png",
      "https://cdn.example/two.jpg",
    ]);
  });
});

describe("Sendblue inbox polling", () => {
  it("keeps only actionable inbound messages", () => {
    expect(
      parseSendblueInboundMessages({
        data: [
          {
            is_outbound: false,
            message_handle: "inbound-1",
            from_number: "+15550000101",
            content: "hello",
            media_url: "",
          },
          {
            is_outbound: true,
            message_handle: "outbound-1",
            from_number: "+15550000102",
            content: "ignore me",
          },
          {
            is_outbound: false,
            message_handle: "inbound-media",
            from_number: "+15550000103",
            content: "",
            media_url: "https://cdn.example/photo.png",
          },
          { is_outbound: false, content: "missing identity" },
        ],
      }),
    ).toEqual([
      {
        handle: "inbound-1",
        fromNumber: "+15550000101",
        content: "hello",
        rawUrls: [],
      },
      {
        handle: "inbound-media",
        fromNumber: "+15550000103",
        content: "",
        rawUrls: ["https://cdn.example/photo.png"],
      },
    ]);
  });

  it("exposes the next offset for lossless pagination", () => {
    expect(
      parseSendblueInboundPage({
        data: [
          {
            is_outbound: false,
            message_handle: "inbound-1",
            from_number: "+15550000101",
            content: "hello",
          },
        ],
        pagination: { hasMore: true, offset: 100 },
      }),
    ).toMatchObject({ hasMore: true, nextOffset: 101 });
  });

  it("fetches every advertised poll page before completing recovery", async () => {
    const offsets: string[] = [];
    const enqueueMessage = vi.fn(async () => ({ queued: true }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = url.searchParams.get("offset") ?? "0";
      offsets.push(offset);
      const numericOffset = Number(offset);
      const count = numericOffset < 200 ? 100 : 50;
      return Response.json({
        data: Array.from({ length: count }, (_, index) => ({
          is_outbound: false,
          message_handle: `inbound-${numericOffset + index}`,
          from_number: "+15550000101",
          content: "hello",
        })),
        pagination: { hasMore: numericOffset < 200, offset: numericOffset },
      });
    });

    await expect(
      recoverSendblueInboundMessages({
        sendblueNumber: "+15550000100",
        since: Date.parse("2026-08-20T00:00:00Z"),
        headers: {},
        enqueueMessage,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toBe(250);
    expect(offsets).toEqual(["0", "100", "200"]);
    expect(enqueueMessage).toHaveBeenCalledTimes(250);
  });
});
