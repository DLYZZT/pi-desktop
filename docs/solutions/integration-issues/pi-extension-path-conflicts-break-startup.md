---
title: Pi extension path conflicts break startup
date: 2026-08-19
category: integration-issues
module: Pi extensions
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - Pi reports duplicate --plan, skill_search, subagent, and todo registrations during startup
  - A workspace desktop-usage.ts copy cannot resolve pi-grok-usage beneath the workspace .pi directory
  - Starting with pi -ne bypasses the failure but disables required extensions
root_cause: config_error
resolution_type: code_fix
tags: [pi-extensions, extension-discovery, pi-coding-agent-dir, jiti, duplicate-registration]
---

# Pi extension path conflicts break startup

## Problem

Pi can load globally configured extensions alongside a trusted project's auto-discovered project extension directory. The incident's matching filenames under the shared skills repo and the product repo were consistent with the same extension set being active twice. The product copy of `desktop-usage.ts` also looked for `pi-grok-usage` in a workspace-local npm subtree that did not exist.

The ownership rule is explicit: global extensions live in `F:/Project/claude/skills/config/pi/extensions`, and `$PI_CODING_AGENT_DIR/settings.json` points every workspace to that directory ([`AGENTS.md:5`](../../../AGENTS.md)).

## Symptoms

Observed startup output supplied during the incident:

```text
Cannot find module '../npm/node_modules/pi-grok-usage/extensions/auth.ts'
Flag "--plan" conflicts with ...\.pi\extensions\plan-mode\index.ts
Tool "skill_search" conflicts with ...\.pi\extensions\skill-search.ts
Tool "subagent" conflicts with ...\.pi\extensions\subagent\index.ts
Tool "todo" conflicts with ...\.pi\extensions\todo.ts
```

These identifiers are registered by the canonical extension set in [plan mode](../../../../claude/skills/config/pi/extensions/plan-mode/index.ts), [skill search](../../../../claude/skills/config/pi/extensions/skill-search.ts), [subagent](../../../../claude/skills/config/pi/extensions/subagent/index.ts), and [todo](../../../../claude/skills/config/pi/extensions/todo.ts). Loading another copy therefore creates deterministic collisions.

## What Didn't Work

- `pi -ne` is a diagnostic escape hatch, not a fix. It suppresses discovery and also disables the desired extensions.
- Fixing only the product `desktop-usage.ts` import leaves duplicate registrations. Removing only the product extension directory without repointing machine settings leaves Pi configured to load a deleted path.
- Hard-coding an installation path replaces one invalid location assumption with a machine-specific one.
- An earlier external-copy attempt is excluded from this durable proof because no tree evidence remains.

## Solution

Use `F:/Project/claude/skills/config/pi/extensions` as the single canonical extension directory. Point machine-level Pi settings directly to it and remove the product repo's extension copy. The cleanup commit removes that duplicate tree and records the canonical source in the project's verification map.

Resolve Pi-managed packages from the active agent directory:

```ts
const agentDirectory = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const extensionDirectory = join(agentDirectory, "npm", "node_modules", "pi-grok-usage", "extensions");
```

The implementation is in [`desktop-usage.ts:39`](../../../../claude/skills/config/pi/extensions/desktop-usage.ts). Because `pi-grok-usage` ships TypeScript, the extension locates the Jiti loader bundled with the active Pi host and imports the package through it ([`desktop-usage.ts:13`](../../../../claude/skills/config/pi/extensions/desktop-usage.ts)). Dependencies load only when the Grok usage command runs ([`desktop-usage.ts:74`](../../../../claude/skills/config/pi/extensions/desktop-usage.ts)).

## Why This Works

One canonical directory executes each registration once. Package lookup follows the directory that owns Pi's installed npm packages instead of the shared directory that owns extension source. This separates extension ownership from runtime package ownership without adding another loader dependency.

All three corrections matter: deleting the product copy prevents trusted-project auto-discovery, repointing machine settings preserves the desired extension set, and `$PI_CODING_AGENT_DIR`-based package loading removes the missing-module failure.

## Prevention

- Keep the shared skills directory as the sole extension source; configure reuse by reference, not copying into product repos.
- Resolve Pi-installed packages from `$PI_CODING_AGENT_DIR`, never relative to a workspace extension file.
- Compare every path in a registration-conflict error before renaming tools or flags. In this incident, identical names plus matching extension filenames under two roots indicated duplicate discovery; generally, the output proves conflicting registrations, not copied trees.
- Run `pi --mode rpc --offline --no-session` after extension/config changes. Closed stdin makes RPC mode shut down after initialization; startup reaches extension diagnostics without sending a model request. This is the recorded M1 check ([`surfaces.md:8`](../../../.codex/agent-loop/surfaces.md)).

## Related Issues

No other repository solution document matched this failure as of 2026-08-19.
