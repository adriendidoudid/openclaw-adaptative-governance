import { Type } from "@sinclair/typebox";
import {
  getState,
  getAuditLog,
  getOpenDiagnostics,
  getRunningExperiments,
  getPendingExperiments,
  getPendingApproval,
  createDiagnostic,
  createExperiment,
  createApprovalRequest,
  startExperiment,
  validateExperiment,
  rejectExperiment,
  rollbackExperiment,
  archiveExperiment,
  resolveApprovalRequest,
  pauseGovernance,
  resumeGovernance,
  setOverlayMode,
  logAudit,
  recordSelfReview,
  getLastSelfReview,
} from "../state.js";
import type { ChangeSeverity, Experiment, Diagnostic, SelfReview } from "../types.js";
import { ONBOARDING_MESSAGE } from "../service.js";

// Local tool result helper — matches AgentToolResult shape expected by the SDK
function toolResult(text: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatExperiment(exp: Experiment): string {
  return [
    `- **Experiment** \`${exp.id}\` (${exp.status})`,
    `  ${exp.description}`,
    `  Severity: ${exp.changeType} | Bounds: ${Math.round(exp.bounds.durationMs / 3600000)}h, scope: ${exp.bounds.scope}`,
    exp.startedAt ? `  Started: ${new Date(exp.startedAt).toISOString()}` : "",
    exp.endedAt ? `  Ended: ${new Date(exp.endedAt).toISOString()}` : "",
    exp.adoptionNote ? `  Note: ${exp.adoptionNote}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDiagnostic(diag: Diagnostic): string {
  return [
    `- **Diagnostic** \`${diag.id}\``,
    `  Problem: ${diag.problem}`,
    `  Hypothesis: ${diag.hypothesis}`,
    `  Confidence: ${Math.round(diag.confidence * 100)}%`,
    `  Severity: ${diag.severity}`,
    `  Responses: ${diag.possibleResponses.join(" | ")}`,
  ].join("\n");
}

// ─── Tool: get_governance_status ───────────────────────────────────────────────

export const getGovernanceStatusTool = {
  name: "get_governance_status",
  label: "Governance Status",
  description:
    "Get a summary of the current governance state: overlay mode, paused status, open diagnostics, running/pending experiments, and pending approvals.",
  parameters: Type.Object({}),
  async execute() {
    const state = getState();
    const lines: string[] = [
      `## Governance Status`,
      `**Overlay mode:** ${state.overlayMode}`,
      `**Paused:** ${state.paused ? "yes" : "no"}`,
      `**Onboarded:** ${state.isOnboarded ? "yes" : "no"}`,
      "",
    ];

    if (!state.isOnboarded) {
      lines.push(ONBOARDING_MESSAGE, "");
    }

    const open = getOpenDiagnostics();
    if (open.length > 0) {
      lines.push(`## Open Diagnostics (${open.length})`);
      open.slice(0, 5).forEach((d) => lines.push(formatDiagnostic(d)));
      lines.push("");
    }

    const running = getRunningExperiments();
    if (running.length > 0) {
      lines.push(`## Running Experiments (${running.length})`);
      running.forEach((e) => lines.push(formatExperiment(e)));
      lines.push("");
    }

    const pending = getPendingExperiments();
    if (pending.length > 0) {
      lines.push(`## Pending Experiments (${pending.length})`);
      pending.forEach((e) => lines.push(formatExperiment(e)));
      lines.push("");
    }

    const approval = getPendingApproval();
    if (approval) {
      lines.push(`## Pending Approval [${approval.shortCode}]`);
      lines.push(`**Question:**`);
      lines.push(approval.question);
      lines.push(`**Options:** ${approval.options.join(" | ")}`);
      if (approval.recommendation) lines.push(`**Recommendation:** ${approval.recommendation}`);
      lines.push("");
      lines.push(`**Respond via chat:**`);
      lines.push(`  /governance select ${approval.shortCode} <1-${approval.options.length}>`);
      lines.push(`  or: /approve ${approval.shortCode} | /deny ${approval.shortCode}`);
      lines.push("");
    }

    return toolResult(lines.join("\n"));
  },
};

// ─── Tool: governance_onboard ─────────────────────────────────────────────────

export const onboardTool = {
  name: "governance_onboard",
  label: "Governance Onboard",
  description:
    "Select the governance overlay mode on first startup, or change the current mode.",
  parameters: Type.Object({
    mode: Type.String({
      description: "Overlay mode: 1=light, 2=advanced, 3=experimental",
    }),
  }),
  async execute(_id: string, params: { mode: string }) {
    const state = getState();
    const modeMap: Record<string, "light" | "advanced" | "experimental"> = {
      "1": "light",
      "2": "advanced",
      "3": "experimental",
    };
    const resolved = modeMap[params.mode];

    if (!resolved) {
      return toolResult(
        `Invalid mode "${params.mode}". Reply with \`1\` (light), \`2\` (advanced), or \`3\` (experimental).`,
      );
    }

    setOverlayMode(resolved);
    const modeLines: Record<string, string> = {
      light: "Light — I'll observe your agent and advise, but won't run automatic experiments.",
      advanced: "Advanced — I'll observe in detail and log everything for review.",
      experimental: "Experimental — I'll proactively diagnose issues and run bounded experiments.",
    };

    return toolResult(
      `Governance mode set to **${resolved}**.\n\n${modeLines[resolved]}\n\nUse \`get_governance_status\` to see current state.`,
    );
  },
};

// ─── Tool: governance_respond ─────────────────────────────────────────────────

export const respondTool = {
  name: "governance_respond",
  label: "Governance Respond (legacy)",
  description:
    "[DEPRECATED — use /governance select <code> <n> instead] Respond to the pending governance approval by number.",
  parameters: Type.Object({
    choice: Type.String({ description: "Your choice: the option number (e.g. '1', '2', '3')" }),
  }),
  async execute(_id: string, params: { choice: string }) {
    const approval = getPendingApproval();
    if (!approval) {
      return toolResult(
        "No pending approval request.\n\n" +
        "To interact with governance, use chat commands:\n" +
        "  /governance status  — see current state\n" +
        "  /governance select <code> <n>  — select an option\n" +
        "  /approve [code] | /deny [code]",
      );
    }

    // Parse the choice — it can be a number like "1" or "2" etc.
    const trimmed = params.choice.trim();
    const optionIndex = parseInt(trimmed, 10) - 1;
    if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= approval.options.length) {
      return toolResult(
        `Invalid choice "${trimmed}". Please pick a number between 1 and ${approval.options.length}.\n\nOptions: ${approval.options.join(" | ")}`,
      );
    }

    const chosen = approval.options[optionIndex];
    resolveApprovalRequest(approval.id, chosen);

    // If there's a linked experiment, handle it
    if (approval.experimentId) {
      if (chosen.toLowerCase().includes("approve") || chosen.toLowerCase().includes("validate") || chosen.toLowerCase().includes("1")) {
        return toolResult(
          `Your choice recorded: **${chosen}**.\n\nExperiment \`${approval.experimentId}\` approved. Use \`governance_experiment_control\` with action "start" when ready to begin.`,
        );
      }
    }

    return toolResult(
      `Your response has been recorded: **${chosen}**.\n\nUse \`get_governance_status\` to see the updated state.`,
    );
  },
};

// ─── Tool: governance_diagnose ────────────────────────────────────────────────

export const diagnoseTool = {
  name: "governance_diagnose",
  label: "Governance Diagnose",
  description:
    "Record a diagnostic observation. Use this when you detect a problem, instability, quality drop, or opportunity for improvement in the agent's behavior.",
  parameters: Type.Object({
    problem: Type.String({ description: "Clear statement of the identified problem" }),
    hypothesis: Type.String({ description: "What you think is causing it" }),
    possibleResponses: Type.Array(Type.String(), {
      description: "2-4 possible response options the user could choose from",
    }),
    confidence: Type.Number({ description: "Your confidence in the hypothesis (0.0-1.0)", minimum: 0, maximum: 1 }),
    severity: Type.String({
      description: "Change severity: minor | experimental | structural | sensitive | dangerous",
    }),
    sessionKey: Type.Optional(Type.String()),
  }),
  async execute(_id: string, params: {
    problem: string;
    hypothesis: string;
    possibleResponses: string[];
    confidence: number;
    severity: ChangeSeverity;
    sessionKey?: string;
  }) {
    const diag = createDiagnostic({
      signal: {
        kind: "uncertainty",
        description: params.problem,
        timestamp: Date.now(),
        sessionKey: params.sessionKey,
      },
      problem: params.problem,
      hypothesis: params.hypothesis,
      possibleResponses: params.possibleResponses,
      confidence: params.confidence,
      severity: params.severity,
    });

    // Auto-request approval for structural/sensitive diagnostics
    if (params.severity === "structural" || params.severity === "sensitive") {
      createApprovalRequest({
        diagnosticId: diag.id,
        question: `Governance has detected a **${params.severity}** issue:\n\n**${params.problem}**\n\nWhat would you like to do?`,
        options: params.possibleResponses,
        recommendation: params.possibleResponses[0],
      });
      return toolResult(
        `Diagnostic recorded (${diag.id}) and approval requested.\n\n**Problem:** ${params.problem}\n**Severity:** ${params.severity}\n\nA request for your decision has been created. Use \`governance_respond\` with your choice.`,
      );
    }

    return toolResult(
      `Diagnostic recorded (${diag.id}).\n\n**Problem:** ${params.problem}\n**Hypothesis:** ${params.hypothesis}\n**Confidence:** ${Math.round(params.confidence * 100)}%\n**Severity:** ${params.severity}\n\nYou can now use \`governance_propose_experiment\` to turn this into an experiment.`,
    );
  },
};

// ─── Tool: governance_propose_experiment ──────────────────────────────────────

export const proposeExperimentTool = {
  name: "governance_propose_experiment",
  label: "Propose Governance Experiment",
  description:
    "Propose a bounded experiment based on a diagnostic. The experiment will be set to 'pending' status until approved via `governance_experiment_control`.",
  parameters: Type.Object({
    diagnosticId: Type.Optional(Type.String({ description: "Link to an existing diagnostic ID" })),
    description: Type.String({ description: "Human-readable description of the change to test" }),
    changeType: Type.String({
      description: "minor | experimental | structural | sensitive | dangerous",
    }),
    durationHours: Type.Number({ description: "How long to run the experiment (hours)", minimum: 1, maximum: 720 }),
    scope: Type.Optional(
      Type.String({ description: "Session scope for the experiment (default: all sessions)" }),
    ),
    problem: Type.Optional(Type.String()),
    hypothesis: Type.Optional(Type.String()),
    possibleResponses: Type.Optional(Type.Array(Type.String())),
    confidence: Type.Optional(Type.Number()),
  }),
  async execute(_id: string, params: {
    diagnosticId?: string;
    description: string;
    changeType: ChangeSeverity;
    durationHours: number;
    scope?: string;
    problem?: string;
    hypothesis?: string;
    possibleResponses?: string[];
    confidence?: number;
  }) {
    let diagId = params.diagnosticId;
    if (!diagId && params.problem) {
      const diag = createDiagnostic({
        signal: { kind: "uncertainty", description: params.problem, timestamp: Date.now() },
        problem: params.problem,
        hypothesis: params.hypothesis ?? "Unspecified",
        possibleResponses: params.possibleResponses ?? ["Proceed", "Abort"],
        confidence: params.confidence ?? 0.5,
        severity: params.changeType,
      });
      diagId = diag.id;
    }

    const exp = createExperiment({
      diagnosticId: diagId ?? "unknown",
      description: params.description,
      changeType: params.changeType,
      bounds: {
        durationMs: params.durationHours * 3600000,
        scope: params.scope ?? "all",
      },
    });

    // Structural/sensitive experiments need approval before starting
    if (params.changeType === "structural" || params.changeType === "sensitive") {
      createApprovalRequest({
        diagnosticId: diagId ?? "unknown",
        experimentId: exp.id,
        question: `A **${params.changeType}** experiment has been proposed:\n\n**${params.description}**\n\nApprove to begin the experiment?`,
        options: [
          "1. Approve and start now",
          "2. Approve but defer start",
          "3. Reject (discard this proposal)",
          "4. Do nothing",
        ],
        recommendation: "Option 1",
      });
      return toolResult(
        `Experiment \`${exp.id}\` created (${params.changeType}, ${params.durationHours}h).\n\nApproval requested — use \`governance_respond\` to decide.`,
      );
    }

    return toolResult(
      `Experiment \`${exp.id}\` created (${params.changeType}, ${params.durationHours}h).\n\nUse \`governance_experiment_control\` with action "start" to begin the experiment, or "approve" to mark it user-approved.`,
    );
  },
};

// ─── Tool: governance_experiment_control ──────────────────────────────────────

export const experimentControlTool = {
  name: "governance_experiment_control",
  label: "Governance Experiment Control",
  description:
    "Control an experiment lifecycle: start, validate, reject, rollback, or archive.",
  parameters: Type.Object({
    action: Type.String({
      description: "Action: start | approve | validate | reject | rollback | archive",
    }),
    experimentId: Type.String({ description: "Experiment ID" }),
    metrics: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
    ),
    note: Type.Optional(Type.String({ description: "Adoption or rejection note" })),
  }),
  async execute(
    _id: string,
    params: { action: string; experimentId: string; metrics?: Record<string, number | string>; note?: string },
  ) {
    switch (params.action) {
      case "start":
        startExperiment(params.experimentId);
        return toolResult(
          `Experiment \`${params.experimentId}\` started. Monitor with \`get_governance_status\` or \`governance_audit_log\`.`
        );

      case "approve":
        logAudit(
          "approval_responded",
          `Experiment approved: ${params.experimentId}`,
          `User approved via governance tool`,
        );
        return toolResult(
          `Experiment \`${params.experimentId}\` approved. Use action "start" when ready to begin.`
        );

      case "validate":
        if (!params.metrics) {
          return toolResult(
            "Validation requires metrics. Provide a metrics map: e.g. {\"stability_score\": 0.85, \"error_rate\": 0.02}"
          );
        }
        await validateExperiment(params.experimentId, params.metrics, params.note);
        return toolResult(
          `Experiment \`${params.experimentId}\` validated and adopted.\n\nAn overlay context file has been written to the workspace.\n${params.note ? `Note: ${params.note}` : ""}`
        );

      case "reject":
        rejectExperiment(params.experimentId, params.note);
        return toolResult(
          `Experiment \`${params.experimentId}\` rejected.${params.note ? `\nReason: ${params.note}` : ""}`
        );

      case "rollback":
        rollbackExperiment(params.experimentId);
        return toolResult(
          `Experiment \`${params.experimentId}\` rolled back. The overlay context has been reverted.`
        );

      case "archive":
        archiveExperiment(params.experimentId);
        return toolResult(`Experiment \`${params.experimentId}\` archived.`);

      default:
        return toolResult(
          `Unknown action: ${params.action}. Use: start | approve | validate | reject | rollback | archive`
        );
    }
  },
};

// ─── Tool: governance_audit_log ───────────────────────────────────────────────

export const auditLogTool = {
  name: "governance_audit_log",
  label: "Governance Audit Log",
  description: "Get the recent governance audit log (last N entries, default 30).",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Number of entries to return (default 30, max 200)", minimum: 1, maximum: 200 })),
  }),
  async execute(_id: string, params: { limit?: number }) {
    const entries = getAuditLog(params.limit ?? 30);
    if (entries.length === 0) {
      return toolResult("No audit entries yet.");
    }
    const lines = ["## Governance Audit Log", ""];
    for (const entry of entries.slice(-30).reverse()) {
      lines.push(
        `**${new Date(entry.timestamp).toISOString()}** [${entry.kind}] ${entry.summary}`,
      );
      if (entry.detail) lines.push(`  ${entry.detail}`);
    }
    return toolResult(lines.join("\n"));
  },
};

// ─── Tool: governance_control ─────────────────────────────────────────────────

export const controlTool = {
  name: "governance_control",
  label: "Governance Control",
  description: "Pause, resume, or change overlay mode of the governance system.",
  parameters: Type.Object({
    action: Type.String({
      description: "Action: pause | resume | set_mode",
    }),
    overlayMode: Type.Optional(
      Type.String({ description: "Mode: light | advanced | experimental" }),
    ),
  }),
  async execute(_id: string, params: { action: string; overlayMode?: string }) {
    switch (params.action) {
      case "pause":
        pauseGovernance();
        return toolResult("Governance paused. Observations and diagnostics are suspended.");

      case "resume":
        resumeGovernance();
        return toolResult("Governance resumed.");

      case "set_mode":
        if (!params.overlayMode) {
          return toolResult("set_mode requires overlayMode: light | advanced | experimental");
        }
        if (!["light", "advanced", "experimental"].includes(params.overlayMode)) {
          return toolResult("Invalid mode. Use: light | advanced | experimental");
        }
        setOverlayMode(params.overlayMode as "light" | "advanced" | "experimental");
        return toolResult(`Overlay mode set to ${params.overlayMode}.`);

      default:
        return toolResult(`Unknown action: ${params.action}. Use: pause | resume | set_mode`);
    }
  },
};

// ─── Tool: governance_self_review ────────────────────────────────────────────────

export const selfReviewTool = {
  name: "governance_self_review",
  label: "Governance Self-Review",
  description:
    "L'agent s'auto-évalue après une tâche significative. Utilisé pour que la gouvernance puisse identifier des opportunités d'amélioration.",
  parameters: Type.Object({
    taskSummary: Type.String({ description: "Résumé de ce que l'agent vient de faire" }),
    gapsIdentified: Type.Array(Type.String(), { description: "Limitations ou manques identifiés par l'agent lui-même" }),
    improvementsSuggested: Type.Array(Type.String(), { description: "Améliorations suggérées par l'agent pour ses prochaines tâches" }),
    confidenceLevel: Type.String({ description: "Niveau de confiance dans le travail accompli: high, medium, ou low" }),
    toolSuggestions: Type.Optional(Type.Array(Type.String(), { description: "Outils ou sources qui'aideraient à améliorer" })),
    sessionKey: Type.Optional(Type.String()),
  }),
  async execute(_id: string, params: {
    taskSummary: string;
    gapsIdentified: string[];
    improvementsSuggested: string[];
    confidenceLevel: "high" | "medium" | "low";
    toolSuggestions?: string[];
    sessionKey?: string;
  }) {
    const review = {
      sessionKey: params.sessionKey ?? "default",
      taskSummary: params.taskSummary,
      gapsIdentified: params.gapsIdentified,
      improvementsSuggested: params.improvementsSuggested,
      confidenceLevel: params.confidenceLevel,
      toolSuggestions: params.toolSuggestions ?? [],
    };

    recordSelfReview(review);

    const gaps = params.gapsIdentified.length > 0
      ? `\n**Gaps identifiés** : ${params.gapsIdentified.join(", ")}`
      : "";
    const suggestions = params.improvementsSuggested.length > 0
      ? `\n**Améliorations suggérées** : ${params.improvementsSuggested.join(", ")}`
      : "";
    const tools = params.toolSuggestions && params.toolSuggestions.length > 0
      ? `\n**Outils suggérés** : ${params.toolSuggestions.join(", ")}`
      : "";

    return toolResult(
      `Auto-évaluation enregistrée.${gaps}${suggestions}${tools}\n\nLa gouvernance analysera ces informations pour proposer des améliorations si pertinent.`,
    );
  },
};

// ─── Tool: governance_ask_self_review ─────────────────────────────────────────

export const askSelfReviewTool = {
  name: "governance_ask_self_review",
  label: "Demander Auto-Évaluation",
  description:
    "Demande à l'agent de s'auto-évaluer sur son travail récent. Utile pour identifiers des opportunités d'amélioration ou des limitations.",
  parameters: Type.Object({
    sessionKey: Type.Optional(Type.String({ description: "Session à évaluer (défaut: session actuelle)" })),
  }),
  async execute(_id: string, params: { sessionKey?: string }) {
    const last = getLastSelfReview();
    if (last) {
      const ageMs = Date.now() - last.timestamp;
      const ageMin = Math.round(ageMs / 60000);
      return toolResult(
        `Dernière auto-évaluation (il y a ${ageMin} min) :\n\n**Tâche** : ${last.taskSummary}\n**Confiance** : ${last.confidenceLevel}\n**Gaps** : ${last.gapsIdentified.join(", ") || "aucun"}\n**Améliorations** : ${last.improvementsSuggested.join(", ") || "aucune"}\n**Outils suggérés** : ${last.toolSuggestions.join(", ") || "aucun"}\n\nPour déclencher une nouvelle auto-évaluation, invoque l'outil governance_self_review.`,
      );
    }

    return toolResult(
      `Pas d'auto-évaluation récente.\n\nInvoque l'outil governance_self_review pour que l'agent s'auto-évalue sur son travail récent.`,
    );
  },
};

// ─── All tools ─────────────────────────────────────────────────────────────────

export const GOVERNANCE_TOOLS = [
  getGovernanceStatusTool,
  onboardTool,
  diagnoseTool,
  proposeExperimentTool,
  experimentControlTool,
  auditLogTool,
  controlTool,
  selfReviewTool,
  askSelfReviewTool,
];
