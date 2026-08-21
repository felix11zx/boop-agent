import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTextLogBuffer } from "../server/agent-text-log-buffer.js";

describe("AgentTextLogBuffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces tiny deltas and flushes all text on finish", async () => {
    const writes: string[] = [];
    const buffer = new AgentTextLogBuffer(async (content) => {
      writes.push(content);
    });

    for (const chunk of ["one", " ", "two", " ", "three"]) buffer.append(chunk);
    await buffer.finish();

    expect(writes).toEqual(["one two three"]);
  });

  it("keeps batches bounded and ordered under a large stream", async () => {
    const writes: string[] = [];
    const buffer = new AgentTextLogBuffer(
      async (content) => {
        writes.push(content);
      },
      { maxBatchChars: 5, flushIntervalMs: 1_000 },
    );

    buffer.append("abcdefghijkl");
    await buffer.finish();

    expect(writes).toEqual(["abcde", "fghij", "kl"]);
    expect(writes.join("")).toBe("abcdefghijkl");
  });

  it("turns thousands of tiny model deltas into only a few writes", async () => {
    const writes: string[] = [];
    const buffer = new AgentTextLogBuffer(async (content) => {
      writes.push(content);
    });

    for (let index = 0; index < 1_593; index += 1) buffer.append("text");
    await buffer.finish();

    expect(writes).toHaveLength(4);
    expect(writes.join("")).toBe("text".repeat(1_593));
  });

  it("flushes a partial batch after the interval", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const buffer = new AgentTextLogBuffer(
      async (content) => {
        writes.push(content);
      },
      { flushIntervalMs: 250 },
    );

    buffer.append("streaming");
    await vi.advanceTimersByTimeAsync(249);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["streaming"]);
    await buffer.finish();
  });

  it("reports a deferred write failure from finish", async () => {
    const failure = new Error("Convex unavailable");
    const buffer = new AgentTextLogBuffer(async () => {
      throw failure;
    });

    buffer.append("text");
    await expect(buffer.finish()).rejects.toBe(failure);
  });
});
