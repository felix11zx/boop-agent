import { describe, expect, it } from "vitest";
import { formatCustomMcpResult } from "../server/custom-mcp/adapters.js";

describe("custom MCP runtime adapter", () => {
  it("keeps text and structured output while describing binary blocks", () => {
    const text = formatCustomMcpResult({
      content: [
        { type: "text", text: "Event created" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        {
          type: "resource_link",
          name: "event",
          uri: "calendar://event/123",
          mimeType: "application/json",
        },
      ],
      structuredContent: { id: "123" },
    });

    expect(text).toContain("Event created");
    expect(text).toContain("[image: image/png, 5 bytes]");
    expect(text).toContain("calendar://event/123");
    expect(text).toContain('"id": "123"');
  });
});
