---
name: feishu-codex-bridge
description: Deploy, configure, and troubleshoot a bridge that lets Feishu messages trigger Codex CLI tasks on a remote Mac or Linux host. Use when Codex needs to set up a Feishu bot, wire event callbacks to a local machine, validate Codex CLI login, enforce working-directory safety, or repair the bridge service after bot/auth/runtime failures.
---

# Feishu Codex Bridge

Use the bundled scripts. Do not rewrite the bridge from scratch unless the user explicitly asks for a redesign.

## Quick Start

1. Read [references/feishu-setup.md](references/feishu-setup.md) before touching Feishu settings.
2. Copy [assets/feishu-codex-bridge.env.example](assets/feishu-codex-bridge.env.example) to a real `.env` file on the target machine.
3. Run `npm install` in the skill directory.
4. Run `scripts/doctor.mjs` to validate `node`, `codex`, the env file, and the configured working directories.
5. Start the service with `scripts/run-bridge.sh`.
6. If the machine is a Mac that should stay online, install it with `scripts/install-launch-agent.sh`.

## Workflow

### 1. Prepare the host

- Require Node.js 20+ and a working `codex` binary in `PATH`.
- Require the user to run `codex login` on the target machine before enabling the bot.
- Keep the bridge behind a tunnel or reverse proxy if Feishu cannot reach the machine directly.
- Prefer a fixed service account directory such as `~/workspace` and expose only approved subdirectories via `CODEX_ALLOWED_DIRS`.

### 2. Configure Feishu

- Create a custom bot app.
- Enable event subscription for `im.message.receive_v1`.
- Prefer the Feishu long-connection mode. It does not need a public domain.
- Only configure a callback URL if the user explicitly wants webhook mode.
- Grant only the permissions needed to receive and send messages.

### 3. Configure the bridge

- Populate the env file with Feishu app credentials and a strict directory allowlist.
- Set `FEISHU_CONNECTION_MODE=websocket` unless the user explicitly wants webhook mode.
- Set `CODEX_REQUIRE_PREFIX=true` unless the bot lives in a dedicated 1:1 chat.
- Keep `CODEX_SANDBOX=workspace-write` by default.
- Set `CODEX_USE_DANGEROUS=false` unless the host is already isolated and the user explicitly wants unrestricted execution.

### 4. Validate and operate

- Use `node scripts/doctor.mjs --env /path/to/.env --smoke` after login to verify the Codex invocation path.
- Use `/codex ping` from Feishu to confirm end-to-end routing.
- Use `/codex status` to inspect the queue state and effective default directory.
- For work requests, accept:

```text
/codex
cwd=/absolute/or/relative/path
sandbox=workspace-write
请修复当前仓库里的 failing test，并在结尾说明改动。
```

### 5. Troubleshoot

- If websocket mode does not receive events, first confirm the app backend is configured for long connection and the Mac Mini can reach the public internet.
- If webhook mode cannot verify the callback, check the public URL, route, and verification token first.
- If messages are received but no reply is sent, inspect Feishu app credentials and message send permissions.
- If the bridge replies with busy errors, increase capacity only after confirming the host can safely run concurrent `codex exec` sessions.
- If `codex exec` fails, run the same command locally on the host before changing bridge code.

## Bundled Resources

### `scripts/bridge-server.mjs`

Run the bridge. It accepts Feishu events, validates them, queues tasks, invokes `codex exec --json`, keeps one active Codex session per Feishu chat, and replies back to the chat.

### `scripts/doctor.mjs`

Validate the env file, working directories, and optional Codex smoke test.

### `scripts/run-bridge.sh`

Start the bridge with a standard env-file location.

### `scripts/install-launch-agent.sh`

Install and load a macOS LaunchAgent for unattended operation.

### `references/feishu-setup.md`

Read when creating the Feishu app, deciding how to expose the callback URL, or checking required bot permissions.

### `references/message-protocol.md`

Read when changing the chat command grammar, allowlist behavior, or safety boundaries.
