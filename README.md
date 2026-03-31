# Adaptative Governance

> Adaptive governance overlay for OpenClaw agents — observes, diagnoses, experiments, and asks before changing.

**Adaptative Governance** is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that adds a governance layer to your AI agent. It watches how your agent behaves, detects quality issues and instability, runs bounded experiments, and asks for your approval before making structural changes.

## What the Project Does

The plugin observes your agent's messages and tool results to detect:

- **Uncertainty** — the agent expresses doubt or incomplete knowledge
- **Quality drops** — output quality degrades or contradicts earlier reasoning
- **Contradictions** — the agent reaches opposite conclusions over time
- **Error spikes** — a tool repeatedly fails with the same error
- **Capability gaps** — the agent tries to use unavailable or unauthorized tools

When thresholds are crossed, it creates diagnostics and can propose bounded experiments. Structural or sensitive changes always require explicit user approval before the agent proceeds.

## Why It's Useful

- **Safe experimentation** — test changes in bounded experiments before committing
- **Approval workflows** — structural changes never happen silently; you always decide
- **Non-destructive overlay** — the plugin never modifies your project files directly
- **Per-agent governance** — each agent can have its own governance mode
- **Event-driven** — analysis is triggered by actual agent behavior, not arbitrary timers
- **Audit trail** — every decision, experiment, and observation is logged

## How Users Can Get Started

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) gateway `2026.3.24-beta.2` or later
- Node.js 22+ (LTS)
- TypeScript 5+

### Installation

1. **Install the plugin:**

```bash
npm i openclaw-adaptative-governance
```

2. **Register with OpenClaw:**

If your OpenClaw version supports plugin auto-discovery, the plugin will be registered automatically from its manifest (`openclaw.plugin.json`). Otherwise, register it manually by adding to `openclaw.plugin.json` in your config directory:

```json
{
  "id": "adaptative-governance",
  "name": "Adaptative Governance",
  "description": "Adaptive governance overlay for OpenClaw agents",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "overlayMode": {
        "type": "string",
        "enum": ["light", "advanced", "experimental"],
        "default": "light"
      },
      "autoObserve": {
        "type": "boolean",
        "default": true
      }
    }
  }
}
```

Or install it via the OpenClaw CLI (if available):

```bash
openclaw plugins install openclaw-adaptative-governance
```

3. **Enable the plugin in your gateway config** (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "extensions": {
      "adaptative-governance": {
        "enabled": true,
        "overlayMode": "light"
      }
    }
  }
}
```

If your OpenClaw version auto-enables plugins listed in `openclaw.plugin.json`, this step may not be required.

4. **Restart the OpenClaw gateway.**

> **Note:** If installing from source instead of npm, run `npm run build` after `npm install` to produce the `dist/` output.

### Onboarding

After installation, onboard the plugin by choosing a governance mode:

```
/governance onboard <agent_id> 1|2|3
```

Example:

```bash
/governance onboard main 2
```

Modes:

| Mode | Description |
|------|-------------|
| `1` — Light | Observe and advise; no automatic experiments |
| `2` — Advanced | Observe in detail and log everything for review |
| `3` — Experimental | Proactive diagnostics and bounded experiments |

### Chat Commands

Once the agent is onboarded, interact via chat:

```bash
/governance              # Show status summary
/governance status       # Same as above
/governance onboard      # List agents and governance status
/governance onboard <id> # Show specific agent status
/governance onboard <id> 1|2|3  # Enable/configure governance
/governance diagnostics  # Show open diagnostics
/governance experiments  # Show all experiments
/governance audit [N]    # Show last N audit entries
/governance pause        # Pause governance
/governance resume       # Resume governance
/governance help         # Show all commands

/approve [code]           # Approve pending request
/deny [code]             # Deny pending request
```

Approval responses use short codes shown in `/governance status` (e.g. `GOV-1`, `GOV-2`):

```bash
/governance select GOV-1 2   # Select option 2 for GOV-1
/approve GOV-1                # Shorthand for approve
/deny GOV-1                   # Shorthand for deny
```

### Agent Tools

The plugin exposes 9 governance tools the agent can call directly:

| Tool | Description |
|------|-------------|
| `get_governance_status` | Summary of current governance state |
| `governance_onboard` | Set or change overlay mode |
| `governance_diagnose` | Record a diagnostic observation |
| `governance_propose_experiment` | Propose a bounded experiment |
| `governance_experiment_control` | Start, validate, reject, rollback, or archive |
| `governance_audit_log` | View recent audit entries |
| `governance_control` | Pause, resume, or change overlay mode |
| `governance_self_review` | Agent self-evaluation after a task |
| `governance_ask_self_review` | Request agent self-evaluation |

### Overlay Modes and Thresholds

Governance sensitivity is controlled by `overlayMode`:

| Signal | Light (4h) | Advanced (2h) | Experimental (1h) |
|--------|-------------|--------------|------------------|
| Contradictions | 5 | 3 | 2 |
| Uncertainties | 8 | 5 | 3 |
| Quality drops | 3 | 2 | 1 |
| Error spikes | 3 | 2 | 1 |

### Overlay Context Files

When an experiment is validated and adopted, the plugin writes a non-destructive overlay file to `<workspace>/governance/GOVERNANCE_ADOPTED.md`. The agent can read this file to understand what changes were adopted. Rollback moves the file to `governance/reverted/`.

## Project Structure

```
openclaw-plugin-adaptative-agent/
├── src/
│   ├── index.ts          # Plugin entry point (definePluginEntry)
│   ├── types.ts         # Core TypeScript types
│   ├── state.ts         # Runtime state and persistence
│   ├── service.ts       # Analysis engine and thresholds
│   ├── commands.ts       # Chat command handlers
│   ├── hooks/
│   │   └── observer.ts  # Event hook handlers
│   └── tools/
│       └── index.ts     # 9 governance tool definitions
├── openclaw.plugin.json # Plugin manifest
├── package.json
└── tsconfig.json
```

## Key Design Decisions

**Event-driven, not timer-driven** — analysis runs when the agent completes a task (`message:received`), not on an arbitrary schedule. This keeps governance responsive to actual agent behavior.

**Non-destructive overlay** — the plugin never edits your project files. Adopted changes are written to `governance/GOVERNANCE_ADOPTED.md` as a context file the agent can read.

**Per-agent governance** — each agent gets its own `governance.json` in their workspace. You can run different modes for different agents.

**Approval codes** — pending approvals use short codes (`GOV-1`, `GOV-2`…) so you can respond from any chat interface without quoting the full request.

## Build Commands

```bash
npm run build   # Compile TypeScript → dist/
npm run check   # Type-check without emitting
npm run dev     # Watch mode (tsc --watch)
```

## Where to Get Help

- OpenClaw documentation: [docs/index.md](docs/index.md)
- Hooks system: [docs/automation/hooks.md](docs/automation/hooks.md)
- OpenClaw GitHub: https://github.com/openclaw/openclaw
- Plugin SDK events (`message:preprocessed`, `tool_result_persist`, `message:received`) are documented in the hooks reference above.

## Who Maintains and Contributes

This plugin is maintained as part of the OpenClaw ecosystem. For issues, feature requests, or contributions related to this plugin, open an issue in this repository.

For general OpenClaw questions and support, see the [OpenClaw documentation](docs/index.md) or the [OpenClaw GitHub repository](https://github.com/openclaw/openclaw).

## License

MIT — same as OpenClaw.
