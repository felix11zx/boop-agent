#!/usr/bin/env node
// Registers (or re-registers) the inbound message webhook with Sendblue, so
// free-ngrok users don't have to paste into the dashboard every time their
// tunnel URL rotates.
//
// Usage:
//   node scripts/sendblue-webhook.mjs [--exclusive] <public-webhook-url>
//   node scripts/sendblue-webhook.mjs --check [--exclusive] [public-webhook-url]
//
// Behavior:
//   1. Uses the Sendblue API keys in .env.local (falling back to .env) to list current inbound hooks.
//   2. Removes any stale *.ngrok-free.app / *.ngrok-free.dev / *.ngrok.app / trycloudflare.com
//      webhooks of type=receive that don't match the new URL.
//      With --exclusive, removes every other receive URL (including an old
//      static/Tailscale URL) so inbound messages have one destination.
//   3. Adds the new URL as type=receive (unless already registered).

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const envPaths = [resolve(root, ".env"), resolve(root, ".env.local")];
const API_BASE = "https://api.sendblue.com";
const WEBHOOK_SECRET_CONTEXT = "boop-sendblue-webhook-v1";

export function deriveWebhookSecret(apiSecret) {
  return createHmac("sha256", apiSecret).update(WEBHOOK_SECRET_CONTEXT).digest("hex");
}

export function parseEnvText(content) {
  const env = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const closingQuote = value.lastIndexOf(quote);
      value = closingQuote > 0 ? value.slice(1, closingQuote) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }
  return env;
}

export function readEnvFiles(paths = envPaths, baseEnv = process.env) {
  const fileEnv = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    Object.assign(fileEnv, parseEnvText(readFileSync(path, "utf8")));
  }
  return { ...fileEnv, ...baseEnv };
}

function executableNames(name) {
  if (process.platform !== "win32") return [name];
  if (/\.(cmd|exe|bat)$/i.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

function commandSearchDirs() {
  const dirs = [
    resolve(root, "node_modules", ".bin"),
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean)),
  ];
  if (process.platform === "darwin") {
    dirs.push(
      resolve(homedir(), ".local", "bin"),
      resolve(homedir(), ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    );
  }
  dirs.push(dirname(process.execPath));
  return [...new Set(dirs)];
}

function resolveCommand(name) {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }
  for (const dir of commandSearchDirs()) {
    for (const executable of executableNames(name)) {
      const candidate = resolve(dir, executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function commandEnv() {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? "";
  return {
    ...process.env,
    [pathKey]: [...commandSearchDirs(), currentPath].filter(Boolean).join(delimiter),
  };
}

function spawnableNodeCommand() {
  const candidates = [
    process.env.BOOP_NODE_CMD,
    resolveCommand("node"),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"] : []),
    "node",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "node" || existsSync(candidate)) ?? "node";
}

function nodeScriptCommand(scriptPath, leading) {
  const node = spawnableNodeCommand();
  return { cmd: node, leading: [scriptPath, ...leading] };
}

function npmExecCommand(packageName, binName) {
  const npm = resolveCommand("npm");
  if (npm) {
    try {
      const npmCli = realpathSync(npm);
      if (npmCli.endsWith(".js")) {
        return nodeScriptCommand(npmCli, [
          "exec",
          "--yes",
          "--package",
          packageName,
          "--",
          binName,
        ]);
      }
    } catch {
      /* fall through to spawning npm directly */
    }
    return {
      cmd: npm,
      leading: ["exec", "--yes", "--package", packageName, "--", binName],
    };
  }

  const npx = resolveCommand("npx");
  if (npx) {
    try {
      const npxCli = realpathSync(npx);
      if (npxCli.endsWith(".js")) {
        return nodeScriptCommand(npxCli, ["-y", packageName]);
      }
    } catch {
      /* fall through to spawning npx directly */
    }
    return { cmd: npx, leading: ["-y", packageName] };
  }

  return null;
}

function sendblueInvoker() {
  const sendblue = resolveCommand("sendblue");
  if (sendblue) return { cmd: sendblue, leading: [] };

  const npmExec = npmExecCommand("@sendblue/cli", "sendblue");
  if (npmExec) return npmExec;

  throw new Error("Could not find sendblue, npx, or npm on PATH.");
}

function runCapture(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, env: commandEnv() });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", () => {});
    p.on("exit", (code) =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}`)),
    );
    p.on("error", fail);
  });
}

function parseWebhookLines(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const hooks = [];
  for (const line of clean.split(/\r?\n/)) {
    const urlMatch = line.match(/(https?:\/\/[^\s)]+)/);
    const typeMatch = line.match(
      /\b(receive|outbound|call_log|line_blocked|line_assigned|contact_created)\b/,
    );
    if (urlMatch && typeMatch) {
      hooks.push({ url: urlMatch[1], type: typeMatch[1] });
    }
  }
  return hooks;
}

const STALE_DOMAIN_RE = /(ngrok-free\.(app|dev)|ngrok\.app|trycloudflare\.com|loca\.lt)/;

function normalizeWebhookUrl(value) {
  const trimmed = value.replace(/\/$/, "");
  return trimmed.endsWith("/sendblue/webhook") ? trimmed : `${trimmed}/sendblue/webhook`;
}

async function readActiveTunnelUrl() {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.tunnels?.find((t) => t.proto === "https")?.public_url ?? null;
  } catch {
    return null;
  }
}

async function expectedWebhookUrl(env, explicitUrl) {
  if (explicitUrl) return normalizeWebhookUrl(explicitUrl);

  const tunnelUrl = await readActiveTunnelUrl();
  if (tunnelUrl) return normalizeWebhookUrl(tunnelUrl);

  const publicUrl = env.PUBLIC_URL || "";
  if (publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1")) {
    return normalizeWebhookUrl(publicUrl);
  }

  return null;
}

function sendblueHeaders(env, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "sb-api-key-id": env.SENDBLUE_API_KEY,
    "sb-api-secret-key": env.SENDBLUE_API_SECRET,
  };
}

async function sendblueJson(env, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      ...sendblueHeaders(env, Boolean(options.body)),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Sendblue API ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

export function parseApiWebhookListing(webhooks) {
  const hooks = [];
  for (const [type, entries] of Object.entries(webhooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const url = typeof entry === "string" ? entry : entry?.url;
      if (typeof url === "string") hooks.push({ url, type });
    }
  }
  return {
    current: hooks,
    globalSecret: typeof webhooks?.globalSecret === "string" ? webhooks.globalSecret : "",
  };
}

async function apiListWebhooks(env) {
  const raw = await sendblueJson(env, "/api/account/webhooks");
  return parseApiWebhookListing(raw.webhooks);
}

async function apiAddWebhook(env, url) {
  const secret = deriveWebhookSecret(env.SENDBLUE_API_SECRET);
  await sendblueJson(env, "/api/account/webhooks", {
    method: "POST",
    body: JSON.stringify({
      webhooks: [{ url, secret }],
      globalSecret: secret,
      type: "receive",
    }),
  });
}

async function apiRemoveWebhook(env, url) {
  await sendblueJson(env, "/api/account/webhooks", {
    method: "DELETE",
    body: JSON.stringify({ webhooks: [url], type: "receive" }),
  });
}

export async function resynchronizeWebhookSecret(
  url,
  listing,
  expectedSecret,
  removeWebhook,
  addWebhook,
) {
  const isRegistered = listing.current.some(
    (hook) => hook.type === "receive" && hook.url === url,
  );
  if (!isRegistered || listing.globalSecret === expectedSecret) return false;

  // Sendblue POST appends, so replace the matching URL instead of duplicating it.
  await removeWebhook(url);
  await addWebhook(url);
  return true;
}

async function cliListWebhooks() {
  const { cmd, leading } = sendblueInvoker();
  const listing = await runCapture(cmd, [...leading, "webhooks", "list"]);
  return {
    current: parseWebhookLines(listing),
    source: "cli",
    cmd,
    leading,
  };
}

async function listWebhooks(env) {
  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET) {
    try {
      const listing = await apiListWebhooks(env);
      return {
        ...listing,
        source: "api",
        signingReady:
          listing.globalSecret === deriveWebhookSecret(env.SENDBLUE_API_SECRET),
      };
    } catch (err) {
      const cli = await cliListWebhooks();
      return {
        ...cli,
        signingReady: false,
        warning: `API list failed (${err.message}); used Sendblue CLI instead.`,
      };
    }
  }

  const cli = await cliListWebhooks();
  return {
    ...cli,
    signingReady: false,
    warning: "SENDBLUE_API_KEY/SECRET are not set; used Sendblue CLI instead.",
  };
}

export function webhookCheck(
  url,
  current,
  source,
  signingReady,
  warning = "",
  options = {},
) {
  const exclusive = options.exclusive === true;
  const receive = current.filter((wh) => wh.type === "receive");
  const currentMatches = receive.filter((wh) => wh.url === url);
  const staleReceiveWebhooks = receive
    .map((wh) => wh.url)
    .filter((hookUrl) => hookUrl !== url && STALE_DOMAIN_RE.test(hookUrl));
  const otherReceiveWebhooks = receive
    .map((wh) => wh.url)
    .filter((hookUrl) => hookUrl !== url && !STALE_DOMAIN_RE.test(hookUrl));
  const hasUnexpectedHooks =
    staleReceiveWebhooks.length > 0 || (exclusive && otherReceiveWebhooks.length > 0);
  const ok = currentMatches.length > 0 && signingReady && !hasUnexpectedHooks;
  const state = ok
    ? "registered"
    : currentMatches.length > 0 ||
        staleReceiveWebhooks.length > 0 ||
        (exclusive && otherReceiveWebhooks.length > 0)
      ? "mismatch"
      : "missing";
  const detailParts = [];
  if (currentMatches.length === 0) {
    detailParts.push("active tunnel is not registered with Sendblue");
  } else if (currentMatches.length > 1) {
    detailParts.push(`active tunnel is registered ${currentMatches.length} times`);
  } else {
    detailParts.push("active tunnel is registered with Sendblue");
  }
  if (!signingReady) {
    detailParts.push("webhook signing secret is not synchronized");
  }
  if (staleReceiveWebhooks.length) {
    detailParts.push(`${staleReceiveWebhooks.length} stale tunnel hook(s) still registered`);
  }
  if (exclusive && otherReceiveWebhooks.length) {
    detailParts.push(`${otherReceiveWebhooks.length} other receive hook(s) still registered`);
  }
  if (warning) detailParts.push(warning);

  return {
    ok,
    state,
    source,
    exclusive,
    checkedAt: new Date().toISOString(),
    expectedWebhookUrl: url,
    registeredWebhookUrl: currentMatches[0]?.url || staleReceiveWebhooks[0] || "",
    currentRegistered: currentMatches.length > 0,
    currentCount: currentMatches.length,
    receiveWebhookCount: receive.length,
    staleReceiveWebhooks,
    otherReceiveWebhooks,
    details: detailParts.join("; "),
  };
}

function printWebhookCheck(check) {
  console.log(`[webhook] expected: ${check.expectedWebhookUrl}`);
  if (check.registeredWebhookUrl) {
    console.log(`[webhook] registered: ${check.registeredWebhookUrl}`);
  } else {
    console.log("[webhook] registered: none");
  }
  console.log(`[webhook] status: ${check.state}`);
  console.log(`[webhook] details: ${check.details}`);
}

export async function syncWebhooks(
  url,
  current,
  removeWebhook,
  addWebhook,
  options = {},
) {
  const exclusive = options.exclusive === true;
  const hasTarget = current.some((wh) => wh.type === "receive" && wh.url === url);

  // 1. Register the replacement before cleanup, so a failed add never removes
  // the last working receive destination.
  if (hasTarget) {
    console.log(`[webhook] already registered: ${url}`);
  } else {
    await addWebhook(url);
    console.log(`[webhook] registered ${url} (type=receive)`);
  }

  // 2. Remove stale ngrok/tunnel URLs so we don't accumulate zombie hooks.
  // Exclusive mode also removes old static URLs such as Tailscale Funnel.
  // Keep duplicate copies of the current URL. Sendblue's delete endpoint is
  // URL-based and may remove every matching row, which would turn a harmless
  // duplicate into a missing webhook during app restart.
  const removableUrls = new Set(
    current
      .filter((wh) => wh.type === "receive" && wh.url !== url)
      .map((wh) => wh.url)
      .filter((hookUrl) => exclusive || STALE_DOMAIN_RE.test(hookUrl)),
  );
  const removalErrors = [];
  for (const oldUrl of removableUrls) {
    try {
      await removeWebhook(oldUrl);
      console.log(
        exclusive
          ? `[webhook] removed previous receive hook ${oldUrl}`
          : `[webhook] removed stale ${oldUrl}`,
      );
    } catch (err) {
      removalErrors.push({ url: oldUrl, error: err });
      console.warn(`[webhook] could not remove ${oldUrl}: ${err.message}`);
    }
  }
  if (removalErrors.length > 0) {
    throw new Error(`failed to remove ${removalErrors.length} old receive webhook(s)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const json = args.includes("--json");
  const urlArg = args.find((arg) => !arg.startsWith("--"));
  const env = readEnvFiles();
  const exclusive =
    args.includes("--exclusive") || env.SENDBLUE_WEBHOOK_EXCLUSIVE === "true";
  const url = checkOnly ? await expectedWebhookUrl(env, urlArg) : urlArg;

  if (checkOnly && !url) {
    const result = {
      ok: false,
      state: "no-tunnel",
      source: "none",
      exclusive,
      checkedAt: new Date().toISOString(),
      expectedWebhookUrl: "",
      registeredWebhookUrl: "",
      currentRegistered: false,
      currentCount: 0,
      receiveWebhookCount: 0,
      staleReceiveWebhooks: [],
      otherReceiveWebhooks: [],
      details: "No active ngrok tunnel or PUBLIC_URL was found.",
    };
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      printWebhookCheck(result);
    }
    process.exit(2);
  }

  if (!url || !/^https?:\/\//.test(url)) {
    console.error("Usage: node scripts/sendblue-webhook.mjs [--exclusive] <public-webhook-url>");
    console.error(
      "   or: node scripts/sendblue-webhook.mjs --check [--exclusive] [public-webhook-url]",
    );
    process.exit(1);
  }

  const webhookUrl = normalizeWebhookUrl(url);

  if (checkOnly) {
    try {
      const { current, source, signingReady, warning } = await listWebhooks(env);
      const result = webhookCheck(webhookUrl, current, source, signingReady, warning, {
        exclusive,
      });
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        printWebhookCheck(result);
      }
      process.exit(result.ok ? 0 : 2);
    } catch (err) {
      const result = {
        ok: false,
        state: "error",
        source: "none",
        exclusive,
        checkedAt: new Date().toISOString(),
        expectedWebhookUrl: webhookUrl,
        registeredWebhookUrl: "",
        currentRegistered: false,
        currentCount: 0,
        receiveWebhookCount: 0,
        staleReceiveWebhooks: [],
        otherReceiveWebhooks: [],
        details: err.message,
      };
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        printWebhookCheck(result);
      }
      process.exit(1);
    }
  }

  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET) {
    try {
      const listing = await apiListWebhooks(env);
      const expectedSecret = deriveWebhookSecret(env.SENDBLUE_API_SECRET);
      if (await resynchronizeWebhookSecret(
        webhookUrl,
        listing,
        expectedSecret,
        (hookUrl) => apiRemoveWebhook(env, hookUrl),
        (hookUrl) => apiAddWebhook(env, hookUrl),
      )) {
        console.log("[webhook] synchronized Sendblue webhook signing secret");
      }
      await syncWebhooks(
        webhookUrl,
        listing.current,
        (hookUrl) => apiRemoveWebhook(env, hookUrl),
        (hookUrl) => apiAddWebhook(env, hookUrl),
        { exclusive },
      );
      return;
    } catch (err) {
      throw new Error(`Sendblue API registration failed: ${err.message}`);
    }
  }

  throw new Error(
    "SENDBLUE_API_KEY and SENDBLUE_API_SECRET are required to register a signed webhook.",
  );
}

const isDirectExecution = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
