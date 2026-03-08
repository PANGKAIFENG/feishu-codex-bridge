#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const envPath = path.resolve(args.env ?? process.env.FEISHU_CODEX_BRIDGE_ENV ?? path.join(process.env.HOME ?? ".", ".config/feishu-codex-bridge/.env"));
const fileEnv = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
const config = { ...process.env, ...fileEnv };
const failures = [];

check(fs.existsSync(envPath), `env file exists at ${envPath}`, failures);
check(Boolean(config.FEISHU_APP_ID), "FEISHU_APP_ID is set", failures);
check(Boolean(config.FEISHU_APP_SECRET), "FEISHU_APP_SECRET is set", failures);
check(Boolean(config.CODEX_DEFAULT_CWD), "CODEX_DEFAULT_CWD is set", failures);

const allowedDirs = splitCsv(config.CODEX_ALLOWED_DIRS || config.CODEX_DEFAULT_CWD || "");
for (const dir of allowedDirs) {
  const resolved = path.resolve(dir);
  const exists = fs.existsSync(resolved);
  check(exists, `directory exists: ${resolved}`, failures);
  if (exists) {
    check(fs.statSync(resolved).isDirectory(), `path is a directory: ${resolved}`, failures);
  }
}

const nodeVersion = process.version;
check(Number(nodeVersion.slice(1).split(".")[0]) >= 20, `Node.js version is ${nodeVersion}`, failures);

const codexBin = config.CODEX_BIN || "codex";
await checkCommand(codexBin, ["--version"], "codex binary is callable", failures);

if (args.smoke) {
  const smokeCwd = path.resolve(config.CODEX_DEFAULT_CWD);
  const prompt = "Reply with exactly OK";
  const smokeArgs = ["-a", "never", "exec", "--json", "--skip-git-repo-check", "-C", smokeCwd, "--sandbox", config.CODEX_SANDBOX || "workspace-write", prompt];
  if (config.CODEX_MODEL) {
    smokeArgs.splice(2, 0, "-m", config.CODEX_MODEL);
  }
  if (config.CODEX_PROFILE) {
    smokeArgs.splice(2, 0, "-p", config.CODEX_PROFILE);
  }
  await checkCommand(codexBin, smokeArgs, "Codex smoke test returned success", failures);
}

if (failures.length > 0) {
  console.error("\nDoctor failed:");
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log("Doctor passed.");

function parseArgs(argv) {
  const parsed = { smoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--smoke") {
      parsed.smoke = true;
      continue;
    }
    if (arg === "--env") {
      parsed.env = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
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

function check(condition, message, failures) {
  if (condition) {
    console.log(`OK  ${message}`);
    return;
  }
  failures.push(message);
  console.error(`ERR ${message}`);
}

async function checkCommand(cmd, args, message, failures) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      failures.push(`${message}: ${error.message}`);
      console.error(`ERR ${message}: ${error.message}`);
      resolve();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`OK  ${message}`);
      } else {
        failures.push(`${message}: exit code ${code}${stderr ? ` (${tail(stderr)})` : ""}`);
        console.error(`ERR ${message}: exit code ${code}`);
      }
      resolve();
    });
  });
}

function tail(text) {
  const lines = text.trim().split(/\r?\n/u);
  return lines.slice(-3).join(" | ");
}
