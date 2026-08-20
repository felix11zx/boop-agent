import express from "express";
import { randomUUID } from "node:crypto";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { validateImageHeader, MAX_IMAGE_BYTES, type ImageMediaType } from "./images/mime.js";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";
import { maybeHandleScriptedDemoReply } from "./scripted-demo-replies.js";
import {
  extractSendblueMediaUrls,
  preflightSendblueWebhook,
  type AcceptedSendblueWebhook,
} from "./sendblue-webhook-preflight.js";
import {
  decryptSendblueInboxPayload,
  digestSendblueInboxPayload,
  deriveSendblueInboxCapability,
  encryptSendblueInboxPayload,
  type SendblueInboxPayload,
} from "./sendblue-inbox-crypto.js";

export { extractSendblueMediaUrls } from "./sendblue-webhook-preflight.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;
const SENDBLUE_SEND_TIMEOUT_MS = 20_000;

export class SendblueDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SendblueDeliveryError";
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export async function sendImessage(toNumber: string, text: string): Promise<void> {
  const h = headers();
  if (!h) {
    throw new Error("Sendblue credentials are missing");
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    throw new Error("SENDBLUE_FROM_NUMBER is not set");
  }
  // Intentional privacy guard: Boop should not deliver phone numbers back over
  // iMessage, even if an agent includes one in its final reply.
  const plain = redactPhoneNumbers(stripMarkdown(text));
  for (const part of chunk(plain)) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/send-message`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
        signal: AbortSignal.timeout(SENDBLUE_SEND_TIMEOUT_MS),
      });
    } catch (error) {
      // The request may have reached Sendblue even though the client did not
      // receive the response. Automatic retry could duplicate an iMessage.
      throw new SendblueDeliveryError(
        "Sendblue delivery outcome is unknown",
        "unknown",
        false,
        { cause: error },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[sendblue] send failed ${res.status}: ${redactPhoneNumbers(body).slice(0, 500)}`,
      );
      if (body.includes("missing required parameter") && body.includes("from_number")) {
        console.error(
          `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
        );
      } else if (body.includes("Cannot send messages to self")) {
        console.error(
          `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
        );
      } else if (body.includes("This phone number is not defined")) {
        console.error(
          `[sendblue] → Sendblue doesn't recognize from_number=${redactContactHandle(from)}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
        );
      }
      throw new SendblueDeliveryError(
        `Sendblue send failed with HTTP ${res.status}`,
        "rejected",
        res.status === 408 || res.status === 429 || res.status >= 500,
      );
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${redactContactHandle(toNumber)}`);
    }
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

type IngestedImage = { storageId: string; mediaType: ImageMediaType };

type QueuedSendblueMessage = {
  handle: string;
  payload: string;
  attempts: number;
  leaseToken: string;
};

type SendblueInboundMessage = {
  handle: string;
  content: string;
  fromNumber: string;
  rawUrls: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseSendblueInboundPage(payload: unknown): {
  messages: SendblueInboundMessage[];
  hasMore: boolean;
  nextOffset: number;
} {
  const body = asRecord(payload);
  const data = body.data;
  if (!Array.isArray(data)) return { messages: [], hasMore: false, nextOffset: 0 };

  const messages: SendblueInboundMessage[] = [];
  for (const item of data) {
    const message = asRecord(item);
    if (message.is_outbound !== false) continue;
    const handle = typeof message.message_handle === "string" ? message.message_handle.trim() : "";
    const fromNumber = typeof message.from_number === "string" ? message.from_number.trim() : "";
    const content = typeof message.content === "string" ? message.content : "";
    const rawUrls = extractSendblueMediaUrls(message.media_url, message.media_urls);
    if (!handle || !fromNumber || (!content && rawUrls.length === 0)) continue;
    messages.push({ handle, fromNumber, content, rawUrls });
  }
  const pagination = asRecord(body.pagination);
  const offset =
    typeof pagination.offset === "number" && Number.isFinite(pagination.offset)
      ? Math.max(0, Math.floor(pagination.offset))
      : 0;
  return {
    messages,
    hasMore: pagination.hasMore === true,
    nextOffset: offset + data.length,
  };
}

export function parseSendblueInboundMessages(payload: unknown): SendblueInboundMessage[] {
  return parseSendblueInboundPage(payload).messages;
}

export async function recoverSendblueInboundMessages(options: {
  sendblueNumber: string;
  since: number;
  headers: Record<string, string>;
  enqueueMessage: (message: SendblueInboundMessage) => Promise<{ queued: boolean }>;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = Math.min(Math.max(options.maxPages ?? 100, 1), 100);
  let queued = 0;
  let offset = 0;
  let pages = 0;
  while (true) {
    const url = new URL(`${API_BASE}/v2/messages`);
    url.searchParams.set("is_outbound", "false");
    url.searchParams.set("sendblue_number", options.sendblueNumber);
    url.searchParams.set("created_at_gte", new Date(options.since).toISOString());
    url.searchParams.set("order_by", "createdAt");
    url.searchParams.set("order_direction", "asc");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const response = await fetchImpl(url, {
      method: "GET",
      headers: options.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Sendblue inbox poll failed with HTTP ${response.status}`);
    }
    const page = parseSendblueInboundPage(await response.json());
    for (const message of page.messages) {
      const result = await options.enqueueMessage(message);
      if (result.queued) queued += 1;
    }
    pages += 1;
    if (!page.hasMore) return queued;
    if (page.nextOffset <= offset || pages >= maxPages) {
      throw new Error("Sendblue inbox pagination did not terminate safely");
    }
    offset = page.nextOffset;
  }
}

export async function ingestSendblueImage(
  url: string,
): Promise<{ ok: true; image: IngestedImage } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `download failed: HTTP ${res.status}` };
  }
  const lenHeader = res.headers.get("content-length");
  const contentLength = lenHeader ? Number(lenHeader) : undefined;
  const check = validateImageHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength,
  });
  if (!check.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: check.reason };
  }
  // Stream the body so we can abort early when the running total exceeds
  // MAX_IMAGE_BYTES — content-length is often absent on CDN/redirect
  // responses, and `await res.arrayBuffer()` would otherwise buffer the
  // entire payload before any cap check fires.
  let buf: ArrayBuffer;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "download failed: no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: `image too large: >${MAX_IMAGE_BYTES} bytes`,
        };
      }
      chunks.push(value);
    }
    buf = new ArrayBuffer(total);
    const view = new Uint8Array(buf);
    let offset = 0;
    for (const c of chunks) {
      view.set(c, offset);
      offset += c.byteLength;
    }
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }

  try {
    const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": check.mediaType },
      body: buf,
      signal: AbortSignal.timeout(10_000),
    });
    if (!upload.ok) {
      return { ok: false, reason: `upload failed: HTTP ${upload.status}` };
    }
    const { storageId } = (await upload.json()) as { storageId: string };
    return { ok: true, image: { storageId, mediaType: check.mediaType } };
  } catch (err) {
    return { ok: false, reason: `upload failed: ${String(err)}` };
  }
}

const inFlightInboundHandles = new Set<string>();
let inboxTickRunning = false;
let sendbluePollRunning = false;
const SENDBLUE_INBOX_CONCURRENCY = 4;
const SENDBLUE_INBOX_MAX_ATTEMPTS = 6;
const SENDBLUE_INBOX_LEASE_MS = 10 * 60_000;
const SENDBLUE_INBOX_HEARTBEAT_MS = 60_000;
// Recover a message missed during a tunnel outage before this process started.
// Existing message_handle rows make this idempotent for already-seen callbacks.
let sendbluePollSince = Date.now() - 24 * 60 * 60 * 1000;

async function enqueueSendblueMessage(message: {
  handle: string;
  content: string;
  fromNumber: string;
  rawUrls: string[];
}): Promise<{ queued: boolean }> {
  const payload: SendblueInboxPayload = {
    content: message.content,
    fromNumber: message.fromNumber,
    rawUrls: message.rawUrls,
  };
  return await convex.mutation(api.sendblueDedup.enqueue, {
    handle: message.handle,
    capability: deriveSendblueInboxCapability(),
    payload: encryptSendblueInboxPayload(payload, message.handle),
    payloadDigest: digestSendblueInboxPayload(payload, message.handle),
  });
}

async function dispatchSendblueMessage(message: AcceptedSendblueWebhook): Promise<void> {
  const { requestId, content, fromNumber, messageHandle, rawUrls } = message;
  const ingestResults = await Promise.all(rawUrls.map(ingestSendblueImage));
  const ingested: IngestedImage[] = [];
  const ingestErrors: string[] = [];
  for (const result of ingestResults) {
    if (result.ok) ingested.push(result.image);
    else ingestErrors.push(result.reason);
  }
  if (ingestErrors.length > 0) {
    console.warn(
      `[sendblue:webhook ${requestId}] media_ingest=partial ` +
        `succeeded=${ingested.length} failed=${ingestErrors.length}`,
    );
  }

  const conversationId = `sms:${fromNumber}`;
  const turnTag = Math.random().toString(36).slice(2, 8);
  const safeTextForLog = redactPhoneNumbers(content);
  const preview = safeTextForLog.length > 100 ? `${safeTextForLog.slice(0, 100)}…` : safeTextForLog;
  console.log(`[sendblue:webhook ${requestId}] dispatch=started turn=${turnTag}`);
  console.log(`[turn ${turnTag}] ← ${redactContactHandle(fromNumber)}: ${JSON.stringify(preview)}`);
  const start = Date.now();

  try {
    broadcast("message_in", {
      conversationId,
      content,
      from_number: fromNumber,
    });
  } catch (error) {
    console.error(`[sendblue:webhook ${requestId}] broadcast=failed`, error);
  }

  if (
    await maybeHandleScriptedDemoReply(
      { conversationId, content, fromNumber, turnTag },
      { sendImessage, sendTypingIndicator },
    )
  ) {
    return;
  }

  const stopTyping = startTypingLoop(fromNumber);
  try {
    const reply = await handleUserMessage({
      conversationId,
      content,
      turnId: `sendblue:${messageHandle}`,
      turnTag,
      images: ingested,
      mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
      onThinking: (thinking) => broadcast("thinking", { conversationId, t: thinking }),
    });
    if (!reply) {
      console.log(`[turn ${turnTag}] → (no reply)`);
      return;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const safeReplyPreview = redactPhoneNumbers(reply);
    const replyPreview =
      safeReplyPreview.length > 100 ? `${safeReplyPreview.slice(0, 100)}…` : safeReplyPreview;
    console.log(
      `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
    );
    await sendImessage(fromNumber, reply);
    // Delivery already succeeded. A transient history-write failure must not
    // resend the same iMessage on the next inbox attempt.
    await convex
      .mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: reply,
      })
      .catch((error) =>
        console.error(`[sendblue:webhook ${requestId}] assistant_history=failed`, error),
      );
  } finally {
    stopTyping();
  }
}

function inboundRetryDelayMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 5));
}

export function classifySendblueInboxFailure(error: unknown):
  | { action: "retry" }
  | { action: "dead_letter"; reason: string } {
  if (error instanceof SendblueDeliveryError) {
    if (error.outcome === "unknown") {
      return { action: "dead_letter", reason: "delivery_outcome_unknown" };
    }
    if (!error.retryable) {
      return { action: "dead_letter", reason: "permanent_delivery_failure" };
    }
  }
  return { action: "retry" };
}

async function processQueuedSendblueMessage(message: QueuedSendblueMessage): Promise<void> {
  if (inFlightInboundHandles.has(message.handle)) return;
  inFlightInboundHandles.add(message.handle);
  const requestId = `recovery-${Math.random().toString(36).slice(2, 10)}`;
  const capability = deriveSendblueInboxCapability();
  const safeError = (error: unknown) => redactPhoneNumbers(String(error)).slice(0, 500);
  const markDeadLetter = async (reason: string, error: unknown): Promise<void> => {
    const result = await convex.mutation(api.sendblueDedup.markDeadLetter, {
      handle: message.handle,
      capability,
      leaseToken: message.leaseToken,
      reason,
      error: safeError(error),
    });
    if (!result.applied) {
      console.warn(`[sendblue:inbox ${requestId}] dead_letter=stale reason=${reason}`);
    }
  };
  const heartbeat = setInterval(() => {
    void convex
      .mutation(api.sendblueDedup.renewLease, {
        handle: message.handle,
        capability,
        leaseToken: message.leaseToken,
        leaseDurationMs: SENDBLUE_INBOX_LEASE_MS,
      })
      .then((result) => {
        if (!result.applied) {
          console.warn(`[sendblue:inbox ${requestId}] heartbeat=stale`);
        }
      })
      .catch((error) => console.error(`[sendblue:inbox ${requestId}] heartbeat=failed`, error));
  }, SENDBLUE_INBOX_HEARTBEAT_MS);
  let payload: SendblueInboxPayload;
  try {
    payload = decryptSendblueInboxPayload(message.payload, message.handle);
  } catch (error) {
    console.error(`[sendblue:inbox ${requestId}] invalid encrypted payload; dead-lettering`, error);
    await markDeadLetter("invalid_encrypted_payload", error).catch((markError) =>
      console.error(`[sendblue:inbox ${requestId}] dead_letter_mark=failed`, markError),
    );
    clearInterval(heartbeat);
    inFlightInboundHandles.delete(message.handle);
    return;
  }
  try {
    await dispatchSendblueMessage({
      requestId,
      content: payload.content,
      fromNumber: payload.fromNumber,
      messageHandle: message.handle,
      rawUrls: payload.rawUrls,
    });
    const result = await convex.mutation(api.sendblueDedup.markCompleted, {
      handle: message.handle,
      capability,
      leaseToken: message.leaseToken,
      completedAt: Date.now(),
    });
    if (!result.applied) {
      console.error(`[sendblue:inbox ${requestId}] completion=stale`);
    }
  } catch (error) {
    const disposition = classifySendblueInboxFailure(error);
    if (disposition.action === "dead_letter") {
      console.error(
        `[sendblue:inbox ${requestId}] dead_letter=${disposition.reason}`,
        error,
      );
      await markDeadLetter(disposition.reason, error).catch((markError) =>
        console.error(`[sendblue:inbox ${requestId}] dead_letter_mark=failed`, markError),
      );
      return;
    }
    const delayMs = inboundRetryDelayMs(message.attempts);
    console.error(
      `[sendblue:inbox ${requestId}] attempt=${message.attempts} failed; retrying in ${delayMs}ms`,
      error,
    );
    await convex
      .mutation(api.sendblueDedup.scheduleRetry, {
        handle: message.handle,
        capability,
        leaseToken: message.leaseToken,
        delayMs,
        error: safeError(error),
        maxAttempts: SENDBLUE_INBOX_MAX_ATTEMPTS,
      })
      .catch((retryError) =>
        console.error(`[sendblue:inbox ${requestId}] retry_schedule=failed`, retryError),
      );
  } finally {
    clearInterval(heartbeat);
    inFlightInboundHandles.delete(message.handle);
  }
}

export async function tickSendblueInbox(): Promise<void> {
  if (inboxTickRunning) return;
  const availableSlots = SENDBLUE_INBOX_CONCURRENCY - inFlightInboundHandles.size;
  if (availableSlots <= 0) return;
  inboxTickRunning = true;
  try {
    const pending = await convex.mutation(api.sendblueDedup.leasePending, {
      capability: deriveSendblueInboxCapability(),
      leaseToken: randomUUID(),
      leaseDurationMs: SENDBLUE_INBOX_LEASE_MS,
      limit: availableSlots,
      maxAttempts: SENDBLUE_INBOX_MAX_ATTEMPTS,
    });
    for (const message of pending) {
      void processQueuedSendblueMessage(message).catch((error) =>
        console.error("[sendblue:inbox] worker error", error),
      );
    }
  } finally {
    inboxTickRunning = false;
  }
}

async function pollSendblueInboundMessages(): Promise<void> {
  if (sendbluePollRunning) return;
  const h = headers();
  const sendblueNumber = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!h || !sendblueNumber) return;

  sendbluePollRunning = true;
  const pollStartedAt = Date.now();
  try {
    const queued = await recoverSendblueInboundMessages({
      sendblueNumber,
      since: sendbluePollSince,
      headers: h,
      enqueueMessage: enqueueSendblueMessage,
    });
    // Advance the in-memory watermark only after every advertised page was
    // fetched and durably enqueued. Restarts intentionally replay 24 hours;
    // provider handles make that replay idempotent.
    sendbluePollSince = pollStartedAt - 60_000;
    if (queued > 0) {
      console.log(`[sendblue:poll] recovered=${queued}`);
      void tickSendblueInbox();
    }
  } finally {
    sendbluePollRunning = false;
  }
}

export function startSendblueInboxLoop(): () => void {
  void tickSendblueInbox().catch((error) => console.error("[sendblue:inbox] tick error", error));
  void pollSendblueInboundMessages().catch((error) =>
    console.error("[sendblue:poll] tick error", error),
  );
  const inboxTimer = setInterval(() => {
    void tickSendblueInbox().catch((error) =>
      console.error("[sendblue:inbox] tick error", error),
    );
  }, 5_000);
  const pollTimer = setInterval(() => {
    void pollSendblueInboundMessages().catch((error) =>
      console.error("[sendblue:poll] tick error", error),
    );
  }, 15_000);
  return () => {
    clearInterval(inboxTimer);
    clearInterval(pollTimer);
  };
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    const accepted = await preflightSendblueWebhook(req, res, {
      enqueueMessage: enqueueSendblueMessage,
    });
    if (!accepted) return;
    res.json({ ok: true, requestId: accepted.requestId });

    // The durable row is already committed. The worker can resume it after a
    // Convex/network interruption or a local process restart.
    void tickSendblueInbox().catch((error) =>
      console.error("[sendblue:inbox] immediate tick error", error),
    );
  });

  return router;
}
