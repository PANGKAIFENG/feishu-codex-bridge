#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const envPath = path.resolve(process.env.FEISHU_CODEX_BRIDGE_ENV ?? path.join(process.env.HOME ?? ".", ".config/feishu-codex-bridge/.env"));
const fileEnv = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
const env = { ...process.env, ...fileEnv };
const config = buildConfig(env);
validateConfig(config);

const seenEvents = new Map();
let activeTasks = 0;
let taskSeq = 0;
let tenantTokenCache = { token: "", expiresAt: 0 };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        activeTasks,
        maxConcurrent: config.maxConcurrent,
        routePath: config.routePath,
        defaultCwd: config.defaultCwd,
      });
    }

    if (req.method !== "POST" || url.pathname !== config.routePath) {
      return sendJson(res, 404, { ok: false, error: "not_found" });
    }

    const rawBody = await readBody(req);
    const payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};

    if (payload.encrypt) {
      return sendJson(res, 400, { ok: false, error: "encrypted_payload_not_supported" });
    }

    verifyTokenIfConfigured(payload, config.verificationToken);

    if (payload.type === "url_verification" && payload.challenge) {
      return sendJson(res, 200, { challenge: payload.challenge });
    }

    if (payload.header?.event_type !== "im.message.receive_v1") {
      return sendJson(res, 200, { code: 0, ignored: true });
    }

    const eventId = payload.header?.event_id ?? payload.event_id ?? `${Date.now()}-${Math.random()}`;
    cleanupSeenEvents();
    if (seenEvents.has(eventId)) {
      return sendJson(res, 200, { code: 0, duplicate: true });
    }
    seenEvents.set(eventId, Date.now());

    const context = extractMessageContext(payload);
    if (!context) {
      return sendJson(res, 200, { code: 0, ignored: "unsupported_payload" });
    }

    void handleMessage(context).catch((error) => {
      console.error(`[bridge] task failure: ${error.stack || error.message}`);
    });

    return sendJson(res, 200, { code: 0 });
  } catch (error) {
    console.error(`[bridge] request error: ${error.stack || error.message}`);
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[bridge] listening on http://${config.host}:${config.port}${config.routePath}`);
  console.log(`[bridge] env file: ${envPath}`);
});

async function handleMessage(context) {
  if (context.senderType === "bot") {
    return;
  }
  if (config.allowedChatIds.size > 0 && !config.allowedChatIds.has(context.chatId)) {
    await replyText(context.chatId, `Rejected: chat ${context.chatId} is not allowlisted.`);
    return;
  }
  if (!isAllowedSender(context.senderIds, config)) {
    await replyText(context.chatId, "Rejected: sender is not allowlisted.");
    return;
  }
  if (context.messageType !== "text") {
    await replyText(context.chatId, "Only text messages are supported.");
    return;
  }

  const parsed = parseIncomingCommand(context.text, config.requirePrefix);
  if (parsed.kind === "ignore") {
    return;
  }
  if (parsed.kind === "help") {
    await replyText(context.chatId, helpText(config));
    return;
  }
  if (parsed.kind === "ping") {
    await replyText(context.chatId, `pong\nactive=${activeTasks}\ndefault_cwd=${config.defaultCwd ?? "(unset)"}`);
    return;
  }
  if (parsed.kind === "status") {
    await replyText(
      context.chatId,
      [
        "status",
        `active=${activeTasks}`,
        `max_concurrent=${config.maxConcurrent}`,
        `default_cwd=${config.defaultCwd ?? "(unset)"}`,
        `allowed_dirs=${config.allowedDirs.join(", ") || "(none)"}`,
      ].join("\n"),
    );
    return;
  }

  if (activeTasks >= config.maxConcurrent) {
    await replyText(context.chatId, "Busy: another Codex task is still running. Try again later.");
    return;
  }

  const taskRequest = buildTaskRequest(parsed, config);
  const taskId = `task-${Date.now()}-${++taskSeq}`;
  activeTasks += 1;

  await replyText(
    context.chatId,
    [`Accepted ${taskId}`, `cwd=${taskRequest.cwd}`, `sandbox=${taskRequest.sandbox}`, `Starting Codex...`].join("\n"),
  );

  const startedAt = Date.now();
  try {
    const result = await runCodexTask(taskId, taskRequest, config);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = [
      `Completed ${taskId}`,
      `cwd=${taskRequest.cwd}`,
      `duration=${seconds}s`,
      result.threadId ? `thread=${result.threadId}` : "",
      result.usage ? `usage=in ${result.usage.input_tokens} / out ${result.usage.output_tokens}` : "",
      "",
      truncate(result.finalMessage || "Codex returned no final message.", 3500),
    ]
      .filter(Boolean)
      .join("\n");
    await replyText(context.chatId, summary);
  } catch (error) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const failure = [
      `Failed ${taskId}`,
      `cwd=${taskRequest.cwd}`,
      `duration=${seconds}s`,
      truncate(error.message, 3500),
    ].join("\n");
    await replyText(context.chatId, failure);
  } finally {
    activeTasks -= 1;
  }
}

function buildTaskRequest(parsed, config) {
  const cwd = resolveCwd(parsed.meta.cwd, config);
  const sandbox = parsed.meta.sandbox || config.sandbox;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error(`Unsupported sandbox: ${sandbox}`);
  }
  if (sandbox === "danger-full-access" && !config.useDangerous) {
    throw new Error("danger-full-access is disabled by CODEX_USE_DANGEROUS=false");
  }
  const model = parsed.meta.model || config.model;
  const promptBody = parsed.body.trim();
  if (!promptBody) {
    throw new Error("Empty Codex task body.");
  }
  const prompt = config.promptPrefix ? `${config.promptPrefix.trim()}\n\n${promptBody}` : promptBody;
  return { cwd, sandbox, model, prompt };
}

function parseIncomingCommand(text, requirePrefix) {
  const cleaned = sanitizeIncomingText(text);
  if (!cleaned) {
    return { kind: "ignore" };
  }

  const lines = cleaned.split(/\r?\n/u).map((line) => line.trim());
  const firstLine = lines[0] ?? "";
  let bodyLines = lines.slice();

  if (requirePrefix) {
    if (!firstLine.startsWith("/codex")) {
      return { kind: "ignore" };
    }
    const remainder = firstLine.slice("/codex".length).trim();
    bodyLines = remainder ? [remainder, ...lines.slice(1)] : lines.slice(1);
  } else if (firstLine.startsWith("/codex")) {
    const remainder = firstLine.slice("/codex".length).trim();
    bodyLines = remainder ? [remainder, ...lines.slice(1)] : lines.slice(1);
  }

  const normalized = bodyLines.join("\n").trim();
  if (!normalized) {
    return { kind: "help" };
  }
  if (normalized === "help") {
    return { kind: "help" };
  }
  if (normalized === "ping") {
    return { kind: "ping" };
  }
  if (normalized === "status") {
    return { kind: "status" };
  }

  const meta = {};
  const promptLines = [];
  let parsingMeta = true;
  for (const line of bodyLines) {
    if (!line) {
      if (!parsingMeta || promptLines.length > 0) {
        promptLines.push("");
      }
      continue;
    }
    if (parsingMeta) {
      const match = /^(cwd|sandbox|model)\s*=\s*(.+)$/u.exec(line);
      if (match) {
        meta[match[1]] = match[2].trim();
        continue;
      }
      parsingMeta = false;
    }
    promptLines.push(line);
  }

  return { kind: "task", meta, body: promptLines.join("\n").trim() };
}

async function runCodexTask(taskId, taskRequest, config) {
  const args = [];
  if (config.profile) {
    args.push("-p", config.profile);
  }
  if (taskRequest.model) {
    args.push("-m", taskRequest.model);
  }
  args.push("-a", "never");
  args.push(
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    taskRequest.cwd,
    "--sandbox",
    taskRequest.sandbox,
    taskRequest.prompt,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: taskRequest.cwd,
    });

    const stdoutLines = [];
    let stderr = "";
    let finalMessage = "";
    let usage = null;
    let threadId = "";
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\nTimed out after ${config.timeoutMs}ms`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, config.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutLines.push(chunk.toString("utf8"));
      for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
        if (!line.trim().startsWith("{")) {
          continue;
        }
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
          }
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
            finalMessage = event.item.text;
          }
          if (event.type === "turn.completed" && event.usage) {
            usage = event.usage;
          }
        } catch {
          // Ignore non-JSONL lines emitted by the CLI.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ taskId, threadId, finalMessage, usage, stdout: stdoutLines.join(""), stderr });
        return;
      }
      const message = [
        `Codex exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
        finalMessage ? `last_message=${finalMessage}` : "",
        stderr ? `stderr=${truncate(stderr.trim(), 2000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      reject(new Error(message));
    });
  });
}

function resolveCwd(requested, config) {
  const base = config.defaultCwd ? path.resolve(config.defaultCwd) : null;
  let candidate;
  if (requested) {
    candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base ?? process.cwd(), requested);
  } else if (base) {
    candidate = base;
  } else {
    throw new Error("No cwd was supplied and CODEX_DEFAULT_CWD is unset.");
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`cwd does not exist: ${candidate}`);
  }

  if (config.allowedDirs.length > 0 && !config.allowedDirs.some((allowed) => isWithin(candidate, allowed))) {
    throw new Error(`cwd is outside CODEX_ALLOWED_DIRS: ${candidate}`);
  }

  return candidate;
}

function isAllowedSender(senderIds, config) {
  if (
    config.allowedOpenIds.size === 0 &&
    config.allowedUnionIds.size === 0 &&
    config.allowedUserIds.size === 0
  ) {
    return true;
  }
  return (
    (senderIds.openId && config.allowedOpenIds.has(senderIds.openId)) ||
    (senderIds.unionId && config.allowedUnionIds.has(senderIds.unionId)) ||
    (senderIds.userId && config.allowedUserIds.has(senderIds.userId))
  );
}

function extractMessageContext(payload) {
  const event = payload.event ?? {};
  const message = event.message ?? {};
  const sender = event.sender ?? {};
  const senderId = sender.sender_id ?? {};
  const content = parseMessageContent(message.content);
  const chatId = message.chat_id ?? event.chat_id;
  if (!chatId) {
    return null;
  }

  return {
    chatId,
    messageType: message.message_type ?? "",
    messageId: message.message_id ?? "",
    senderType: sender.sender_type ?? "",
    senderIds: {
      openId: senderId.open_id ?? "",
      unionId: senderId.union_id ?? "",
      userId: senderId.user_id ?? "",
    },
    text: content.text ?? "",
  };
}

function parseMessageContent(content) {
  if (!content) {
    return {};
  }
  if (typeof content === "object") {
    return content;
  }
  try {
    return JSON.parse(content);
  } catch {
    return { text: String(content) };
  }
}

async function replyText(chatId, text) {
  if (config.dryRunFeishu) {
    console.log(`[bridge] dry-run reply to ${chatId}:\n${text}`);
    return;
  }

  const tenantToken = await getTenantAccessToken(config);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu send failed: HTTP ${response.status} code=${data.code} msg=${data.msg}`);
  }
}

async function getTenantAccessToken(config) {
  if (tenantTokenCache.token && tenantTokenCache.expiresAt > Date.now()) {
    return tenantTokenCache.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant access token: HTTP ${response.status} code=${data.code} msg=${data.msg}`);
  }

  tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max((data.expire - 120) * 1000, 60_000),
  };
  return tenantTokenCache.token;
}

function buildConfig(env) {
  const defaultCwd = env.CODEX_DEFAULT_CWD ? path.resolve(env.CODEX_DEFAULT_CWD) : "";
  const allowedDirs = splitCsv(env.CODEX_ALLOWED_DIRS || defaultCwd).map((dir) => path.resolve(dir));
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    routePath: env.ROUTE_PATH || "/feishu/events",
    feishuAppId: env.FEISHU_APP_ID || "",
    feishuAppSecret: env.FEISHU_APP_SECRET || "",
    verificationToken: env.FEISHU_VERIFICATION_TOKEN || "",
    allowedChatIds: new Set(splitCsv(env.FEISHU_ALLOWED_CHAT_IDS || "")),
    allowedOpenIds: new Set(splitCsv(env.FEISHU_ALLOWED_OPEN_IDS || "")),
    allowedUnionIds: new Set(splitCsv(env.FEISHU_ALLOWED_UNION_IDS || "")),
    allowedUserIds: new Set(splitCsv(env.FEISHU_ALLOWED_USER_IDS || "")),
    requirePrefix: parseBoolean(env.CODEX_REQUIRE_PREFIX, true),
    codexBin: env.CODEX_BIN || "codex",
    model: env.CODEX_MODEL || "",
    profile: env.CODEX_PROFILE || "",
    sandbox: env.CODEX_SANDBOX || "workspace-write",
    timeoutMs: Number(env.CODEX_TIMEOUT_MS || 1_800_000),
    useDangerous: parseBoolean(env.CODEX_USE_DANGEROUS, false),
    maxConcurrent: Number(env.CODEX_MAX_CONCURRENT || 1),
    defaultCwd,
    allowedDirs,
    promptPrefix: env.CODEX_PROMPT_PREFIX || "",
    dryRunFeishu: parseBoolean(env.BRIDGE_DRY_RUN_FEISHU, false),
  };
}

function validateConfig(config) {
  const required = [
    ["FEISHU_APP_ID", config.feishuAppId],
    ["FEISHU_APP_SECRET", config.feishuAppSecret],
  ];
  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`Missing required env: ${name}`);
    }
  }
  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error("PORT must be a positive number.");
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error("CODEX_TIMEOUT_MS must be a positive number.");
  }
  if (!Number.isFinite(config.maxConcurrent) || config.maxConcurrent <= 0) {
    throw new Error("CODEX_MAX_CONCURRENT must be a positive number.");
  }
}

function verifyTokenIfConfigured(payload, verificationToken) {
  if (!verificationToken) {
    return;
  }
  const token = payload.header?.token ?? payload.token;
  if (token !== verificationToken) {
    throw new Error("Invalid Feishu verification token.");
  }
}

function sanitizeIncomingText(text) {
  return String(text || "")
    .replace(/<at[^>]*>.*?<\/at>/giu, " ")
    .replace(/\r/g, "")
    .trim();
}

function helpText(config) {
  return [
    "Usage:",
    "/codex ping",
    "/codex status",
    "/codex help",
    "/codex",
    "cwd=repo-or-absolute-path",
    "sandbox=workspace-write",
    "Your task here",
    "",
    `default_cwd=${config.defaultCwd || "(unset)"}`,
  ].join("\n");
}

function cleanupSeenEvents() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [eventId, seenAt] of seenEvents.entries()) {
    if (seenAt < cutoff) {
      seenEvents.delete(eventId);
    }
  }
}

function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(limit - 20, 0))}\n...[truncated]`;
}

function isWithin(candidate, allowedRoot) {
  const relative = path.relative(allowedRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
