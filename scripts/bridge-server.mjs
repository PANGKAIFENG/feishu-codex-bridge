#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import * as Lark from "@larksuiteoapi/node-sdk";

const envPath = path.resolve(process.env.FEISHU_CODEX_BRIDGE_ENV ?? path.join(process.env.HOME ?? ".", ".config/feishu-codex-bridge/.env"));
const fileEnv = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
const env = { ...process.env, ...fileEnv };
const config = buildConfig(env);
validateConfig(config);

const seenEvents = new Map();
const bridgeState = loadBridgeState(config.stateFile);

let activeTasks = 0;
let taskSeq = 0;
let tenantTokenCache = { token: "", expiresAt: 0 };
let wsClient = null;

const healthServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        connectionMode: config.connectionMode,
        activeTasks,
        maxConcurrent: config.maxConcurrent,
        routePath: config.routePath,
        defaultCwd: config.defaultCwd,
        stateFile: config.stateFile,
      });
    }

    if (config.connectionMode !== "webhook") {
      return sendJson(res, 404, { ok: false, error: "not_found" });
    }

    if (req.method !== "POST" || url.pathname !== config.routePath) {
      return sendJson(res, 404, { ok: false, error: "not_found" });
    }

    const rawBody = await readBody(req);
    const payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
    const response = await handleWebhookPayload(payload);
    return sendJson(res, response.statusCode, response.body);
  } catch (error) {
    console.error(`[bridge] request error: ${error.stack || error.message}`);
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

healthServer.listen(config.port, config.host, () => {
  console.log(`[bridge] health server listening on http://${config.host}:${config.port}/healthz`);
  if (config.connectionMode === "webhook") {
    console.log(`[bridge] webhook route listening on http://${config.host}:${config.port}${config.routePath}`);
  }
  console.log(`[bridge] env file: ${envPath}`);
  console.log(`[bridge] state file: ${config.stateFile}`);
});

if (config.connectionMode === "websocket") {
  await startWebSocketMode();
} else {
  console.log("[bridge] using webhook mode; Feishu must reach the callback URL.");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startWebSocketMode() {
  const dispatcher = new Lark.EventDispatcher({
    verificationToken: config.verificationToken || undefined,
    encryptKey: config.encryptKey || undefined,
    loggerLevel: Lark.LoggerLevel.info,
  }).register({
    "im.message.receive_v1": async (data) => {
      const eventId = data.event_id ?? data.uuid ?? data.message?.message_id ?? `${Date.now()}-${Math.random()}`;
      if (isDuplicateEvent(eventId)) {
        return;
      }
      const context = extractMessageContextFromEvent(data);
      if (!context) {
        return;
      }
      void handleMessage(context).catch((error) => {
        console.error(`[bridge] task failure: ${error.stack || error.message}`);
      });
    },
  });

  wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  console.log("[bridge] Feishu long connection started. No public callback URL is required.");
}

async function shutdown() {
  try {
    if (wsClient) {
      wsClient.close({ force: true });
    }
  } catch {
    // Ignore shutdown errors.
  }
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

async function handleWebhookPayload(payload) {
  if (payload.encrypt) {
    return { statusCode: 400, body: { ok: false, error: "encrypted_payload_not_supported" } };
  }

  verifyTokenIfConfigured(payload, config.verificationToken);

  if (payload.type === "url_verification" && payload.challenge) {
    return { statusCode: 200, body: { challenge: payload.challenge } };
  }

  if (payload.header?.event_type !== "im.message.receive_v1") {
    return { statusCode: 200, body: { code: 0, ignored: true } };
  }

  const eventId = payload.header?.event_id ?? payload.event_id ?? `${Date.now()}-${Math.random()}`;
  if (isDuplicateEvent(eventId)) {
    return { statusCode: 200, body: { code: 0, duplicate: true } };
  }

  const context = extractMessageContextFromPayload(payload);
  if (!context) {
    return { statusCode: 200, body: { code: 0, ignored: "unsupported_payload" } };
  }

  void handleMessage(context).catch((error) => {
    console.error(`[bridge] task failure: ${error.stack || error.message}`);
  });

  return { statusCode: 200, body: { code: 0 } };
}

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

  const chatState = getChatState(context.chatId);

  if (parsed.kind === "help") {
    await replyText(context.chatId, helpText(config, chatState));
    return;
  }
  if (parsed.kind === "ping") {
    await replyText(
      context.chatId,
      [
        "pong",
        `mode=${config.connectionMode}`,
        `active=${activeTasks}`,
        `active_session=${chatState.activeSessionId || "(none)"}`,
        `default_cwd=${config.defaultCwd ?? "(unset)"}`,
      ].join("\n"),
    );
    return;
  }
  if (parsed.kind === "status") {
    await replyText(context.chatId, formatStatus(context.chatId));
    return;
  }
  if (parsed.kind === "sessions") {
    await replySessions(context.chatId);
    return;
  }
  if (parsed.kind === "history") {
    await replyText(context.chatId, formatHistory(context.chatId, parsed.selection, parsed.limit));
    return;
  }
  if (parsed.kind === "new" && !parsed.body) {
    clearActiveSession(context.chatId);
    await replyText(context.chatId, "Started new-thread mode for this chat. The next /codex task will create a fresh Codex session.");
    return;
  }
  if (parsed.kind === "resume" && !parsed.selection && !parsed.body) {
    await replySessions(context.chatId);
    return;
  }
  if (parsed.kind === "resume" && parsed.selection && !parsed.body) {
    const selected = resolveResumeSelection(context.chatId, parsed.selection);
    if (!selected) {
      await replyText(context.chatId, `Session not found: ${parsed.selection}\n\n${formatSessions(context.chatId)}`);
      return;
    }
    setActiveSession(context.chatId, selected.id);
    await replyText(context.chatId, `Active session set to ${selected.id}\n${selected.title ? `title=${selected.title}\n` : ""}cwd=${selected.cwd || "(unknown)"}`);
    return;
  }

  if (activeTasks >= config.maxConcurrent) {
    await replyText(context.chatId, "Busy: another Codex task is still running. Try again later.");
    return;
  }

  const executionPlan = buildExecutionPlan(context, parsed, config);
  const taskId = `task-${Date.now()}-${++taskSeq}`;
  activeTasks += 1;

  await replyText(
    context.chatId,
    [
      `Accepted ${taskId}`,
      `mode=${executionPlan.mode}`,
      `session=${executionPlan.sessionId || "(new)"}`,
      `cwd=${executionPlan.cwd}`,
      `sandbox=${executionPlan.sandbox}`,
      "Starting Codex...",
    ].join("\n"),
  );

  const startedAt = Date.now();
  try {
    const result = await runCodexTask(executionPlan, config);
    const sessionId = result.threadId || executionPlan.sessionId || "";
    if (sessionId) {
      recordSession(context.chatId, sessionId, {
        cwd: executionPlan.cwd,
        title: resolveSessionTitle(sessionId, executionPlan.prompt),
        lastPrompt: summarizePrompt(executionPlan.prompt),
        prompt: executionPlan.prompt,
      });
      setActiveSession(context.chatId, sessionId);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = [
      `Completed ${taskId}`,
      `mode=${executionPlan.mode}`,
      `session=${sessionId || "(unknown)"}`,
      `cwd=${executionPlan.cwd}`,
      `duration=${seconds}s`,
      result.usage ? `usage=in ${result.usage.input_tokens} / out ${result.usage.output_tokens}` : "",
      "",
      truncate(result.finalMessage || "Codex returned no final message.", 3500),
    ]
      .filter(Boolean)
      .join("\n");
    await replyText(context.chatId, summary);
  } catch (error) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    await replyText(
      context.chatId,
      [
        `Failed ${taskId}`,
        `mode=${executionPlan.mode}`,
        `session=${executionPlan.sessionId || "(new)"}`,
        `cwd=${executionPlan.cwd}`,
        `duration=${seconds}s`,
        truncate(error.message, 3500),
      ].join("\n"),
    );
  } finally {
    activeTasks -= 1;
  }
}

function buildExecutionPlan(context, parsed, config) {
  if (parsed.kind === "new") {
    const request = buildTaskRequest(parsed.meta, parsed.body, config);
    return {
      mode: "new",
      sessionId: "",
      cwd: request.cwd,
      sandbox: request.sandbox,
      model: request.model,
      prompt: request.prompt,
    };
  }

  if (parsed.kind === "resume") {
    const selected = resolveResumeSelection(context.chatId, parsed.selection);
    if (!selected) {
      throw new Error(`Session not found: ${parsed.selection}`);
    }
    const request = buildResumeTaskRequest(parsed.meta, parsed.body, config, selected);
    return {
      mode: "resume",
      sessionId: selected.id,
      cwd: selected.cwd,
      sandbox: request.sandbox,
      model: request.model,
      prompt: request.prompt,
    };
  }

  const chatState = getChatState(context.chatId);
  const activeSession = chatState.activeSessionId ? getSessionRecord(chatState.activeSessionId) : null;
  if (activeSession) {
    const request = buildResumeTaskRequest(parsed.meta, parsed.body, config, activeSession);
    return {
      mode: "resume",
      sessionId: activeSession.id,
      cwd: activeSession.cwd || config.defaultCwd,
      sandbox: request.sandbox,
      model: request.model,
      prompt: request.prompt,
    };
  }

  const request = buildTaskRequest(parsed.meta, parsed.body, config);
  return {
    mode: "new",
    sessionId: "",
    cwd: request.cwd,
    sandbox: request.sandbox,
    model: request.model,
    prompt: request.prompt,
  };
}

function buildTaskRequest(meta, body, config) {
  const cwd = resolveCwd(meta.cwd, config);
  const sandbox = meta.sandbox || config.sandbox;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error(`Unsupported sandbox: ${sandbox}`);
  }
  if (sandbox === "danger-full-access" && !config.useDangerous) {
    throw new Error("danger-full-access is disabled by CODEX_USE_DANGEROUS=false");
  }
  const promptBody = String(body || "").trim();
  if (!promptBody) {
    throw new Error("Empty Codex task body.");
  }
  const prompt = config.promptPrefix ? `${config.promptPrefix.trim()}\n\n${promptBody}` : promptBody;
  return {
    cwd,
    sandbox,
    model: meta.model || config.model,
    prompt,
  };
}

function buildResumeTaskRequest(meta, body, config, sessionRecord) {
  if (meta.cwd && sessionRecord.cwd && path.resolve(meta.cwd) !== path.resolve(sessionRecord.cwd)) {
    throw new Error("Cannot change cwd while resuming an existing session. Use /codex new for a fresh thread.");
  }
  const sandbox = meta.sandbox || config.sandbox;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error(`Unsupported sandbox: ${sandbox}`);
  }
  if (sandbox === "danger-full-access" && !config.useDangerous) {
    throw new Error("danger-full-access is disabled by CODEX_USE_DANGEROUS=false");
  }
  const promptBody = String(body || "").trim();
  if (!promptBody) {
    throw new Error("Empty Codex task body.");
  }
  const prompt = config.promptPrefix ? `${config.promptPrefix.trim()}\n\n${promptBody}` : promptBody;
  return {
    cwd: sessionRecord.cwd || resolveCwd(config.defaultCwd, config),
    sandbox,
    model: meta.model || config.model,
    prompt,
  };
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

  const commandLine = bodyLines[0] ?? "";
  const lower = commandLine.toLowerCase();

  if (lower === "help") {
    return { kind: "help" };
  }
  if (lower === "ping") {
    return { kind: "ping" };
  }
  if (lower === "status") {
    return { kind: "status" };
  }
  if (lower === "sessions") {
    return { kind: "sessions" };
  }
  if (lower === "history" || lower.startsWith("history ")) {
    const remainder = commandLine.slice(7).trim();
    const tokens = remainder ? remainder.split(/\s+/u) : [];
    let selection = "";
    let limit = 5;
    for (const token of tokens) {
      if (!selection && isResumeSelector(token)) {
        selection = token;
        continue;
      }
      if (/^\d+$/u.test(token)) {
        limit = Number(token);
      }
    }
    return { kind: "history", selection, limit: Math.max(1, Math.min(limit, 10)) };
  }

  if (lower === "new" || lower.startsWith("new ")) {
    const remainder = commandLine.slice(3).trim();
    const task = parseTaskLines(remainder ? [remainder, ...bodyLines.slice(1)] : bodyLines.slice(1));
    return { kind: "new", meta: task.meta, body: task.body };
  }

  if (lower === "resume" || lower.startsWith("resume ")) {
    const remainder = commandLine.slice(6).trim();
    const tokens = remainder ? remainder.split(/\s+/u) : [];
    let selection = "";
    let initialBodyLines = bodyLines.slice(1);

    if (tokens.length > 0 && isResumeSelector(tokens[0])) {
      selection = tokens[0];
      const trailing = remainder.slice(selection.length).trim();
      if (trailing) {
        initialBodyLines = [trailing, ...initialBodyLines];
      }
    } else if (remainder) {
      initialBodyLines = [remainder, ...initialBodyLines];
    }

    const task = parseTaskLines(initialBodyLines);
    return {
      kind: "resume",
      selection,
      meta: task.meta,
      body: task.body,
    };
  }

  const task = parseTaskLines(bodyLines);
  return { kind: "task", meta: task.meta, body: task.body };
}

function parseTaskLines(lines) {
  const meta = {};
  const promptLines = [];
  let parsingMeta = true;

  for (const line of lines) {
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

  return {
    meta,
    body: promptLines.join("\n").trim(),
  };
}

function isResumeSelector(token) {
  return token === "last" || /^\d+$/u.test(token) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(token);
}

async function runCodexTask(executionPlan, config) {
  const args = [];
  if (config.profile) {
    args.push("-p", config.profile);
  }
  if (executionPlan.model) {
    args.push("-m", executionPlan.model);
  }
  args.push("-a", "never");

  if (executionPlan.mode === "resume") {
    args.push(
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      executionPlan.sessionId,
      executionPlan.prompt,
    );
  } else {
    args.push(
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      executionPlan.cwd,
      "--sandbox",
      executionPlan.sandbox,
      executionPlan.prompt,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: executionPlan.cwd,
    });

    let finalMessage = "";
    let usage = null;
    let threadId = executionPlan.sessionId || "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\nTimed out after ${config.timeoutMs}ms`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, config.timeoutMs);

    child.stdout.on("data", (chunk) => {
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
          // Ignore non-JSONL stdout.
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
        resolve({ threadId, finalMessage, usage, stderr });
        return;
      }
      reject(
        new Error(
          [
            `Codex exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
            finalMessage ? `last_message=${finalMessage}` : "",
            stderr ? `stderr=${truncate(stderr.trim(), 2000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function resolveCwd(requested, config) {
  const base = config.defaultCwd ? path.resolve(config.defaultCwd) : null;
  let candidate;

  if (!requested && base) {
    candidate = base;
  } else if (requested) {
    candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base ?? process.cwd(), requested);
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

function extractMessageContextFromPayload(payload) {
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

function extractMessageContextFromEvent(event) {
  if (!event?.message?.chat_id) {
    return null;
  }
  const senderId = event.sender?.sender_id ?? {};
  const content = parseMessageContent(event.message.content);
  return {
    chatId: event.message.chat_id,
    messageType: event.message.message_type ?? "",
    messageId: event.message.message_id ?? "",
    senderType: event.sender?.sender_type ?? "",
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

async function replySessions(chatId) {
  const sessions = listSessionsForChat(chatId);
  const active = getChatState(chatId).activeSessionId;
  const text = formatSessions(chatId);

  if (config.dryRunFeishu) {
    console.log(`[bridge] dry-run sessions card for ${chatId}:\n${text}`);
    return;
  }

  try {
    await replyCard(chatId, buildSessionsCard(sessions, active, text));
  } catch (error) {
    console.error(`[bridge] card reply failed, falling back to text: ${error.message}`);
    await replyText(chatId, text);
  }
}

async function replyCard(chatId, card) {
  const tenantToken = await getTenantAccessToken(config);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu card send failed: HTTP ${response.status} code=${data.code} msg=${data.msg}`);
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

function loadBridgeState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) {
      ensureParentDir(stateFile);
      return { version: 1, chats: {}, sessions: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      version: 1,
      chats: parsed.chats ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch (error) {
    console.error(`[bridge] failed to load state file ${stateFile}: ${error.message}`);
    return { version: 1, chats: {}, sessions: {} };
  }
}

function saveBridgeState() {
  ensureParentDir(config.stateFile);
  const tempFile = `${config.stateFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(bridgeState, null, 2));
  fs.renameSync(tempFile, config.stateFile);
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function getChatState(chatId) {
  if (!bridgeState.chats[chatId]) {
    bridgeState.chats[chatId] = {
      activeSessionId: "",
      sessionIds: [],
      updatedAt: new Date().toISOString(),
    };
  }
  return bridgeState.chats[chatId];
}

function getSessionRecord(sessionId) {
  const stored = bridgeState.sessions[sessionId];
  if (stored) {
    return stored;
  }
  const meta = readSessionIndexEntry(sessionId);
  if (!meta) {
    return null;
  }
  return {
    id: sessionId,
    title: meta.thread_name || "",
    cwd: "",
    createdAt: meta.updated_at || new Date().toISOString(),
    updatedAt: meta.updated_at || new Date().toISOString(),
    lastPrompt: "",
  };
}

function setActiveSession(chatId, sessionId) {
  const chatState = getChatState(chatId);
  chatState.activeSessionId = sessionId;
  chatState.updatedAt = new Date().toISOString();
  if (sessionId && !chatState.sessionIds.includes(sessionId)) {
    chatState.sessionIds.unshift(sessionId);
  }
  if (chatState.sessionIds.length > 30) {
    chatState.sessionIds = chatState.sessionIds.slice(0, 30);
  }
  saveBridgeState();
}

function clearActiveSession(chatId) {
  const chatState = getChatState(chatId);
  chatState.activeSessionId = "";
  chatState.updatedAt = new Date().toISOString();
  saveBridgeState();
}

function recordSession(chatId, sessionId, data) {
  const existing = bridgeState.sessions[sessionId] ?? {};
  const now = new Date().toISOString();
  const prompts = Array.isArray(existing.prompts) ? existing.prompts.slice(0, 19) : [];
  if (data.prompt) {
    prompts.unshift({
      ts: Math.floor(Date.now() / 1000),
      text: data.prompt,
    });
  }
  bridgeState.sessions[sessionId] = {
    id: sessionId,
    title: data.title || existing.title || "",
    cwd: data.cwd || existing.cwd || "",
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastPrompt: data.lastPrompt || existing.lastPrompt || "",
    prompts,
  };
  const chatState = getChatState(chatId);
  chatState.activeSessionId = sessionId;
  chatState.updatedAt = now;
  chatState.sessionIds = [sessionId, ...chatState.sessionIds.filter((id) => id !== sessionId)].slice(0, 30);
  saveBridgeState();
}

function resolveResumeSelection(chatId, selection) {
  if (!selection) {
    const activeId = getChatState(chatId).activeSessionId;
    return activeId ? getSessionRecord(activeId) : null;
  }
  const sessions = listSessionsForChat(chatId);
  if (selection === "last") {
    return sessions[0] ?? null;
  }
  if (/^\d+$/u.test(selection)) {
    return sessions[Number(selection) - 1] ?? null;
  }
  return getSessionRecord(selection);
}

function listSessionsForChat(chatId) {
  const chatState = getChatState(chatId);
  return chatState.sessionIds
    .map((id) => getSessionRecord(id))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function formatSessions(chatId) {
  const sessions = listSessionsForChat(chatId);
  const active = getChatState(chatId).activeSessionId;
  if (sessions.length === 0) {
    return "No recorded sessions for this chat yet.\nUse /codex with a task to create the first thread.";
  }
  return [
    "Sessions for this chat:",
    ...sessions.slice(0, 10).map((session, index) => {
      const marker = session.id === active ? "*" : " ";
      const shortId = session.id.slice(0, 8);
      return `${index + 1}. [${marker}] ${session.title || "(untitled)"} | id=${shortId} | cwd=${session.cwd || "(unknown)"}`;
    }),
    "",
    "Use '/codex resume N' or '/codex resume <session-id>' to switch the active thread.",
  ].join("\n");
}

function buildSessionsCard(sessions, activeId, fallbackText) {
  if (sessions.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "Codex Sessions" },
        template: "blue",
      },
      elements: [
        {
          tag: "markdown",
          content: fallbackText,
        },
      ],
    };
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Codex Sessions" },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: sessions
          .slice(0, 10)
          .map((session, index) => {
            const marker = session.id === activeId ? "ACTIVE" : " ";
            const shortId = session.id.slice(0, 8);
            const title = escapeLarkMd(session.title || "(untitled)");
            const cwd = escapeLarkMd(session.cwd || "(unknown)");
            return `**${index + 1}. ${title}**\n- status: ${marker}\n- id: \`${shortId}\`\n- cwd: \`${cwd}\``;
          })
          .join("\n\n"),
      },
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content: "Use `/codex resume N` to switch, `/codex history` to inspect recent prompts.",
      },
    ],
  };
}

function formatHistory(chatId, selection, limit) {
  const selected = resolveResumeSelection(chatId, selection);
  if (!selected) {
    return `No session found for history.\n\n${formatSessions(chatId)}`;
  }

  const entries = readSessionHistory(selected.id, limit, selected);
  if (entries.length === 0) {
    return [
      `History for ${selected.id}`,
      `title=${selected.title || "(untitled)"}`,
      "No local prompt history found for this session yet.",
    ].join("\n");
  }

  return [
    `History for ${selected.id}`,
    `title=${selected.title || "(untitled)"}`,
    `cwd=${selected.cwd || "(unknown)"}`,
    "",
    ...entries.map((entry, index) => `${index + 1}. ${formatTimestamp(entry.ts)}\n${truncate(entry.text, 500)}`),
  ].join("\n\n");
}

function readSessionHistory(sessionId, limit, sessionRecord = null) {
  const bridgeEntries = Array.isArray(sessionRecord?.prompts) ? sessionRecord.prompts.slice(0, limit) : [];
  if (bridgeEntries.length > 0) {
    return bridgeEntries;
  }

  const historyPath = path.join(process.env.HOME ?? ".", ".codex", "history.jsonl");
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/u);
  const entries = [];
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed.session_id === sessionId && parsed.text) {
        entries.push({
          ts: Number(parsed.ts) || 0,
          text: String(parsed.text),
        });
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return entries;
}

function formatTimestamp(ts) {
  if (!ts) {
    return "(unknown time)";
  }
  return new Date(ts * 1000).toISOString();
}

function formatStatus(chatId) {
  const chatState = getChatState(chatId);
  const active = chatState.activeSessionId ? getSessionRecord(chatState.activeSessionId) : null;
  return [
    "status",
    `mode=${config.connectionMode}`,
    `active=${activeTasks}`,
    `max_concurrent=${config.maxConcurrent}`,
    `active_session=${chatState.activeSessionId || "(none)"}`,
    `active_title=${active?.title || "(none)"}`,
    `active_cwd=${active?.cwd || config.defaultCwd || "(unknown)"}`,
    `tracked_sessions=${chatState.sessionIds.length}`,
  ].join("\n");
}

function resolveSessionTitle(sessionId, prompt) {
  const fromIndex = readSessionIndexEntry(sessionId);
  if (fromIndex?.thread_name) {
    return fromIndex.thread_name;
  }
  return summarizePrompt(prompt, 80);
}

function readSessionIndexEntry(sessionId) {
  const indexPath = path.join(process.env.HOME ?? ".", ".codex", "session_index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  const lines = fs.readFileSync(indexPath, "utf8").trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === sessionId) {
        return parsed;
      }
    } catch {
      // Ignore invalid lines.
    }
  }
  return null;
}

function summarizePrompt(prompt, limit = 60) {
  const firstLine = String(prompt || "").trim().split(/\r?\n/u)[0] ?? "";
  if (firstLine.length <= limit) {
    return firstLine;
  }
  return `${firstLine.slice(0, Math.max(limit - 3, 0))}...`;
}

function isDuplicateEvent(eventId) {
  cleanupSeenEvents();
  if (seenEvents.has(eventId)) {
    return true;
  }
  seenEvents.set(eventId, Date.now());
  return false;
}

function cleanupSeenEvents() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [eventId, seenAt] of seenEvents.entries()) {
    if (seenAt < cutoff) {
      seenEvents.delete(eventId);
    }
  }
}

function buildConfig(env) {
  const defaultCwd = env.CODEX_DEFAULT_CWD ? path.resolve(env.CODEX_DEFAULT_CWD) : "";
  const defaultStateFile = path.join(process.env.HOME ?? ".", ".config", "feishu-codex-bridge", "state.json");
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    routePath: env.ROUTE_PATH || "/feishu/events",
    connectionMode: env.FEISHU_CONNECTION_MODE || "websocket",
    feishuAppId: env.FEISHU_APP_ID || "",
    feishuAppSecret: env.FEISHU_APP_SECRET || "",
    verificationToken: env.FEISHU_VERIFICATION_TOKEN || "",
    encryptKey: env.FEISHU_ENCRYPT_KEY || "",
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
    allowedDirs: splitCsv(env.CODEX_ALLOWED_DIRS || defaultCwd).map((dir) => path.resolve(dir)),
    promptPrefix: env.CODEX_PROMPT_PREFIX || "",
    dryRunFeishu: parseBoolean(env.BRIDGE_DRY_RUN_FEISHU, false),
    stateFile: path.resolve(env.BRIDGE_STATE_FILE || defaultStateFile),
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
  if (!["websocket", "webhook"].includes(config.connectionMode)) {
    throw new Error("FEISHU_CONNECTION_MODE must be 'websocket' or 'webhook'.");
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

function helpText(config, chatState) {
  return [
    "Usage:",
    "/codex ping",
    "/codex status",
    "/codex sessions",
    "/codex history",
    "/codex history 2 6",
    "/codex new",
    "/codex new",
    "cwd=repo-or-absolute-path",
    "Your new task here",
    "/codex resume",
    "/codex resume 2",
    "/codex",
    "Your task here",
    "",
    `mode=${config.connectionMode}`,
    `active_session=${chatState.activeSessionId || "(none)"}`,
    `default_cwd=${config.defaultCwd || "(unset)"}`,
  ].join("\n");
}

function escapeLarkMd(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/_/g, "\\_");
}

function parseDotEnv(text) {
  const parsed = {};
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
    parsed[key] = value;
  }
  return parsed;
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
