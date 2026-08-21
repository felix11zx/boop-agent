export interface AgentTextLogBufferOptions {
  flushIntervalMs?: number;
  maxBatchChars?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BATCH_CHARS = 2_000;

/**
 * Coalesces tiny streamed text deltas into ordered, bounded log writes.
 * `finish` must be awaited before the agent is marked complete.
 */
export class AgentTextLogBuffer {
  private readonly flushIntervalMs: number;
  private readonly maxBatchChars: number;
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private firstWriteError: unknown;
  private writeFailed = false;
  private closed = false;

  constructor(
    private readonly write: (content: string) => Promise<void>,
    options: AgentTextLogBufferOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchChars = options.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;

    if (this.flushIntervalMs <= 0 || this.maxBatchChars <= 0) {
      throw new Error("AgentTextLogBuffer limits must be positive");
    }
  }

  append(text: string): void {
    if (!text) return;
    if (this.closed) throw new Error("Cannot append to a finished AgentTextLogBuffer");

    this.pending += text;
    while (this.pending.length >= this.maxBatchChars) {
      const batch = this.pending.slice(0, this.maxBatchChars);
      this.pending = this.pending.slice(this.maxBatchChars);
      this.enqueueWrite(batch);
    }

    if (this.pending) this.scheduleFlush();
  }

  async finish(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.clearTimer();
      this.enqueuePending();
    }

    await this.writeQueue;
    if (this.writeFailed) throw this.firstWriteError;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueuePending();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueuePending(): void {
    this.clearTimer();
    if (!this.pending) return;
    const batch = this.pending;
    this.pending = "";
    this.enqueueWrite(batch);
  }

  private enqueueWrite(content: string): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.write(content);
      } catch (err) {
        if (!this.writeFailed) {
          this.writeFailed = true;
          this.firstWriteError = err;
        }
      }
    });
  }
}
