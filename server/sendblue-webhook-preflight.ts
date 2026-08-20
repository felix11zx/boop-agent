import { randomUUID } from "node:crypto";
import { verifySendblueWebhookSecret } from "./sendblue-webhook-auth.js";

export type SendblueWebhookRequestLike = {
  body: unknown;
  get(name: string): string | undefined;
};

export type SendblueWebhookResponseLike = {
  status(code: number): SendblueWebhookResponseLike;
  json(body: unknown): unknown;
};

export type SendblueWebhookLogger = {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type SendblueWebhookPreflightDependencies = {
  enqueueMessage(message: {
    handle: string;
    content: string;
    fromNumber: string;
    rawUrls: string[];
  }): Promise<{ queued: boolean }>;
  createRequestId?: () => string;
  logger?: SendblueWebhookLogger;
  verifySecret?: (received: string | undefined) => boolean;
};

export type AcceptedSendblueWebhook = {
  requestId: string;
  content: string;
  fromNumber: string;
  messageHandle: string;
  rawUrls: string[];
};

export function extractSendblueMediaUrls(
  mediaUrl: unknown,
  mediaUrls: unknown,
): string[] {
  const urls = new Set<string>();
  if (Array.isArray(mediaUrls)) {
    for (const value of mediaUrls) {
      if (typeof value === "string" && value.trim()) urls.add(value.trim());
    }
  }
  if (typeof mediaUrl === "string" && mediaUrl.trim()) urls.add(mediaUrl.trim());
  return [...urls];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function headerState(value: string | undefined): "present" | "absent" {
  return value ? "present" : "absent";
}

function safeContentType(value: string | undefined): string {
  if (!value) return "missing";
  return value.split(";", 1)[0]!.trim().slice(0, 80) || "missing";
}

function safeStatus(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "unknown";
}

function collectErrorCodes(error: unknown, output: Set<string>, seen: Set<unknown>): void {
  if (error === null || typeof error !== "object" || seen.has(error)) return;
  seen.add(error);
  const record = error as { cause?: unknown; code?: unknown; errors?: unknown };
  if (typeof record.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(record.code)) {
    output.add(record.code);
  }
  if (record.cause !== undefined) collectErrorCodes(record.cause, output, seen);
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) collectErrorCodes(nested, output, seen);
  }
}

function safeErrorFingerprint(error: unknown): string {
  const errorType = error instanceof Error ? error.name : typeof error;
  const codes = new Set<string>();
  collectErrorCodes(error, codes, new Set());
  return `type=${errorType || "unknown"} codes=${[...codes].join(",") || "none"}`;
}

/**
 * Authenticates, validates, and deduplicates an inbound Sendblue callback.
 * Logs only request shape and state transitions: never payload text, phone
 * numbers, message handles, or secret values.
 */
export async function preflightSendblueWebhook(
  req: SendblueWebhookRequestLike,
  res: SendblueWebhookResponseLike,
  dependencies: SendblueWebhookPreflightDependencies,
): Promise<AcceptedSendblueWebhook | null> {
  const logger = dependencies.logger ?? console;
  const verifySecret = dependencies.verifySecret ?? verifySendblueWebhookSecret;
  const requestId = (dependencies.createRequestId?.() ?? randomUUID()).slice(0, 12);
  const signingSecret = req.get("sb-signing-secret");
  const alternateSecret = req.get("x-webhook-secret");
  const body = asRecord(req.body);

  logger.log(
    `[sendblue:webhook ${requestId}] received contentType=${safeContentType(req.get("content-type"))} ` +
      `canonicalSecret=${headerState(signingSecret)} alternateSecret=${headerState(alternateSecret)} ` +
      `body=${Object.keys(body).length > 0 ? "object" : "empty_or_invalid"}`,
  );

  if (!verifySecret(signingSecret)) {
    logger.warn(
      `[sendblue:webhook ${requestId}] rejected reason=invalid_signature ` +
        `canonicalSecret=${headerState(signingSecret)} alternateSecret=${headerState(alternateSecret)}`,
    );
    res.status(401).json({ error: "invalid webhook signature", requestId });
    return null;
  }

  const content = typeof body.content === "string" ? body.content : "";
  const fromNumber = typeof body.from_number === "string" ? body.from_number.trim() : "";
  const isOutbound = body.is_outbound === true || body.is_outbound === "true";
  const messageHandle =
    typeof body.message_handle === "string" && body.message_handle.trim()
      ? body.message_handle.trim()
      : undefined;
  const rawUrls = extractSendblueMediaUrls(body.media_url, body.media_urls);
  const status = safeStatus(body.status);
  const skipReasons: string[] = [];
  if (isOutbound) skipReasons.push("outbound");
  if (!fromNumber) skipReasons.push("missing_sender");
  if (!content && rawUrls.length === 0) skipReasons.push("missing_content_and_media");

  if (skipReasons.length > 0) {
    logger.log(
      `[sendblue:webhook ${requestId}] skipped reason=${skipReasons.join("+")} status=${status}`,
    );
    res.json({ ok: true, skipped: true, reason: skipReasons[0], requestId });
    return null;
  }

  if (!messageHandle) {
    logger.error(`[sendblue:webhook ${requestId}] inbox_enqueue=failed reason=missing_handle`);
    res.status(503).json({ error: "provider message handle is required", requestId });
    return null;
  }

  logger.log(`[sendblue:webhook ${requestId}] inbox_enqueue=start`);
  let queued: boolean;
  try {
    ({ queued } = await dependencies.enqueueMessage({
      handle: messageHandle,
      content,
      fromNumber,
      rawUrls,
    }));
  } catch (error) {
    logger.error(
      `[sendblue:webhook ${requestId}] inbox_enqueue=failed ${safeErrorFingerprint(error)}`,
    );
    res.status(503).json({ error: "temporary webhook processing failure", requestId });
    return null;
  }

  if (!queued) {
    logger.log(`[sendblue:webhook ${requestId}] inbox_enqueue=completed`);
    res.json({ ok: true, deduped: true, requestId });
    return null;
  }
  logger.log(`[sendblue:webhook ${requestId}] inbox_enqueue=queued`);

  logger.log(
    `[sendblue:webhook ${requestId}] accepted status=${status} ` +
      `handle=present mediaCount=${rawUrls.length}`,
  );
  return { requestId, content, fromNumber, messageHandle, rawUrls };
}
