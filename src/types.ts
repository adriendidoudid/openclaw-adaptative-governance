// ─── Change Classification ───────────────────────────────────────────────────

export type ChangeSeverity =
  | "minor"       // small tuning, low impact
  | "experimental" // plausible idea to test
  | "structural"  // notable protocol change
  | "sensitive"   // secrets, new tools, network, external services
  | "dangerous"  // blocked from automation
  | "optimization"; // improvement opportunity, not an error

// ─── Observation Signal ───────────────────────────────────────────────────────

export interface ObservationSignal {
  kind:
    | "quality_drop"
    | "instability"
    | "error_spike"
    | "contradiction"
    | "uncertainty"
    | "capability_gap"
    | "optimization"; // agent self-identified improvement opportunity
  description: string;
  timestamp: number; // Unix ms
  sessionKey?: string;
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

export interface Diagnostic {
  id: string;
  signal: ObservationSignal;
  problem: string;
  hypothesis: string;
  possibleResponses: string[];
  confidence: number; // 0-1
  severity: ChangeSeverity;
  createdAt: number;
  resolved: boolean;
}

// ─── Experiment ────────────────────────────────────────────────────────────────

export type ExperimentStatus =
  | "pending"    // approved, not yet running
  | "running"
  | "validated"
  | "rejected"
  | "archived";

export interface Experiment {
  id: string;
  diagnosticId: string;
  description: string;
  changeType: ChangeSeverity;
  bounds: {
    durationMs: number;
    scope: string; // e.g. "session:agent:main:main" or "all sessions"
  };
  status: ExperimentStatus;
  startedAt?: number;
  endedAt?: number;
  validationMetrics?: Record<string, number | string>;
  adoptionNote?: string;
  createdAt: number;
}

// ─── Approval Request ─────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  /** Human-readable short code for chat commands, e.g. "GOV-1" */
  shortCode: string;
  diagnosticId: string;
  experimentId?: string;
  question: string;
  options: string[];  // e.g. ["1", "2", "3", "4"]
  recommendation?: string; // e.g. "Option 2"
  requestedAt: number;
  respondedAt?: number;
  response?: string;
  decided: boolean;
}

// ─── Audit Entry ──────────────────────────────────────────────────────────────

export type AuditKind =
  | "observation_recorded"
  | "observation_batch"
  | "diagnostic_created"
  | "experiment_created"
  | "experiment_started"
  | "experiment_validated"
  | "experiment_rejected"
  | "experiment_archived"
  | "experiment_rolled_back"
  | "experiment_expired"
  | "change_adopted"
  | "change_reverted"
  | "approval_requested"
  | "approval_responded"
  | "approval_declined"
  | "onboarding_completed"
  | "overlay_mode_changed"
  | "state_loaded"
  | "state_saved"
  | "self_review_recorded"
  | "agent_governance_enabled"
  | "agent_governance_disabled";

export interface AuditEntry {
  id: string;
  kind: AuditKind;
  summary: string;
  detail: string;
  timestamp: number;
  sessionKey?: string;
  extra?: Record<string, unknown>;
}

// ─── Conclusions by session (for contradiction detection) ─────────────────────────

export interface SessionConclusionEntry {
  content: string;
  timestamp: number;
}

// ─── Tool failure tracking ────────────────────────────────────────────────────

export interface ToolFailureEntry {
  toolName: string;
  errorMessage: string;
  timestamp: number;
  sessionKey?: string;
}

// ─── Governance State ─────────────────────────────────────────────────────────

export interface GovernanceState {
  overlayMode: "light" | "advanced" | "experimental";
  observations: ObservationSignal[];
  diagnostics: Diagnostic[];
  experiments: Experiment[];
  approvalRequests: ApprovalRequest[];
  auditLog: AuditEntry[];
  pendingApproval: ApprovalRequest | null;
  isOnboarded: boolean;
  paused: boolean;
  maxObservations: number; // ring-buffer size
  // Persistence
  stateLoaded: boolean;
  stateDirty: boolean;
  // Contradiction detection
  conclusionsBySession: Record<string, SessionConclusionEntry[]>;
  // Tool failure tracking
  toolFailureCounts: Record<string, ToolFailureEntry[]>; // keyed by toolName
  // Agent self-review (from governance_self_review)
  lastSelfReview: SelfReview | null;
}

export interface SelfReview {
  sessionKey: string;
  timestamp: number;
  taskSummary: string;
  gapsIdentified: string[];       // limitations the agent identified
  improvementsSuggested: string[]; // what could improve next tasks
  confidenceLevel: "high" | "medium" | "low";
  toolSuggestions: string[];       // tools that would help
}

// ─── Plugin Config ────────────────────────────────────────────────────────────

export interface PluginConfig {
  overlayMode?: "light" | "advanced" | "experimental";
  autoObserve?: boolean;
  journalPath?: string;
  maxObservations?: number;
  maxAuditEntries?: number;
  /** Window in ms for contradiction detection (default: 1 hour) */
  contradictionWindowMs?: number;
  /** Max conclusions stored per session for contradiction detection (default: 20) */
  maxConclusionsPerSession?: number;
  /** List of agent IDs governed by this plugin. Empty = all agents. */
  agents?: string[];
}

// ─── Per-Agent Governance State ─────────────────────────────────────────────

export interface PerAgentGovernance {
  agentId: string;
  mode: "light" | "advanced" | "experimental";
  enabled: boolean;
  onboardedAt: number;
}
