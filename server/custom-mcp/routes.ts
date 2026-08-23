import express from "express";
import type { NextFunction, Request, Response } from "express";
import { isTrustedLocalRequest } from "../local-access.js";
import { customMcpManager, type CustomMcpManager } from "./manager.js";

function requireLocal(req: Request, res: Response, next: NextFunction): void {
  if (isTrustedLocalRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: "Custom MCP controls are only available locally." });
}

export function createCustomMcpRouter(
  manager: CustomMcpManager = customMcpManager,
): express.Router {
  const router = express.Router();
  router.use(requireLocal);

  router.get("/status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(manager.status());
  });

  router.post("/connect", async (_req, res) => {
    try {
      res.json(await manager.connect());
    } catch (error) {
      res.status(manager.status().configured ? 502 : 400).json({
        ...manager.status(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/disconnect", async (_req, res) => {
    try {
      res.json(await manager.disconnect());
    } catch (error) {
      res.status(500).json({
        ...manager.status(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/refresh", async (_req, res) => {
    try {
      res.json(await manager.refresh());
    } catch (error) {
      res.status(502).json({
        ...manager.status(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
