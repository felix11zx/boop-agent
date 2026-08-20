import { describe, expect, it, vi } from "vitest";
import { collectToolkitCatalog, CURATED_TOOLKITS } from "../server/composio.js";

describe("curated Composio toolkits", () => {
  it("contains no sparse or undefined entries", () => {
    expect(Object.keys(CURATED_TOOLKITS)).toHaveLength(CURATED_TOOLKITS.length);
    expect(CURATED_TOOLKITS.every(Boolean)).toBe(true);
  });
});

describe("Composio toolkit catalog pagination", () => {
  it("collects every page and maps API metadata", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (!cursor) {
        return {
          items: [
            {
              slug: "alpha",
              name: "Alpha",
              meta: {
                logo: "https://example.test/alpha.png",
                description: "First toolkit",
                tools_count: 12,
              },
            },
          ],
          nextCursor: "page-2",
        };
      }
      return {
        items: [
          {
            slug: "beta",
            name: "Beta",
            meta: { tools_count: 7 },
          },
        ],
        nextCursor: null,
      };
    });

    const catalog = await collectToolkitCatalog(fetchPage);

    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "page-2");
    expect([...catalog.keys()]).toEqual(["alpha", "beta"]);
    expect(catalog.get("alpha")).toMatchObject({
      description: "First toolkit",
      toolsCount: 12,
    });
    expect(catalog.get("beta")?.toolsCount).toBe(7);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const fetchPage = vi.fn(async () => ({ items: [], nextCursor: "same-page" }));

    await expect(collectToolkitCatalog(fetchPage)).rejects.toThrow("repeated cursor");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
