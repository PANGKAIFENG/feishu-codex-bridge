# Feishu Codex Bridge

Use Feishu to trigger `codex exec` tasks on a remote Mac or Linux machine.

This repository contains two deliverables:

- A Codex skill installable under `~/.codex/skills/feishu-codex-bridge`
- A small bridge service that receives Feishu bot events and runs Codex CLI locally

Default mode is `websocket` long connection, which does not require a public callback domain.

## What it does

- Accepts Feishu text messages
- Requires a `/codex` prefix by default
- Restricts execution to approved working directories
- Runs `codex exec --json`
- Sends the result back to the same Feishu chat
- Supports unattended operation on macOS via LaunchAgent

## Current scope

- Text messages only
- Serial task execution by default
- `websocket` long connection is the default and recommended mode
- `webhook` callback mode is still available for compatibility
- Feishu verification token validation
- Encrypted payload handling is only delegated through the Feishu SDK path; the custom webhook parser still assumes plain payloads

## Prerequisites

- Node.js 20+
- `codex` available in `PATH`
- `codex login` already completed on the target machine
- A Feishu custom app/bot with event subscription enabled
- `npm install` run once in this repository
- For `webhook` mode only: a public HTTPS callback URL that can reach the bridge

## Install the skill

### Option 1: one-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/PANGKAIFENG/feishu-codex-bridge/main/scripts/install-skill.sh)
```

This installs the skill into `~/.codex/skills/feishu-codex-bridge`.

### Option 2: clone and install

```bash
git clone https://github.com/PANGKAIFENG/feishu-codex-bridge.git
cd feishu-codex-bridge
npm install
./scripts/install-skill.sh
```

## Deploy the bridge service

1. Create the env file:

```bash
mkdir -p ~/.config/feishu-codex-bridge
cp assets/feishu-codex-bridge.env.example ~/.config/feishu-codex-bridge/.env
```

2. Fill in the Feishu app credentials and allowed directories in the env file.

3. Install Node dependencies:

```bash
npm install
```

4. Validate the machine and the Codex CLI path:

```bash
node scripts/doctor.mjs --env ~/.config/feishu-codex-bridge/.env --smoke
```

5. Start the service manually:

```bash
./scripts/run-bridge.sh
```

6. Or install it as a macOS LaunchAgent:

```bash
./scripts/install-launch-agent.sh ~/.config/feishu-codex-bridge/.env
```

## Feishu bot setup

Read [references/feishu-setup.md](./references/feishu-setup.md).

Minimum setup:

- Create a custom app with a bot
- Enable event subscription
- Subscribe to `im.message.receive_v1`
- Choose `使用长连接接收事件` if you do not want a public domain
- Only set a callback URL if you explicitly switch to `webhook` mode

### Required Feishu permissions

The bridge only needs enough permission to receive chat messages and send a text reply back to the same chat.

Request these capabilities in the Feishu app:

- Bot capability enabled
- Event subscription enabled
- Message receive event: `im.message.receive_v1`
- Permission to send messages as the bot

In practice, if the app can receive bot message events and call the message send API successfully, the bridge has everything it needs.

You do not need calendar, contacts, docs, approval, or admin permissions for this project.

### How Feishu connects to the bridge

There are two supported connection modes.

#### Option A: long connection (`websocket`, recommended)

```text
Feishu user
  -> sends "/codex ..." to the bot
Mac Mini bridge
  -> opens an outbound long-lived WebSocket to Feishu
Feishu platform
  -> pushes im.message.receive_v1 over that connection
bridge-server.mjs
  -> parses the event and runs codex exec locally
bridge-server.mjs
  -> calls Feishu send-message API
Feishu user
  -> receives the result in the same chat
```

This mode does not require a public domain because the Mac Mini initiates the connection to Feishu.

#### Option B: callback (`webhook`, optional)

The integration path is:

```text
Feishu user
  -> sends "/codex ..." to the bot
Feishu platform
  -> POST https://your-domain.example/feishu/events
Public HTTPS endpoint / tunnel / reverse proxy
  -> forwards request to the Mac Mini bridge
bridge-server.mjs
  -> validates token and parses the message
  -> runs codex exec locally on the Mac Mini
  -> gets the final Codex result
bridge-server.mjs
  -> calls Feishu send-message API
Feishu user
  -> receives the result in the same chat
```

So Feishu does not connect to Codex directly in either mode.

In `websocket` mode, the Mac Mini bridge maintains the connection to Feishu.
In `webhook` mode, Feishu calls your HTTP callback.
In both modes, the local bridge talks to the `codex` CLI and then sends the result back through Feishu's message API.

### Required network path

For `websocket` mode, no public callback path is required.

For `webhook` mode, Feishu must be able to reach the bridge over HTTPS.

Typical `webhook` deployment:

- `bridge-server.mjs` listens on `127.0.0.1:8787`
- Cloudflare Tunnel, nginx, Caddy, or another reverse proxy exposes `https://your-domain.example/feishu/events`
- The proxy forwards that path to `http://127.0.0.1:8787/feishu/events`

If Feishu cannot reach the callback URL in `webhook` mode, the bot will never trigger the local Codex task.

### Feishu values used by the bridge

The bridge uses these env vars from your Feishu app:

- `FEISHU_CONNECTION_MODE`: `websocket` or `webhook`
- `FEISHU_APP_ID`: used to fetch a tenant access token
- `FEISHU_APP_SECRET`: used to fetch a tenant access token
- `FEISHU_VERIFICATION_TOKEN`: used to verify incoming callback payloads

The bridge then uses the tenant access token to call Feishu's send-message API and reply in chat.

## Message format

Basic health checks:

```text
/codex ping
/codex status
/codex help
```

Task request:

```text
/codex
cwd=/absolute/or/relative/path
sandbox=workspace-write
检查最近的报错并修复它，最后总结改动。
```

Supported metadata keys:

- `cwd=...`
- `sandbox=read-only|workspace-write|danger-full-access`
- `model=...`

Full protocol notes are in [references/message-protocol.md](./references/message-protocol.md).

## Safety defaults

- `CODEX_REQUIRE_PREFIX=true`
- `CODEX_USE_DANGEROUS=false`
- `CODEX_MAX_CONCURRENT=1`
- `CODEX_ALLOWED_DIRS` should be explicit

Do not expose unrestricted execution to a public or shared chat.

## Files

- [SKILL.md](./SKILL.md): agent-facing skill instructions
- [scripts/bridge-server.mjs](./scripts/bridge-server.mjs): bridge service for websocket or webhook mode
- [scripts/doctor.mjs](./scripts/doctor.mjs): environment checks
- [scripts/install-skill.sh](./scripts/install-skill.sh): skill installer
- [scripts/install-launch-agent.sh](./scripts/install-launch-agent.sh): macOS service installer

## Quick verification

After startup:

```bash
curl http://127.0.0.1:8787/healthz
```

Then send `/codex ping` to the Feishu bot.
