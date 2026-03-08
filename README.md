# Feishu Codex Bridge

Use Feishu to trigger `codex exec` tasks on a remote Mac or Linux machine.

This repository contains two deliverables:

- A Codex skill installable under `~/.codex/skills/feishu-codex-bridge`
- A small bridge service that receives Feishu bot events and runs Codex CLI locally

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
- Feishu verification token validation
- No support yet for encrypted Feishu event payloads

## Prerequisites

- Node.js 20+
- `codex` available in `PATH`
- `codex login` already completed on the target machine
- A Feishu custom app/bot with event subscription enabled
- A public HTTPS callback URL that can reach the bridge

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
./scripts/install-skill.sh
```

## Deploy the bridge service

1. Create the env file:

```bash
mkdir -p ~/.config/feishu-codex-bridge
cp assets/feishu-codex-bridge.env.example ~/.config/feishu-codex-bridge/.env
```

2. Fill in the Feishu app credentials and allowed directories in the env file.

3. Validate the machine and the Codex CLI path:

```bash
node scripts/doctor.mjs --env ~/.config/feishu-codex-bridge/.env --smoke
```

4. Start the service manually:

```bash
./scripts/run-bridge.sh
```

5. Or install it as a macOS LaunchAgent:

```bash
./scripts/install-launch-agent.sh ~/.config/feishu-codex-bridge/.env
```

## Feishu bot setup

Read [references/feishu-setup.md](./references/feishu-setup.md).

Minimum setup:

- Create a custom app with a bot
- Enable event subscription
- Subscribe to `im.message.receive_v1`
- Set the callback URL to `https://your-domain.example/feishu/events`
- Keep encryption disabled for the first deployment

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
- [scripts/bridge-server.mjs](./scripts/bridge-server.mjs): HTTP bridge
- [scripts/doctor.mjs](./scripts/doctor.mjs): environment checks
- [scripts/install-skill.sh](./scripts/install-skill.sh): skill installer
- [scripts/install-launch-agent.sh](./scripts/install-launch-agent.sh): macOS service installer

## Quick verification

After startup:

```bash
curl http://127.0.0.1:8787/healthz
```

Then send `/codex ping` to the Feishu bot.
