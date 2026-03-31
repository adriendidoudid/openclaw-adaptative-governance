import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import {
  getState,
  getPendingApproval,
  getAllPendingApprovals,
  getOpenDiagnostics,
  getRunningExperiments,
  getPendingExperiments,
  getApprovalRequestByShortCode,
  resolveApprovalRequest,
  setOverlayMode,
  pauseGovernance,
  resumeGovernance,
  logAudit,
  getAuditLog,
  getConfiguredAgentIds,
  loadAgentGovernance,
  setAgentGovernance,
  disableAgentGovernance,
  getAgentWorkspace,
} from "./state.js";
import { ONBOARDING_MESSAGE } from "./service.js";

// ─── Local types (SDK internals not re-exported from openclaw/plugin-sdk) ───────

interface PluginCommandContext {
  senderId?: string;
  channel: string;
  channelId?: string;
  isAuthorizedSender: boolean;
  gatewayClientScopes?: string[];
  args?: string;
  commandBody: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
}

type PluginCommandHandler = (ctx: PluginCommandContext) => ReplyPayload | Promise<ReplyPayload>;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function textReply(text: string): ReplyPayload {
  return { text };
}

function fmtExperiment(exp: ReturnType<typeof getRunningExperiments>[0] | ReturnType<typeof getPendingExperiments>[0]): string {
  const status = exp.status.padEnd(8);
  const desc = exp.description.slice(0, 60);
  const hours = Math.round(exp.bounds.durationMs / 3600000);
  return `  [${exp.id.slice(0, 8)}] ${status} ${desc}${desc.length >= 60 ? "..." : ""} (${hours}h)`;
}

// ─── Command: /governance ────────────────────────────────────────────────────────

const governanceHandler: PluginCommandHandler = async (ctx: PluginCommandContext): Promise<ReplyPayload> => {
  const args = (ctx.args ?? "").trim().toLowerCase();
  const parts = args.split(/\s+/);
  const sub = parts[0] ?? "";

  // /governance (no args) → status summary
  if (!sub || sub === "status") {
    return await handleGovStatus(ctx);
  }

  switch (sub) {
    case "onboard":
    case "mode":
      return await handleGovOnboard(ctx, parts.slice(1));
    case "approve":
      return handleGovApprove(ctx, parts.slice(1));
    case "deny":
      return handleGovDeny(ctx, parts.slice(1));
    case "select":
      return handleGovSelect(ctx, parts.slice(1));
    case "diag":
    case "diagnostics":
      return handleGovDiag(ctx);
    case "experiments":
    case "exp":
      return handleGovExperiments(ctx);
    case "audit":
      return handleGovAudit(ctx, parts.slice(1));
    case "pause":
      return handleGovPause(ctx);
    case "resume":
      return handleGovResume(ctx);
    case "help":
      return handleGovHelp(ctx);
    default:
      return textReply(
        `Unknown governance command: "${sub}".\n\n` +
        `Use /governance help to see available commands.`,
      );
  }
};

async function handleGovStatus(_ctx: PluginCommandContext): Promise<ReplyPayload> {
  const state = getState();
  const running = getRunningExperiments();
  const pending = getPendingExperiments();
  const diagnostics = getOpenDiagnostics();
  const approvals = getAllPendingApprovals();
  const lastApproval = getPendingApproval();
  const agentIds = getConfiguredAgentIds();

  const lines: string[] = [];

  lines.push(`**Adaptative Governance** — ${state.paused ? "PAUSED" : "active"}`);
  lines.push("");

  // Per-agent governance status
  const agentGovEntries: string[] = [];
  for (const agentId of agentIds) {
    const gov = await loadAgentGovernance(agentId);
    if (gov && gov.enabled) {
      agentGovEntries.push(`  [${agentId}] **${gov.mode}**`);
    }
  }
  if (agentIds.length > 0) {
    lines.push(`**Governed agents (${agentGovEntries.length}/${agentIds.length})**`);
    if (agentGovEntries.length > 0) {
      lines.push(...agentGovEntries);
    } else {
      lines.push(`  None onboarded. Use /governance onboard <id> 1|2|3`);
    }
    lines.push("");
  }

  if (approvals.length > 0) {
    lines.push(`**Pending approvals (${approvals.length})**`);
    for (const a of approvals) {
      const ageMin = Math.round((Date.now() - a.requestedAt) / 60000);
      lines.push(`  [${a.shortCode}] (${ageMin}m ago)`);
      const preview = a.question.replace(/\n/g, " ").slice(0, 80);
      lines.push(`  ${preview}${preview.length >= 80 ? "..." : ""}`);
      lines.push(`  Options: ${a.options.join(" | ")}`);
      lines.push("");
    }
  } else if (lastApproval) {
    const ageMin = Math.round((Date.now() - lastApproval.requestedAt) / 60000);
    lines.push(`**Pending approval** [${lastApproval.shortCode}] (${ageMin}m ago)`);
    lines.push(`  ${lastApproval.question.replace(/\n/g, " ").slice(0, 100)}`);
    lines.push(`  Options: ${lastApproval.options.join(" | ")}`);
    lines.push("");
    lines.push(`Respond with: /governance select ${lastApproval.shortCode} <1-${lastApproval.options.length}>`);
    lines.push(`Or: /approve ${lastApproval.shortCode} | /deny ${lastApproval.shortCode}`);
  }

  if (running.length > 0) {
    lines.push(`**Running experiments (${running.length})**`);
    for (const e of running) lines.push(fmtExperiment(e));
    lines.push("");
  }

  if (pending.length > 0) {
    lines.push(`**Pending experiments (${pending.length})**`);
    for (const e of pending) lines.push(fmtExperiment(e));
    lines.push("");
  }

  if (diagnostics.length > 0) {
    lines.push(`**Open diagnostics (${diagnostics.length})**`);
    for (const d of diagnostics.slice(0, 3)) {
      lines.push(`  [${d.id.slice(0, 8)}] ${d.severity.padEnd(12)} ${d.problem.slice(0, 70)}`);
    }
    if (diagnostics.length > 3) lines.push(`  ...and ${diagnostics.length - 3} more`);
    lines.push("");
  }

  if (approvals.length === 0 && running.length === 0 && pending.length === 0 && diagnostics.length === 0) {
    lines.push("Everything is quiet. No pending approvals, experiments, or diagnostics.");
  }

  lines.push("");
  lines.push(`Type /governance help for available commands.`);

  return textReply(lines.join("\n"));
}

async function handleGovOnboard(ctx: PluginCommandContext, args: string[]): Promise<ReplyPayload> {
  const modeMap: Record<string, "light" | "advanced" | "experimental"> = {
    "1": "light",
    "2": "advanced",
    "3": "experimental",
    light: "light",
    advanced: "advanced",
    experimental: "experimental",
  };

  const agentIds = getConfiguredAgentIds();

  // /governance onboard — list all agents and their governance status
  if (args.length === 0) {
    const lines: string[] = [];
    lines.push(`**Governance Onboarding**`);
    lines.push("");
    lines.push(`**${agentIds.length}** agent(s) in config:`);
    lines.push("");

    for (const agentId of agentIds) {
      const gov = await loadAgentGovernance(agentId);
      const workspace = getAgentWorkspace(agentId) ?? "unknown";
      if (gov && gov.enabled) {
        lines.push(`  [${agentId}] **${gov.mode}** (enabled, ${Math.round((Date.now() - gov.onboardedAt) / 86400000)}d ago)`);
      } else {
        lines.push(`  [${agentId}] not onboarded`);
      }
    }

    lines.push("");
    lines.push(`**Configure an agent:**`);
    lines.push(`  /governance onboard <agent_id> 1|2|3`);
    lines.push("");
    lines.push(`**Examples:**`);
    lines.push(`  /governance onboard main 2        — advanced mode for 'main'`);
    lines.push(`  /governance onboard work 3        — experimental mode for 'work'`);
    lines.push(`  /governance onboard main            — see status of 'main'`);
    lines.push("");
    lines.push(`**Overlay modes:**`);
    lines.push(`  1 = Light (observe and advise)`);
    lines.push(`  2 = Advanced (observe, advise, log in detail)`);
    lines.push(`  3 = Experimental (proactive diagnostics + experiments)`);

    return textReply(lines.join("\n"));
  }

  // /governance onboard <agent_id> — show that agent's status
  const agentId = args[0];
  if (args.length === 1) {
    if (!agentIds.includes(agentId)) {
      return textReply(`Agent "${agentId}" not found in config.\n\nKnown agents: ${agentIds.join(", ")}`);
    }
    const gov = await loadAgentGovernance(agentId);
    const workspace = getAgentWorkspace(agentId) ?? "unknown";

    if (!gov || !gov.enabled) {
      return textReply(
        `**Agent: ${agentId}**\n\n` +
        `Governance: not active\n` +
        `Workspace: ${workspace}\n\n` +
        `Enable: /governance onboard ${agentId} 1|2|3`,
      );
    }

    const modeDesc: Record<string, string> = {
      light: "Observe and advise (no automatic experiments)",
      advanced: "Observe, advise, and log in detail",
      experimental: "Proactive diagnostics + bounded experiments",
    };

    return textReply(
      `**Agent: ${agentId}**\n\n` +
      `Governance: **${gov.mode}** (active since ${new Date(gov.onboardedAt).toLocaleDateString()})\n` +
      `Workspace: ${workspace}\n\n` +
      `${modeDesc[gov.mode]}\n\n` +
      `Change mode: /governance onboard ${agentId} 1|2|3`,
    );
  }

  // /governance onboard <agent_id> <mode> — enable/configure agent
  const modeArg = args[1].toLowerCase();
  const resolved = modeMap[modeArg];

  if (!resolved) {
    return textReply(
      `Invalid mode "${args[1]}". Use: /governance onboard ${agentId} 1|2|3\n` +
      `1 = light, 2 = advanced, 3 = experimental`,
    );
  }

  if (!agentIds.includes(agentId)) {
    return textReply(`Agent "${agentId}" not found in config.\n\nKnown agents: ${agentIds.join(", ")}`);
  }

  const ok = await setAgentGovernance(agentId, resolved);
  if (!ok) {
    return textReply(`Failed to configure governance for agent "${agentId}". Check logs.`);
  }

  // Mark global onboarding complete on first per-agent setup
  const state = getState();
  if (!state.isOnboarded) {
    setOverlayMode(resolved);
  }

  const modeDesc: Record<string, string> = {
    light: "I'll observe your agent and advise, but won't run automatic experiments.",
    advanced: "I'll observe in detail and log everything for review.",
    experimental: "I'll proactively diagnose issues and run bounded experiments.",
  };

  return textReply(
    `**${agentId}** governance set to **${resolved}**.\n\n` +
    `${modeDesc[resolved]}\n\n` +
    `Use /governance status to see current state.`,
  );
}

function handleGovApprove(_ctx: PluginCommandContext, args: string[]): ReplyPayload {
  const code = args[0];

  // If no code provided, try pending approval
  if (!code) {
    const pending = getPendingApproval();
    if (!pending) return textReply("No pending approval to approve.");
    resolveApprovalRequest(pending.id, "Approved via /approve command");
    return textReply(
      `**[${pending.shortCode}]** approved.\n\n` +
      `Use /governance status to see updated state.`,
    );
  }

  const req = getApprovalRequestByShortCode(code);
  if (!req) return textReply(`Approval request [${code}] not found or already resolved.`);

  resolveApprovalRequest(req.id, "Approved");
  return textReply(
    `**[${req.shortCode}]** approved.\n\n` +
    `Use /governance status to see updated state.`,
  );
}

function handleGovDeny(_ctx: PluginCommandContext, args: string[]): ReplyPayload {
  const code = args[0];

  if (!code) {
    const pending = getPendingApproval();
    if (!pending) return textReply("No pending approval to deny.");
    resolveApprovalRequest(pending.id, "Denied via /deny command");
    return textReply(
      `**[${pending.shortCode}]** denied.\n\n` +
      `Use /governance status to see updated state.`,
    );
  }

  const req = getApprovalRequestByShortCode(code);
  if (!req) return textReply(`Approval request [${code}] not found or already resolved.`);

  resolveApprovalRequest(req.id, "Denied");
  return textReply(
    `**[${req.shortCode}]** denied.\n\n` +
    `Use /governance status to see updated state.`,
  );
}

function handleGovSelect(_ctx: PluginCommandContext, args: string[]): ReplyPayload {
  const code = args[0];
  const choiceStr = args[1];

  if (!code || !choiceStr) {
    return textReply(
      `Usage: /governance select <code> <choice>\n` +
      `Example: /governance select GOV-1 2`,
    );
  }

  const req = getApprovalRequestByShortCode(code);
  if (!req) return textReply(`Approval request [${code}] not found or already resolved.`);

  const choiceIndex = parseInt(choiceStr, 10) - 1;
  if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= req.options.length) {
    return textReply(
      `Invalid choice "${choiceStr}". Pick 1 to ${req.options.length}.\n` +
      `Options: ${req.options.join(" | ")}`,
    );
  }

  const chosen = req.options[choiceIndex];
  resolveApprovalRequest(req.id, chosen);

  return textReply(
    `**[${req.shortCode}]** choice recorded: **${chosen}**.\n\n` +
    `Use /governance status to see updated state.`,
  );
}

function handleGovDiag(_ctx: PluginCommandContext): ReplyPayload {
  const open = getOpenDiagnostics();
  if (open.length === 0) return textReply("No open diagnostics.");

  const lines = [`**Open Diagnostics (${open.length})**`, ""];
  for (const d of open) {
    lines.push(`[${d.id.slice(0, 8)}] **${d.severity}**`);
    lines.push(`  Problem: ${d.problem.slice(0, 100)}`);
    lines.push(`  Hypothesis: ${d.hypothesis.slice(0, 100)}`);
    lines.push(`  Confidence: ${Math.round(d.confidence * 100)}%`);
    const ageMin = Math.round((Date.now() - d.createdAt) / 60000);
    lines.push(`  Age: ${ageMin}m | Responses: ${d.possibleResponses.join(" | ")}`);
    lines.push("");
  }
  return textReply(lines.join("\n"));
}

function handleGovExperiments(_ctx: PluginCommandContext): ReplyPayload {
  const running = getRunningExperiments();
  const pending = getPendingExperiments();
  const state = getState();
  const all = state.experiments;

  if (all.length === 0) return textReply("No experiments yet.");

  const lines = [`**Experiments**`, ""];
  for (const e of all.slice(-10).reverse()) {
    lines.push(`[${e.id.slice(0, 8)}] **${e.status}** — ${e.description.slice(0, 70)}`);
    if (e.startedAt) {
      const ageh = Math.round((Date.now() - e.startedAt) / 3600000);
      lines.push(`  Started ${ageh}h ago | Bound: ${Math.round(e.bounds.durationMs / 3600000)}h`);
    }
    lines.push("");
  }
  return textReply(lines.join("\n"));
}

function handleGovAudit(_ctx: PluginCommandContext, args: string[]): ReplyPayload {
  const limit = Math.min(parseInt(args[0] ?? "10", 10), 50);
  const entries = getAuditLog(limit);

  if (entries.length === 0) return textReply("No audit entries yet.");

  const lines = [`**Governance Audit (last ${entries.length})**`, ""];
  for (const e of entries.slice(-limit).reverse()) {
    const age = Math.round((Date.now() - e.timestamp) / 60000);
    lines.push(`[${age}m ago] **[${e.kind}]** ${e.summary}`);
    if (e.detail) lines.push(`  ${e.detail.slice(0, 120)}`);
  }
  return textReply(lines.join("\n"));
}

function handleGovPause(_ctx: PluginCommandContext): ReplyPayload {
  pauseGovernance();
  return textReply("Governance paused. Observations and diagnostics are suspended.\n\nResume with /governance resume");
}

function handleGovResume(_ctx: PluginCommandContext): ReplyPayload {
  resumeGovernance();
  return textReply("Governance resumed.");
}

function handleGovHelp(_ctx: PluginCommandContext): ReplyPayload {
  return textReply(
    `**Adaptative Governance — Commands**

Governance status:
  /governance status (or just /governance or /gov)

Per-agent onboarding:
  /governance onboard              List all agents and their governance status
  /governance onboard <id>          Show status for a specific agent
  /governance onboard <id> <mode>  Enable governance for an agent (mode: 1|2|3)

Approval management:
  /governance approve [code]     Approve the latest or a specific request
  /governance deny [code]         Deny the latest or a specific request
  /governance select <code> <n>  Select option N for a request

Shortcuts:
  /approve [code]     Same as /governance approve
  /deny [code]        Same as /governance deny

Experiments:
  /governance experiments         Show all experiments

Diagnostics:
  /governance diagnostics         Show open diagnostics

Audit:
  /governance audit [N]          Show last N audit entries (default 10)

System:
  /governance pause              Pause governance
  /governance resume             Resume governance
  /governance help              Show this help

**Overlay modes:**
  1 = Light (observe and advise)
  2 = Advanced (observe, advise, log in detail)
  3 = Experimental (proactive diagnostics + experiments)

**Per-agent governance:**
  Each agent has its own governance state stored in <workspace>/governance.json.
  Use /governance onboard <agent_id> 1|2|3 to enable governance per agent.

**Approval codes:**
  Pending approvals are shown with a code like [GOV-1].
  Use this code with /approve, /deny, or /select.`,
  );
}

// ─── Shortcut commands ─────────────────────────────────────────────────────────

const approveHandler: PluginCommandHandler = async (ctx: PluginCommandContext): Promise<ReplyPayload> => {
  const code = (ctx.args ?? "").trim();
  return handleGovApprove(ctx, code ? [code] : []);
};

const denyHandler: PluginCommandHandler = async (ctx: PluginCommandContext): Promise<ReplyPayload> => {
  const code = (ctx.args ?? "").trim();
  return handleGovDeny(ctx, code ? [code] : []);
};

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "governance",
    nativeNames: { default: "gov", telegram: "governance", discord: "governance" },
    description: "Adaptative Governance — status, approvals, experiments",
    acceptsArgs: true,
    handler: governanceHandler,
  });

  api.registerCommand({
    name: "approve",
    nativeNames: { default: "approve", telegram: "approve", discord: "approve" },
    description: "Approve the pending governance request",
    acceptsArgs: true,
    handler: approveHandler,
  });

  api.registerCommand({
    name: "deny",
    nativeNames: { default: "deny", telegram: "deny", discord: "deny" },
    description: "Deny the pending governance request",
    acceptsArgs: true,
    handler: denyHandler,
  });

  api.logger.info("[adaptative-governance] Commands registered: /governance, /approve, /deny");
}
