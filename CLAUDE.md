# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Type Checking

```bash
npm run build   # Compile TypeScript → dist/
npm run check   # Type-check without emitting
npm run dev     # Watch mode (tsc --watch)
```

No test suite or linter is configured.

## Project Type

This is an **OpenClaw plugin** — not a standalone app. It extends an OpenClaw gateway with governance/oversight capabilities for AI agents. The plugin is loaded by the OpenClaw gateway at runtime via `definePluginEntry`.

Plugin SDK version: `2026.3.24-beta.2` (pinned in `openclaw.plugin.json` `compat.pluginApi`).

## High-Level Architecture

```
OpenClaw Gateway
    │
    ├── Loads plugin via definePluginEntry() (src/index.ts)
    │
    ├── registerTool()    → 9 governance tools exposed to the agent
    ├── registerCommand() → /governance, /approve, /deny chat commands
    ├── registerHook()    → 3 event hooks (message:preprocessed, message:received, tool_result_persist)
    └── registerService() → governance service (start/stop lifecycle)

Plugin State (runtime-store)
    │
    ├── Global state     → governance-state.json (debounced 10s)
    │   observations, diagnostics, experiments, approvals, auditLog
    │
    └── Per-agent state  → <agent-workspace>/governance.json
        agentId, mode, enabled, onboardedAt
```

### Core Design: Event-Driven (No Timer Loop)

Analysis is **triggered by events**, not by a timer:
- `message:preprocessed` → records observations (uncertainty, quality_drop, contradiction)
- `tool_result_persist` → records tool failures (error_spike, capability_gap)
- `message:received` → triggers `onAgentTaskComplete()` which runs all analysis checks

`onAgentTaskComplete()` (exported from `service.ts`) is the single entry point for analysis, called by the `message:received` hook after agent task completion.

### Overlay Non-Destructif

The plugin never modifies the agent's existing project files. Adopted changes are written to `<workspace>/governance/GOVERNANCE_ADOPTED.md` as an overlay context file the agent can read. Rollback moves this file to `governance/reverted/`.

### Per-Agent Governance

Each agent is onboarded independently via `/governance onboard <agent_id> <mode>`. Each agent gets its own `governance.json` in their workspace. The `message:received` hook extracts the `agentId` from `sessionKey` (format: `agent:<agentId>:...`) and checks `isAgentGovernanceActive(agentId)` before running analysis.

### Approval UX

Approvals use short codes (`GOV-1`, `GOV-2`…) shown in `/governance status`. Users respond via `/approve [code]`, `/deny [code]`, or `/governance select <code> <n>`. The agent never auto-interprets approval responses — everything goes through chat commands.

## SDK Import Conventions

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";  // PluginApi type
import type { ReplyPayload }     from "openclaw/plugin-sdk";         // Tool/command reply shape
```

Do NOT import `PluginCommandHandler` or `PluginCommandContext` from the SDK — they are not re-exported. Define them locally in `commands.ts`.

## Key Source Files

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry point — registers tools, commands, hooks, service |
| `src/state.ts` | Runtime state (runtime-store), persistence (governance-state.json), per-agent governance |
| `src/service.ts` | Analysis engine — thresholds, diagnostic creation, approval/experiment expiration checks |
| `src/hooks/observer.ts` | Three hook handlers + contradiction/opposite detection |
| `src/commands.ts` | Chat command handlers (governance, approve, deny) |
| `src/tools/index.ts` | 9 tool definitions (status, onboard, diagnose, experiment, audit, control, self-review…) |
| `src/types.ts` | Core types: `ChangeSeverity`, `ObservationSignal`, `Diagnostic`, `Experiment`, `ApprovalRequest`, `AuditKind`, `GovernanceState`, `PerAgentGovernance` |

## ChangeSeverity Taxonomy

Used to classify every diagnostic:
- `minor` — tuning, low impact
- `experimental` — plausible idea to test
- `structural` — notable protocol change (approval required)
- `sensitive` — secrets, new tools, network (approval explicit required)
- `optimization` — agent self-identified improvement opportunity
- `dangerous` — blocked from automation

## Threshold Modes

Governance sensitivity is controlled by `overlayMode`:
- `light` — 5 contradictions, 8 uncertainties, 3 quality drops, 3 error spikes (4h window)
- `advanced` — 3/5/2/2 (2h window)
- `experimental` — 2/3/1/1 (1h window)

Thresholds are defined in `service.ts` (`THRESHOLDS_LIGHT`, `THRESHOLDS_ADVANCED`, `THRESHOLDS_EXPERIMENTAL`).

## AuditKind Union

A **closed** union type in `types.ts`. When adding new audit events, you must add the corresponding string literal to `AuditKind`. Currently covers: observation, diagnostic, experiment, approval, state, self-review, and agent governance lifecycle events.
