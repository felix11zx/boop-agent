import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import {
  createConvexFetch,
  createNodeHttpFetch,
  isRetryableConnectError,
  isRetryableReadError,
} from "../server/convex-fetch.js";

function connectError(code: string, syscall?: string) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect failed"), { code, syscall }),
  });
}

describe("Convex fetch", () => {
  it("adapts Node HTTP responses to the Fetch interface", async () => {
    let sentBody = "";
    const requester = vi.fn((url, options, onResponse) => {
      const request = new EventEmitter() as unknown as ClientRequest;
      request.setTimeout = vi.fn(() => request);
      request.destroy = vi.fn(() => request);
      request.end = vi.fn((body?: string | Buffer) => {
        sentBody = body?.toString() ?? "";
        const response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = 201;
        response.statusMessage = "Created";
        response.headers = {
          "content-type": "application/json",
          "x-transport": "node",
        };
        onResponse(response);
        response.end(JSON.stringify({ method: options.method, url: url.pathname }));
        return request;
      }) as ClientRequest["end"];
      return request;
    });
    const nodeFetch = createNodeHttpFetch({
      httpAgent: false,
      httpsAgent: false,
      requesters: { http: requester, https: requester },
      requestTimeoutMs: 1_000,
    });
    const response = await nodeFetch("https://convex.example/query", {
      body: '{"path":"agents:list"}',
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(sentBody).toBe('{"path":"agents:list"}');
    expect(response.status).toBe(201);
    expect(response.headers.get("x-transport")).toBe("node");
    await expect(response.json()).resolves.toEqual({ method: "POST", url: "/query" });
  });

  it("recognizes nested connection-establishment failures", () => {
    const aggregate = Object.assign(new Error("all connections failed"), {
      errors: [connectError("EHOSTUNREACH"), connectError("ECONNREFUSED")],
    });

    expect(isRetryableConnectError(connectError("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
    expect(isRetryableConnectError(aggregate)).toBe(true);
    expect(isRetryableConnectError(connectError("ETIMEDOUT", "connect"))).toBe(true);
  });

  it("does not retry ambiguous post-connect or application failures", async () => {
    const socketReset = connectError("ECONNRESET", "read");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(socketReset);
    const resilientFetch = createConvexFetch({ fetchImpl, retryDelaysMs: [0, 0, 0] });

    await expect(resilientFetch("https://example.test/api/query")).rejects.toBe(socketReset);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(isRetryableConnectError(new Error("Convex function failed"))).toBe(false);
  });

  it("retries post-connect read timeouts only for Convex queries", async () => {
    const readTimeout = connectError("ETIMEDOUT", "read");
    const response = new Response('{"status":"success"}', { status: 200 });
    const queryFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(readTimeout)
      .mockResolvedValueOnce(response);
    const onRetry = vi.fn();
    const resilientQueryFetch = createConvexFetch({
      fetchImpl: queryFetch,
      retryDelaysMs: [0],
      onRetry,
    });

    await expect(
      resilientQueryFetch("https://example.convex.cloud/api/query", {
        body: '{"path":"automations:list"}',
        method: "POST",
      }),
    ).resolves.toBe(response);
    expect(isRetryableReadError(readTimeout)).toBe(true);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "query-read", attempt: 1 }),
    );

    const mutationFetch = vi.fn<typeof fetch>().mockRejectedValue(readTimeout);
    const resilientMutationFetch = createConvexFetch({
      fetchImpl: mutationFetch,
      retryDelaysMs: [0],
    });
    await expect(
      resilientMutationFetch("https://example.convex.cloud/api/mutation", {
        body: '{"path":"messages:send"}',
        method: "POST",
      }),
    ).rejects.toBe(readTimeout);
    expect(mutationFetch).toHaveBeenCalledOnce();
  });

  it("rejects mixed aggregate failures and non-replayable request bodies", async () => {
    const mixedFailure = Object.assign(new Error("mixed connection results"), {
      errors: [connectError("EHOSTUNREACH"), connectError("ECONNRESET", "read")],
    });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(mixedFailure);
    const resilientFetch = createConvexFetch({ fetchImpl, retryDelaysMs: [0] });

    expect(isRetryableConnectError(mixedFailure)).toBe(false);
    await expect(
      resilientFetch("https://example.test/api/query", {
        body: new Blob(["body"]),
        method: "POST",
      }),
    ).rejects.toBe(mixedFailure);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a pre-connect failure and returns the successful response", async () => {
    const response = new Response('{"status":"success"}', { status: 200 });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValueOnce(response);
    const onRetry = vi.fn();
    const resilientFetch = createConvexFetch({
      fetchImpl,
      retryDelaysMs: [0],
      onRetry,
    });

    await expect(resilientFetch("https://example.test/api/query")).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 0, phase: "connect" }),
    );
  });

  it("stops after the configured number of retries", async () => {
    const failure = connectError("ECONNREFUSED");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const resilientFetch = createConvexFetch({ fetchImpl, retryDelaysMs: [0, 0] });

    await expect(resilientFetch("https://example.test/api/mutation")).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns HTTP failures without retrying them", async () => {
    const response = new Response("unavailable", { status: 503 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const resilientFetch = createConvexFetch({ fetchImpl, retryDelaysMs: [0, 0, 0] });

    await expect(resilientFetch("https://example.test/api/query")).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
