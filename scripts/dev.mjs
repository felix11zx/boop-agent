#!/usr/bin/env node
// One command to run Boop locally: server + convex + debug dashboard + ngrok.
// Prefixes each child's output so you can tell who's saying what.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNgrokTrafficPolicy } from "./ngrok-traffic-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- preflight: Convex types must exist ----------------------------------
if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run this first:                                            │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// --- read PORT from .env.local ------------------------------------------
function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const envVars = readEnv();
const port = envVars.PORT || "3456";
const ngrokDomain = envVars.NGROK_DOMAIN || "";
const publicUrl = envVars.PUBLIC_URL || "";
const hasStaticUrl =
  publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1");
const useNgrok = !hasStaticUrl || Boolean(ngrokDomain);
const exclusiveSendblueWebhook = envVars.SENDBLUE_WEBHOOK_EXCLUSIVE === "true";
let convexEnvFile = null;
let ngrokTrafficPolicyFile = null;

function writeConvexDevEnvFile() {
  const convexUrl = envVars.VITE_CONVEX_URL || envVars.CONVEX_URL;
  const lines = [];
  if (envVars.CONVEX_DEPLOYMENT) {
    lines.push(`CONVEX_DEPLOYMENT=${envVars.CONVEX_DEPLOYMENT}`);
  }
  if (convexUrl) {
    // Convex CLI warns when both CONVEX_URL and VITE_CONVEX_URL are active.
    // The debug UI is Vite-based, and the server falls back to this value.
    lines.push(`VITE_CONVEX_URL=${convexUrl}`);
  }
  if (!lines.length) return null;
  const path = resolve(tmpdir(), `boop-convex-${process.pid}.env.local`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function writeNgrokTrafficPolicyFile() {
  const path = resolve(tmpdir(), `boop-ngrok-${process.pid}.json`);
  writeFileSync(path, `${JSON.stringify(createNgrokTrafficPolicy(), null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

// --- binary detection ---------------------------------------------------
function hasBinary(name) {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

const nodeCmd = process.env.BOOP_NODE_CMD || "node";

const packageBinPaths = {
  convex: ["convex", "bin", "main.js"],
  tsx: ["tsx", "dist", "cli.mjs"],
  vite: ["vite", "bin", "vite.js"],
};

function localBin(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const binPath = resolve(root, "node_modules", ".bin", `${name}${ext}`);
  if (existsSync(binPath)) return { cmd: binPath, args: [] };

  const packageBin = packageBinPaths[name];
  if (packageBin) {
    const scriptPath = resolve(root, "node_modules", ...packageBin);
    if (existsSync(scriptPath)) return { cmd: nodeCmd, args: [scriptPath] };
  }

  return { cmd: name, args: [] };
}

// --- color-prefixed child runner ----------------------------------------
const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  ngrok: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};
let dashboardUrl = "http://localhost:5173";
let resolveNgrokOutputUrl;
const ngrokOutputUrlReady = new Promise((resolve) => {
  resolveNgrokOutputUrl = resolve;
});

// Vite's http-proxy attaches its own socket error logger that can't be removed
// via configure(). EPIPE on WS reconnects is harmless — filter it at the
// stream level so the logs stay readable.
const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const prefix = `${C[name]}${name.padEnd(6)}${C.reset} │ `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);

      // ANSI-strip for matching without disturbing the display output.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (name === "debug") {
        const localMatch = plain.match(/Local:\s+(http:\/\/\S+)/);
        if (localMatch) dashboardUrl = localMatch[1].replace(/\/$/, "");
      }
      if (name === "ngrok") {
        const urlMatch =
          plain.match(/\burl=(https:\/\/\S+)/) ||
          plain.match(/Forwarding\s+(https:\/\/\S+)/);
        if (urlMatch) resolveNgrokOutputUrl(urlMatch[1].replace(/\/$/, ""));
      }

      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }

      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.ready = ready;
  return child;
}

// --- ngrok URL banner: poll local API after launch ----------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readNgrokUrl() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (res.ok) {
      const data = await res.json();
      return data.tunnels?.find((t) => t.proto === "https")?.public_url ?? null;
    }
  } catch {
    /* not up yet */
  }
  return null;
}

async function waitForNgrokUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const https = await readNgrokUrl();
    if (https) return https;
    await sleep(500);
  }
  return null;
}

function showBanner(url, stable, webhookSyncState) {
  const line = "═".repeat(68);
  const webhook = `${url}/sendblue/webhook`;
  const from = envVars.SENDBLUE_FROM_NUMBER;
  const fromLine = from
    ? `  📱 Text this Sendblue number:  ${from}  (from a DIFFERENT phone)`
    : `  ⚠ SENDBLUE_FROM_NUMBER is not set — outbound sends will fail.\n     Run: npm run sendblue:sync   (pulls it from the Sendblue CLI)`;

  const headline = stable
    ? `your STABLE public URL is live.`
    : `ngrok tunnel is live.`;
  const footerMessage =
    webhookSyncState === "synchronized"
      ? "The inbound webhook above was synchronized with Sendblue automatically."
      : webhookSyncState === "disabled"
        ? "Automatic Sendblue webhook sync is disabled. Run npm run sendblue:webhook -- <url> after changing the public URL."
        : "Sendblue webhook sync failed. Check the webhook log above, then run npm run sendblue:webhook:check.";
  const footer = `\n${C.dim}  ℹ ${footerMessage}${C.reset}\n`;

  console.log(`
${C.banner}${line}
  Boop is ready — ${headline}

  🐶 Debug dashboard (click me):   ${dashboardUrl}
  🌐 Public URL:                   ${url}
  📮 Sendblue webhook (inbound):   ${webhook}
${fromLine}
  🔒 Public ingress:               signed provider webhooks only
${line}${C.reset}${footer}`);
}

// --- main ---------------------------------------------------------------
let ngrokInstalled = false;
if (useNgrok) {
  ngrokInstalled = await hasBinary("ngrok");
  if (!ngrokInstalled) {
    console.log(`
${C.ngrok}! ngrok is not installed — running without a public tunnel.${C.reset}
${C.dim}  Install:   brew install ngrok         (macOS)
             or download from https://ngrok.com/download
  Auth:      ngrok config add-authtoken <token>
             (free token at https://dashboard.ngrok.com)
  Without ngrok you can still use the debug dashboard at http://localhost:5173
  — iMessage replies via Sendblue won't work until your server is reachable.${C.reset}
`);
  }
}

console.log(`\nBoop dev starting on port ${port}. Ctrl-C to stop everything.\n`);

// Background "new-version available?" check. Runs concurrently with the
// child services; output is prefixed with `upstream │ ` by run() so it
// won't collide with startup logs. Silent on the happy path. Not added to
// the `children` array because it exits on its own — we don't want its
// non-zero exit (which shouldn't happen but hedge anyway) to tear down dev.
run("upstream", nodeCmd, ["scripts/check-upstream.mjs"]);

const tsxBin = localBin("tsx");
const serverChild = run(
  "server",
  tsxBin.cmd,
  [...tsxBin.args, "watch", "server/index.ts"],
  /listening on :/,
);
convexEnvFile = writeConvexDevEnvFile();
const convexArgs = ["convex", "dev"];
if (convexEnvFile) convexArgs.push("--env-file", convexEnvFile);
const convexBin = localBin("convex");
const convexChild = run(
  "convex",
  convexBin.cmd,
  [...convexBin.args, ...convexArgs.slice(1)],
  /Convex functions ready/,
);
const viteBin = localBin("vite");
const debugChild = run(
  "debug",
  viteBin.cmd,
  [...viteBin.args, "--config", "debug/vite.config.ts"],
  /Local:\s+http/,
);
const children = [serverChild, convexChild, debugChild];

let ngrokUrlReady = Promise.resolve(null);
if (useNgrok && ngrokInstalled) {
  ngrokTrafficPolicyFile = writeNgrokTrafficPolicyFile();
  const protectedArgs = [
    `--traffic-policy-file=${ngrokTrafficPolicyFile}`,
    "--log=stdout",
    "--log-format=term",
    "--log-level=info",
  ];
  const args = ngrokDomain
    ? ["http", port, `--domain=${ngrokDomain}`, ...protectedArgs]
    : ["http", port, ...protectedArgs];
  const ngrokChild = run("ngrok", "ngrok", args);
  children.push(ngrokChild);
  ngrokUrlReady = Promise.race([
    ngrokOutputUrlReady,
    new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
  ]).then((url) => url ?? waitForNgrokUrl().catch(() => null));
}

// Wait for all the core services to be ready before printing the banner,
// so the URL isn't dangled in front of the user while Convex is still booting.
async function autoRegisterWebhook(publicUrl) {
  if (envVars.SENDBLUE_AUTO_WEBHOOK === "false") return "disabled";
  const webhookUrl = `${publicUrl}/sendblue/webhook`;
  const prefix = `${C.ngrok}webhook${C.reset} │ `;
  const args = [
    "scripts/sendblue-webhook.mjs",
    ...(exclusiveSendblueWebhook ? ["--exclusive"] : []),
    webhookUrl,
  ];
  const child = spawn(nodeCmd, args, {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return code === 0 ? "synchronized" : "failed";
}

let sendblueWebhookRegistrationUrl = "";
let sendblueWebhookRegistration = Promise.resolve();
function registerSendblueWebhookOnce(publicUrl) {
  if (sendblueWebhookRegistrationUrl === publicUrl) return sendblueWebhookRegistration;
  sendblueWebhookRegistrationUrl = publicUrl;
  sendblueWebhookRegistration = sendblueWebhookRegistration.then(() =>
    autoRegisterWebhook(publicUrl),
  );
  return sendblueWebhookRegistration;
}

async function registerSendblueWhenTunnelAppears() {
  await sleep(2500);
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const publicUrl = await readNgrokUrl();
    if (publicUrl) {
      await registerSendblueWebhookOnce(publicUrl);
      return;
    }
    await sleep(1000);
  }
}

async function autoRegisterComposioWebhook(publicUrl) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  const prefix = `${C.ngrok}composio${C.reset} │ `;
  const tsxBin = localBin("tsx");
  const child = spawn(tsxBin.cmd, [...tsxBin.args, "scripts/composio-webhook.ts", publicUrl], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

if (useNgrok && ngrokInstalled && !ngrokDomain) {
  registerSendblueWhenTunnelAppears().catch(() => {});
}

Promise.all([
  serverChild.ready,
  convexChild.ready,
  debugChild.ready,
  ngrokUrlReady,
])
  .then(async ([, , , ngrokUrl]) => {
    if (useNgrok && ngrokInstalled) {
      if (ngrokUrl) {
        // Synchronize both the URL and signing secret. This is required even
        // for a reserved domain because older dashboard-created webhooks may
        // not have Boop's signing secret yet.
        const webhookSyncState = await registerSendblueWebhookOnce(
          (await readNgrokUrl()) ?? ngrokUrl,
        );
        // Composio webhook subscription is fully programmatic (PATCHable),
        // so we can refresh it on every restart regardless of whether the
        // domain is reserved.
        await autoRegisterComposioWebhook(ngrokUrl);
        showBanner(ngrokUrl, Boolean(ngrokDomain), webhookSyncState);
      } else {
        console.log(
          `${C.ngrok}ngrok${C.reset} │ could not read tunnel URL from http://127.0.0.1:4040 — check ngrok output above.`,
        );
      }
    } else if (hasStaticUrl) {
      const webhookSyncState = await registerSendblueWebhookOnce(publicUrl);
      showBanner(publicUrl, true, webhookSyncState);
    } else {
      const line = "═".repeat(68);
      console.log(`
${C.banner}${line}
  Boop is running locally.

  🐶 Debug dashboard:   ${dashboardUrl}

  ⚠ No public tunnel configured. iMessage won't work until you expose
    the server. Use the Chat tab in the dashboard to test for now.
${line}${C.reset}
`);
    }
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (convexEnvFile) {
    try {
      unlinkSync(convexEnvFile);
    } catch {
      /* ignore */
    }
  }
  if (ngrokTrafficPolicyFile) {
    try {
      unlinkSync(ngrokTrafficPolicyFile);
    } catch {
      /* ignore */
    }
  }
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`\nA child process exited with code ${code}. Shutting down.`);
      shutdown(code);
    }
  });
}
