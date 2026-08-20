import { describe, expect, it } from "vitest";
import {
  createNgrokTrafficPolicy,
  ngrokWebhookRoutes,
} from "../scripts/ngrok-traffic-policy.mjs";

describe("ngrok webhook traffic policy", () => {
  it("allows only the two signed provider POST endpoints", () => {
    expect(ngrokWebhookRoutes()).toEqual([
      { method: "POST", path: "/sendblue/webhook" },
      { method: "POST", path: "/composio/webhook" },
    ]);

    const policy = createNgrokTrafficPolicy();
    const rule = policy.on_http_request[0];
    expect(rule.actions).toEqual([
      { type: "deny", config: { status_code: 404 } },
    ]);
    expect(rule.expressions[0]).toContain(
      "req.method == 'POST' && req.url.path == '/sendblue/webhook'",
    );
    expect(rule.expressions[0]).toContain(
      "req.method == 'POST' && req.url.path == '/composio/webhook'",
    );
    expect(rule.expressions[0]).not.toContain("/chat");
    expect(rule.expressions[0]).not.toContain("/health");
  });

  it("refuses to create a policy with no allowed route", () => {
    expect(() => createNgrokTrafficPolicy([])).toThrow(
      "At least one ngrok webhook route is required",
    );
  });
});
