const WEBHOOK_ROUTES = Object.freeze([
  Object.freeze({ method: "POST", path: "/sendblue/webhook" }),
  Object.freeze({ method: "POST", path: "/composio/webhook" }),
]);

function routeExpression({ method, path }) {
  return `(req.method == '${method}' && req.url.path == '${path}')`;
}

/**
 * Keep the public ngrok edge limited to signed provider callbacks. The debug
 * dashboard, chat API, browser controls, health endpoint, and every other
 * local route stay unreachable from the public internet.
 */
export function createNgrokTrafficPolicy(routes = WEBHOOK_ROUTES) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new TypeError("At least one ngrok webhook route is required");
  }

  const allowExpression = routes.map(routeExpression).join(" || ");
  return {
    on_http_request: [
      {
        name: "Block every route except signed provider webhooks",
        expressions: [`!(${allowExpression})`],
        actions: [
          {
            type: "deny",
            config: { status_code: 404 },
          },
        ],
      },
    ],
  };
}

export function ngrokWebhookRoutes() {
  return WEBHOOK_ROUTES.map((route) => ({ ...route }));
}
