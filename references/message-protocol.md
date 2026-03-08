# Message Protocol

## Supported commands

The bridge is intentionally small. It supports:

- `/codex ping`
- `/codex status`
- `/codex help`
- `/codex` followed by a task body

Example:

```text
/codex
cwd=repo-a
sandbox=workspace-write
检查最近一次测试失败并修复。
```

## Metadata lines

The bridge reads these leading metadata lines before the prompt body:

- `cwd=...`
- `sandbox=read-only|workspace-write|danger-full-access`
- `model=...`

Metadata parsing stops at the first non-metadata line.

## Directory safety

- Absolute `cwd` values must live inside `CODEX_ALLOWED_DIRS`.
- Relative `cwd` values are resolved against `CODEX_DEFAULT_CWD`.
- If neither `cwd` nor `CODEX_DEFAULT_CWD` is set, the bridge rejects the request.

## Queue model

By default the bridge runs one Codex task at a time. Extra tasks are rejected with a busy reply. Increase `CODEX_MAX_CONCURRENT` only if:

- The machine has enough resources
- The repos are isolated
- The user accepts parallel session complexity
