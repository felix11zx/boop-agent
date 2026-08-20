import { Buffer } from "node:buffer";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

const RETRYABLE_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

const DEFAULT_RETRY_DELAYS_MS = [0, 100, 300] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type ErrorRecord = {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  syscall?: unknown;
};

function asErrorRecord(value: unknown): ErrorRecord | null {
  return typeof value === "object" && value !== null ? (value as ErrorRecord) : null;
}

function classifyConnectError(error: unknown, seen: Set<unknown>): boolean | undefined {
  if (seen.has(error)) return undefined;
  seen.add(error);

  const record = asErrorRecord(error);
  if (!record) return undefined;

  // Aggregate connection attempts are retryable only when every nested error
  // is known to have happened before delivery. A mixed ECONNRESET, for
  // example, must not become retryable just because another address was
  // unreachable.
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const nested = record.errors.map((item) => classifyConnectError(item, seen));
    return nested.length > 0 && nested.every((result) => result === true);
  }

  if (typeof record.code === "string") {
    if (RETRYABLE_CONNECT_CODES.has(record.code)) return true;
    if (record.code === "ETIMEDOUT" && record.syscall === "connect") return true;
    return false;
  }

  if (record.cause !== undefined) return classifyConnectError(record.cause, seen);
  return undefined;
}

function classifyReadError(error: unknown, seen: Set<unknown>): boolean | undefined {
  if (seen.has(error)) return undefined;
  seen.add(error);

  const record = asErrorRecord(error);
  if (!record) return undefined;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const nested = record.errors.map((item) => classifyReadError(item, seen));
    return nested.length > 0 && nested.every((result) => result === true);
  }
  if (typeof record.code === "string") {
    return record.code === "ETIMEDOUT" && record.syscall === "read";
  }
  if (record.cause !== undefined) return classifyReadError(record.cause, seen);
  return undefined;
}

/**
 * Returns true only for failures that happen before an HTTP request can be
 * delivered. Retrying broader socket errors could replay a Convex mutation
 * whose response was lost after the backend already committed it.
 */
export function isRetryableConnectError(error: unknown): boolean {
  return classifyConnectError(error, new Set()) === true;
}

export function isRetryableReadError(error: unknown): boolean {
  return classifyReadError(error, new Set()) === true;
}

function canReplayRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): boolean {
  const hasReplayableUrl = typeof input === "string" || input instanceof URL;
  const hasReplayableBody =
    init?.body === undefined || init.body === null || typeof init.body === "string";
  return hasReplayableUrl && hasReplayableBody;
}

function isConvexQueryRequest(input: RequestInfo | URL): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  const pathname = new URL(input).pathname;
  return pathname === "/api/query" || pathname === "/api/query_at_ts" || pathname === "/api/query_ts";
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

async function requestBody(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("Convex Node HTTP transport received an unsupported request body");
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  throw new TypeError("Convex Node HTTP transport requires a URL string or URL object");
}

function collectResponse(
  response: IncomingMessage,
  method: string,
  resolve: (value: Response) => void,
  reject: (reason?: unknown) => void,
) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.once("aborted", () => reject(new Error("Convex response was aborted")));
  response.once("error", reject);
  response.once("end", () => {
    const status = response.statusCode;
    if (status === undefined) {
      reject(new Error("Convex response did not include an HTTP status"));
      return;
    }
    const mustNotHaveBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
    resolve(
      new Response(mustNotHaveBody ? null : Buffer.concat(chunks), {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders(response.headers),
      }),
    );
  });
}

export type NodeHttpFetchOptions = {
  httpAgent?: HttpAgent | false;
  httpsAgent?: HttpsAgent | false;
  requesters?: NodeRequesters;
  requestTimeoutMs?: number;
};

type NodeRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

type NodeRequesters = {
  http: NodeRequest;
  https: NodeRequest;
};

const defaultRequesters: NodeRequesters = {
  http: httpRequest as NodeRequest,
  https: httpsRequest as NodeRequest,
};

/**
 * Node's built-in fetch uses Undici, whose multi-address connector can time out
 * on otherwise reachable Convex hosts on some macOS network paths. This narrow
 * Fetch-compatible adapter uses Node's proven http/https transport instead.
 */
export function createNodeHttpFetch({
  httpAgent = new HttpAgent({ keepAlive: true, maxFreeSockets: 4, maxSockets: 16 }),
  httpsAgent = new HttpsAgent({ keepAlive: true, maxFreeSockets: 4, maxSockets: 16 }),
  requesters = defaultRequesters,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: NodeHttpFetchOptions = {}): typeof globalThis.fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`Unsupported Convex URL protocol: ${url.protocol}`);
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const body = await requestBody(init?.body);
    const headers = new Headers(init?.headers);
    if (body !== undefined && !headers.has("content-length")) {
      headers.set("content-length", String(body.byteLength));
    }
    const outgoingHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoingHeaders[name] = value;
    });

    return await new Promise<Response>((resolve, reject) => {
      let connected = false;
      const options: RequestOptions = {
        method,
        headers: outgoingHeaders,
        signal: init?.signal ?? undefined,
      };
      const onResponse = (response: IncomingMessage) =>
        collectResponse(response, method, resolve, reject);
      const request =
        url.protocol === "https:"
          ? requesters.https(url, { ...options, agent: httpsAgent }, onResponse)
          : requesters.http(url, { ...options, agent: httpAgent }, onResponse);

      request.once("socket", (socket) => {
        connected = !socket.connecting;
        if (!connected) {
          socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
            connected = true;
          });
        }
      });
      request.setTimeout(requestTimeoutMs, () => {
        const error = Object.assign(new Error("Convex HTTP request timed out"), {
          code: "ETIMEDOUT",
          syscall: connected ? "read" : "connect",
        });
        request.destroy(error);
      });
      request.once("error", reject);
      request.end(body);
    });
  };
}

export type ConvexFetchRetry = {
  attempt: number;
  delayMs: number;
  error: unknown;
  phase: "connect" | "query-read";
};

export type ConvexFetchOptions = {
  fetchImpl?: typeof globalThis.fetch;
  retryDelaysMs?: readonly number[];
  onRetry?: (retry: ConvexFetchRetry) => void;
};

/**
 * Convex's HTTP client does not retry transport errors. Wrap its fetch so a
 * transient DNS/connect failure gets a few bounded attempts. Post-connect read
 * timeouts are replayed only for idempotent Convex query endpoints; mutations,
 * actions, application errors, HTTP failures, aborts, and TLS errors are not.
 */
export function createConvexFetch({
  fetchImpl = globalThis.fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  onRetry,
}: ConvexFetchOptions = {}): typeof globalThis.fetch {
  return async (input, init) => {
    let retryIndex = 0;
    const replayable = canReplayRequest(input, init);
    const queryRequest = replayable && isConvexQueryRequest(input);

    while (true) {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        const delayMs = retryDelaysMs[retryIndex];
        const phase = isRetryableConnectError(error)
          ? "connect"
          : queryRequest && isRetryableReadError(error)
            ? "query-read"
            : null;
        if (delayMs === undefined || !replayable || !phase) {
          throw error;
        }

        retryIndex += 1;
        onRetry?.({ attempt: retryIndex, delayMs, error, phase });
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  };
}
