import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getState,
  getRecentObservations,
  createDiagnostic,
  createApprovalRequest,
  logAudit,
  getOpenDiagnostics,
  getRunningExperiments,
  getAllExperiments,
  expireExperiment,
  getLastSelfReview,
  getAllPendingApprovals,
  resolveApprovalRequest,
} from "./state.js";
import type { ObservationSignal, ChangeSeverity } from "./types.js";

// ─── Severity thresholds ────────────────────────────────────────────────────────

interface SeverityThresholds {
  instabilityCount: number;
  uncertaintyCount: number;
  qualityDropCount: number;
  errorSpikeCount: number;
  windowMs: number;
}

const THRESHOLDS_LIGHT: SeverityThresholds = {
  instabilityCount: 5,
  uncertaintyCount: 8,
  qualityDropCount: 3,
  errorSpikeCount: 3,
  windowMs: 4 * 3600000,
};

const THRESHOLDS_ADVANCED: SeverityThresholds = {
  instabilityCount: 3,
  uncertaintyCount: 5,
  qualityDropCount: 2,
  errorSpikeCount: 2,
  windowMs: 2 * 3600000,
};

const THRESHOLDS_EXPERIMENTAL: SeverityThresholds = {
  instabilityCount: 2,
  uncertaintyCount: 3,
  qualityDropCount: 1,
  errorSpikeCount: 1,
  windowMs: 3600000,
};

function getThresholds(mode: "light" | "advanced" | "experimental"): SeverityThresholds {
  switch (mode) {
    case "advanced": return THRESHOLDS_ADVANCED;
    case "experimental": return THRESHOLDS_EXPERIMENTAL;
    default: return THRESHOLDS_LIGHT;
  }
}

// ─── Severity classifier ───────────────────────────────────────────────────────

function classifySeverity(kind: ObservationSignal["kind"], count: number): ChangeSeverity {
  if (kind === "error_spike") return "experimental";
  if (kind === "contradiction" && count >= 5) return "structural";
  if (kind === "contradiction" && count >= 3) return "experimental";
  if (kind === "quality_drop" && count >= 3) return "structural";
  if (kind === "quality_drop" && count >= 2) return "experimental";
  return "minor";
}

// ─── Check approval request expirations ───────────────────────────────────────

const APPROVAL_EXPIRY_MS = 24 * 3600_000; // 24 hours

function checkApprovalExpirations(): void {
  const pending = getAllPendingApprovals();
  const now = Date.now();
  for (const req of pending) {
    if (now > req.requestedAt + APPROVAL_EXPIRY_MS) {
      resolveApprovalRequest(req.id, "Expired (no response within 24h)");
      logAudit(
        "approval_declined",
        `Approval [${req.shortCode}] expired after 24h`,
        req.question,
      );
    }
  }
}

// ─── Check experiment expirations ─────────────────────────────────────────────

function checkExperimentExpirations(): void {
  const running = getRunningExperiments();
  const now = Date.now();
  for (const exp of running) {
    if (exp.startedAt && now > exp.startedAt + exp.bounds.durationMs) {
      expireExperiment(exp.id);
      // Create a diagnostic asking for validation decision
      createDiagnostic({
        signal: {
          kind: "instability",
          description: `Experiment ${exp.id} expired without decision`,
          timestamp: now,
        },
        problem: `Experiment "${exp.description}" has exceeded its ${Math.round(exp.bounds.durationMs / 3600000)}h bound without a decision`,
        hypothesis: "No automatic decision was made — manual review needed",
        possibleResponses: [
          "1. Validate the experiment (adopt the change)",
          "2. Reject the experiment (discard the change)",
          "3. Extend the experiment duration",
          "4. Archive without decision (no change adopted)",
        ],
        confidence: 0.9,
        severity: exp.changeType,
      });
    }
  }
}

// ─── Self-Review Analyzer ──────────────────────────────────────────────────────

const SELF_REVIEW_ANALYSIS_WINDOW_MS = 3600_000; // 1 hour between self-review analyses
let _lastSelfReviewAnalysisTime = 0;

function analyzeSelfReview(): void {
  const now = Date.now();

  // Cooldown: skip if analyzed recently
  if (now - _lastSelfReviewAnalysisTime < SELF_REVIEW_ANALYSIS_WINDOW_MS) return;

  const review = getLastSelfReview();
  if (!review) return;

  // Don't re-analyze old reviews (>1h old)
  if (now - review.timestamp > 3600_000) return;

  const open = getOpenDiagnostics();
  const hasOpenOptimization = open.some(
    (d) => d.signal.kind === "optimization" && d.signal.sessionKey === review.sessionKey,
  );
  if (hasOpenOptimization) return;

  // Mark analysis time BEFORE processing to protect against rapid re-invocation
  _lastSelfReviewAnalysisTime = now;

  // Build optimization diagnostic from agent's self-review
  if (review.gapsIdentified.length > 0 || review.toolSuggestions.length > 0) {
    const toolSuggestions = review.toolSuggestions.length > 0
      ? review.toolSuggestions.map((t, i) => `${i + 1}. Ajouter ${t}`)
      : [];

    const otherOptions = [
      "1. Ne rien changer",
      "2. Archiver cette analyse",
    ];

    const allOptions =
      toolSuggestions.length > 0
        ? [...toolSuggestions, ...otherOptions]
        : otherOptions;

    const recommendation =
      toolSuggestions.length > 0 ? toolSuggestions[0] : undefined;

    const problem =
      review.gapsIdentified.length > 0
        ? `L'agent a identifié des limitations dans son travail récent : ${review.gapsIdentified.join("; ")}.`
        : `L'agent a suggéré des outils pour améliorer ses futures tâches : ${review.toolSuggestions.join(", ")}.`;

    const diag = createDiagnostic({
      signal: {
        kind: "optimization",
        description: `[Self-review] Agent: ${review.taskSummary}`,
        timestamp: review.timestamp,
        sessionKey: review.sessionKey,
      },
      problem,
      hypothesis:
        review.improvementsSuggested.length > 0
          ? `Propositions de l'agent : ${review.improvementsSuggested.join("; ")}`
          : "L'agent pourrait améliorer ses résultats avec de meilleurs outils ou sources.",
      possibleResponses: allOptions,
      confidence: review.confidenceLevel === "high" ? 0.6 : review.confidenceLevel === "medium" ? 0.75 : 0.9,
      severity: "optimization",
    });

    // Optimization proposals always go to the user for approval
    createApprovalRequest({
      diagnosticId: diag.id,
      question: `**Auto-évaluation de l'agent**\n\n${problem}\n\n**Résumé du travail** : ${review.taskSummary}\n\n**Quel avenir pour cette amélioration ?**`,
      options: allOptions,
      recommendation,
    });
  }
}

// ─── Governance Analyzer ───────────────────────────────────────────────────────

function analyzeAndDiagnose(): void {
  const state = getState();
  if (state.paused) return;

  const t = getThresholds(state.overlayMode);
  const recent = getRecentObservations(t.windowMs);

  const byKind = (kind: ObservationSignal["kind"]) =>
    recent.filter((o) => o.kind === kind);

  const instabilities = byKind("contradiction");
  const uncertainties = byKind("uncertainty");
  const qualityDrops = byKind("quality_drop");
  const errorSpikes = byKind("error_spike");
  const capabilityGaps = byKind("capability_gap");

  const open = getOpenDiagnostics();
  const hasOpenSimilar = (kind: ObservationSignal["kind"]) =>
    open.some((d) => d.signal.kind === kind);

  // 1. Error spikes — structural/experimental depending on severity
  if (errorSpikes.length >= t.errorSpikeCount && !hasOpenSimilar("error_spike")) {
    const sev = classifySeverity("error_spike", errorSpikes.length);
    const diag = createDiagnostic({
      signal: errorSpikes[0],
      problem: `${errorSpikes.length} error spikes detected in recent sessions — tool reliability may be degraded`,
      hypothesis: "A tool or integration is producing repeated failures, degrading agent reliability",
      possibleResponses: [
        "1. Investigate and fix the failing tool/integration",
        "2. Add error-handling retry logic",
        "3. Reduce dependency on the failing tool",
        "4. Do nothing (monitor only)",
      ],
      confidence: Math.min(errorSpikes.length / 6, 0.9),
      severity: sev,
    });
    if (sev === "structural" || sev === "sensitive") {
      requestApprovalForDiagnostic(diag.id, sev);
    }
  }

  // 2. Contradictions
  if (instabilities.length >= t.instabilityCount && !hasOpenSimilar("contradiction")) {
    const sev = classifySeverity("contradiction", instabilities.length);
    const diag = createDiagnostic({
      signal: instabilities[0],
      problem: `${instabilities.length} contradictory conclusions detected in recent sessions`,
      hypothesis: "The agent may be applying inconsistent evaluation criteria or changing its mind without new information",
      possibleResponses: [
        "1. Add a stability validation step before conclusion",
        "2. Strengthen confidence threshold for conclusions",
        "3. Introduce a review step for high-stakes decisions",
        "4. Do nothing (monitor only)",
      ],
      confidence: Math.min(instabilities.length / 10, 0.9),
      severity: sev,
    });
    if (sev === "structural" || sev === "sensitive") {
      requestApprovalForDiagnostic(diag.id, sev);
    }
  }

  // 3. Uncertainties
  if (uncertainties.length >= t.uncertaintyCount && !hasOpenSimilar("uncertainty")) {
    createDiagnostic({
      signal: uncertainties[0],
      problem: `${uncertainties.length} uncertainty signals detected — agent may lack sufficient information`,
      hypothesis: "Insufficient context or tool capabilities to resolve the current topic confidently",
      possibleResponses: [
        "1. Add a research/information-gathering step",
        "2. Lower confidence threshold for provisional conclusions",
        "3. Expand tool capabilities or integrations",
        "4. Do nothing (acceptable uncertainty level)",
      ],
      confidence: Math.min(uncertainties.length / 12, 0.85),
      severity: "minor",
    });
  }

  // 4. Quality drops
  if (qualityDrops.length >= t.qualityDropCount && !hasOpenSimilar("quality_drop")) {
    const sev = classifySeverity("quality_drop", qualityDrops.length);
    createDiagnostic({
      signal: qualityDrops[0],
      problem: `${qualityDrops.length} quality concerns detected — output quality may be degrading`,
      hypothesis: "The agent may be producing outputs that contradict earlier reasoning or miss context",
      possibleResponses: [
        "1. Strengthen context injection (AGENTS.md enrichment)",
        "2. Add a self-consistency check step",
        "3. Reduce task complexity / break into smaller steps",
        "4. Do nothing (may be transient)",
      ],
      confidence: Math.min(qualityDrops.length / 8, 0.8),
      severity: sev,
    });
  }

  // 5. Capability gaps — structural by nature (missing tools/permissions)
  if (capabilityGaps.length >= 1 && !hasOpenSimilar("capability_gap")) {
    const sev: ChangeSeverity = "structural";
    const diag = createDiagnostic({
      signal: capabilityGaps[0],
      problem: `${capabilityGaps.length} capability-gap error(s) detected — the agent tried tools that are not available or permitted`,
      hypothesis: "The agent lacks a tool or permission it needs to complete its task",
      possibleResponses: [
        "1. Add the missing tool or integration",
        "2. Grant the missing permission to the agent",
        "3. Provide an alternative tool that achieves the same goal",
        "4. Do nothing (agent worked around it)",
      ],
      confidence: Math.min(capabilityGaps.length / 5, 0.95),
      severity: sev,
    });
    requestApprovalForDiagnostic(diag.id, sev);
  }
}

// ─── Approval request helper ────────────────────────────────────────────────────

function requestApprovalForDiagnostic(diagnosticId: string, severity: ChangeSeverity): void {
  const diag = getOpenDiagnostics().find((d) => d.id === diagnosticId);
  if (!diag) return;

  const question =
    `Governance has detected a **${severity}** issue:\n\n**${diag.problem}**\n\nWhat would you like to do?`;
  const options = diag.possibleResponses;

  createApprovalRequest({
    diagnosticId,
    question,
    options,
    recommendation: options[0],
  });
}

// ─── Onboarding message ────────────────────────────────────────────────────────

export const ONBOARDING_MESSAGE = `Adaptive Governance plugin ready.

I can observe your agent's behavior and help you make improvements safely:
- Detect quality issues, contradictions, and tool error spikes
- Propose bounded experiments before making changes
- Ask for approval via your existing channels before structural changes

Choose an overlay mode:
1. **Light** — Observe and advise (no automatic experiments)
2. **Advanced** — Observe, advise, and log in detail
3. **Experimental** — Full governance with proactive diagnostics

Reply with \`1\`, \`2\`, or \`3\` to select your mode.`;

// ─── Service ──────────────────────────────────────────────────────────────────

export interface GovernanceService {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Called after the agent completes a task (from messageReceivedHandler).
 * Runs expirations checks, self-review analysis, and proactive diagnostics.
 */
export function onAgentTaskComplete(api: OpenClawPluginApi): void {
  try {
    checkApprovalExpirations();
    checkExperimentExpirations();
    analyzeSelfReview();
    analyzeAndDiagnose();
  } catch (err) {
    api.logger.error(`[governance] analysis error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createGovernanceService(api: OpenClawPluginApi): GovernanceService {
  return {
    async start() {
      logAudit("onboarding_completed", "Governance service started", "");
    },

    stop() {
      // no-op: analysis is event-driven, not timer-driven
    },
  };
}
