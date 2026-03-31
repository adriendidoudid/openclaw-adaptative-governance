import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  GovernanceState,
  ObservationSignal,
  Diagnostic,
  Experiment,
  ApprovalRequest,
  AuditEntry,
  AuditKind,
  ChangeSeverity,
  SessionConclusionEntry,
  ToolFailureEntry,
  SelfReview,
  PerAgentGovernance,
  PluginConfig,
} from "./types.js";

// ─── Config (set at register time) ────────────────────────────────────────────

let _pluginConfig: Partial<PluginConfig> = {};
let _api: OpenClawPluginApi | null = null;

export function initState(api: OpenClawPluginApi, config: Partial<PluginConfig>): void {
  _api = api;
  _pluginConfig = config;
}

// ─── Default State ─────────────────────────────────────────────────────────────

function buildDefaultState(): GovernanceState {
  return {
    overlayMode: "light",
    observations: [],
    diagnostics: [],
    experiments: [],
    approvalRequests: [],
    auditLog: [],
    pendingApproval: null,
    isOnboarded: false,
    paused: false,
    maxObservations: _pluginConfig.maxObservations ?? 200,
    stateLoaded: false,
    stateDirty: false,
    conclusionsBySession: {},
    toolFailureCounts: {},
    lastSelfReview: null,
  };
}

// ─── Runtime Store ─────────────────────────────────────────────────────────────

const _store = createPluginRuntimeStore<GovernanceState>(
  "adaptative-governance state not initialized",
);

// Initialize — caller must call loadState() to restore persisted state
_store.setRuntime(buildDefaultState());

export function getState(): GovernanceState {
  return _store.getRuntime();
}

export function setState(patch: Partial<GovernanceState>): void {
  const current = _store.getRuntime();
  _store.setRuntime({ ...current, ...patch });
  markDirty();
}

export function tryGetState(): GovernanceState | null {
  return _store.tryGetRuntime() ?? null;
}

function markDirty(): void {
  const state = _store.getRuntime();
  if (!state.stateDirty) {
    _store.setRuntime({ ...state, stateDirty: true });
  }
}

// ─── Persistence ───────────────────────────────────────────────────────────────

const STATE_FILE = "governance-state.json";
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

async function getStateFilePath(): Promise<string | null> {
  if (!_api) return null;
  try {
    const stateDir = _api.runtime.state.resolveStateDir();
    return `${stateDir}/${STATE_FILE}`;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<void> {
  const path = await getStateFilePath();
  if (!path) return;
  try {
    const fs = await import("node:fs/promises");
    const data = await fs.readFile(path, "utf-8");
    const persisted = JSON.parse(data) as Partial<GovernanceState>;
    const defaults = buildDefaultState();
    // Merge: keep existing runtime state but restore persisted fields
    const loaded: GovernanceState = {
      ...defaults,
      ...persisted,
      // Always reset runtime-only transient flags
      stateLoaded: true,
      stateDirty: false,
    };
    _store.setRuntime(loaded);
    appendAudit("state_loaded", "Governance state loaded from disk", path);
    _api?.logger.info(`[adaptative-governance] State loaded from ${path}`);
  } catch (err) {
    _api?.logger?.debug?.(`[adaptative-governance] No persisted state found (fresh start)`);
    // Fresh start — mark as loaded anyway
    const state = _store.getRuntime();
    _store.setRuntime({ ...state, stateLoaded: true });
  }
}

// Debounced save — max once per 10 seconds
export function scheduleSave(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    await saveState();
  }, 10_000);
}

async function saveState(): Promise<void> {
  const state = _store.getRuntime();
  if (!state.stateDirty) return;
  const path = await getStateFilePath();
  if (!path) return;
  try {
    const fs = await import("node:fs/promises");
    // Ensure directory exists
    await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, JSON.stringify(state, null, 2), "utf-8");
    _store.setRuntime({ ...state, stateDirty: false });
    appendAudit("state_saved", "Governance state saved to disk", path);
  } catch (err) {
    _api?.logger.error(`[adaptative-governance] Failed to save state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── ID generation ─────────────────────────────────────────────────────────────

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

let _approvalCounter = 0;
function newShortCode(): string {
  _approvalCounter++;
  return `GOV-${_approvalCounter}`;
}

// ─── Observations ─────────────────────────────────────────────────────────────

// Aggregation window: group observation batches within this ms window
const OBS_BATCH_WINDOW_MS = 300_000; // 5 minutes

let _lastObservationAuditTime = 0;
let _pendingObservationKinds: ObservationSignal["kind"][] = [];
let _pendingObservationCount = 0;

export function recordObservation(signal: ObservationSignal): void {
  const state = getState();

  // Audit condensation: batch observations by kind within a time window
  const now = Date.now();
  if (now - _lastObservationAuditTime < OBS_BATCH_WINDOW_MS) {
    _pendingObservationKinds.push(signal.kind);
    _pendingObservationCount++;
    _lastObservationAuditTime = now;
  } else {
    // Flush previous batch
    if (_pendingObservationCount > 0) {
      const summary = summariseObservationBatch(_pendingObservationKinds, _pendingObservationCount);
      appendAudit("observation_batch", summary, "");
    }
    _pendingObservationKinds = [signal.kind];
    _pendingObservationCount = 1;
    _lastObservationAuditTime = now;
  }

  const observations = [...state.observations, { ...signal, id: newId() } as ObservationSignal & { id: string }];
  const trimmed =
    observations.length > state.maxObservations
      ? observations.slice(-state.maxObservations)
      : observations;
  setState({ observations: trimmed });
}

function summariseObservationBatch(kinds: ObservationSignal["kind"][], count: number): string {
  const byKind: Record<string, number> = {};
  for (const k of kinds) byKind[k] = (byKind[k] ?? 0) + 1;
  const parts = Object.entries(byKind).map(([k, v]) => `${v}×${k}`).join(", ");
  return `${count} observations (${parts})`;
}

export function getRecentObservations(sinceMs: number): ObservationSignal[] {
  const cutoff = Date.now() - sinceMs;
  return getState().observations.filter((o) => o.timestamp > cutoff);
}

// ─── Conclusions by session (contradiction detection) ─────────────────────────

const DEFAULT_CONTRADICTION_WINDOW_MS = 3600_000; // 1 hour
const DEFAULT_MAX_CONCLUSIONS_PER_SESSION = 20;

// Capability gap detection
const CAPABILITY_GAP_WINDOW_MS = 1800_000; // 30 minutes
const CAPABILITY_GAP_THRESHOLD = 3; // failures to trigger capability_gap

export function getSessionConclusions(sk: string): SessionConclusionEntry[] {
  const state = getState();
  const windowMs = _pluginConfig.contradictionWindowMs ?? DEFAULT_CONTRADICTION_WINDOW_MS;
  const cutoff = Date.now() - windowMs;
  return (state.conclusionsBySession[sk] ?? []).filter((e) => e.timestamp > cutoff);
}

export function addSessionConclusion(sk: string, content: string): void {
  const state = getState();
  const existing = state.conclusionsBySession[sk] ?? [];
  const windowMs = _pluginConfig.contradictionWindowMs ?? DEFAULT_CONTRADICTION_WINDOW_MS;
  const maxConclusions = _pluginConfig.maxConclusionsPerSession ?? DEFAULT_MAX_CONCLUSIONS_PER_SESSION;
  const cutoff = Date.now() - windowMs;
  const recent = existing.filter((e) => e.timestamp > cutoff);
  const updated = [...recent, { content: content.slice(0, 300), timestamp: Date.now() }].slice(-maxConclusions);
  setState({
    conclusionsBySession: { ...state.conclusionsBySession, [sk]: updated },
  });
}

// ─── Tool failure tracking ────────────────────────────────────────────────────

const TOOL_FAILURE_WINDOW_MS = 1800_000; // 30 minutes
const TOOL_FAILURE_THRESHOLD = 3; // errors to trigger error_spike

// Patterns that indicate a capability gap (missing tool, permission, etc.)
const CAPABILITY_GAP_PATTERNS = [
  "tool not found",
  "tool not available",
  "permission denied",
  "access denied",
  "not authorized",
  "method not found",
  "command not found",
  "function not found",
  "unknown tool",
];

function isCapabilityGapError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return CAPABILITY_GAP_PATTERNS.some((p) => lower.includes(p));
}

export function recordToolFailure(entry: ToolFailureEntry): void {
  const state = getState();
  const existing = state.toolFailureCounts[entry.toolName] ?? [];
  const cutoff = Date.now() - TOOL_FAILURE_WINDOW_MS;
  const recent = existing.filter((e) => e.timestamp > cutoff);
  const updated = [...recent, entry];
  setState({
    toolFailureCounts: { ...state.toolFailureCounts, [entry.toolName]: updated },
  });

  // Auto-detect error_spike if threshold exceeded
  if (updated.filter((e) => e.errorMessage === entry.errorMessage).length >= TOOL_FAILURE_THRESHOLD) {
    recordObservation({
      kind: "error_spike",
      description: `Tool \`${entry.toolName}\` failed ${updated.length}× with same error in last 30 min: "${entry.errorMessage}"`,
      timestamp: Date.now(),
      sessionKey: entry.sessionKey,
    });
  }

  // Auto-detect capability_gap if the same tool has repeated "not found" / "permission denied" errors
  if (isCapabilityGapError(entry.errorMessage)) {
    const gapRecent = updated.filter(
      (e) => isCapabilityGapError(e.errorMessage),
    );
    if (gapRecent.length >= CAPABILITY_GAP_THRESHOLD) {
      recordObservation({
        kind: "capability_gap",
        description: `Tool \`${entry.toolName}\` repeated capability-gap errors: ${gapRecent.map((e) => `"${e.errorMessage}"`).join(", ")}`,
        timestamp: Date.now(),
        sessionKey: entry.sessionKey,
      });
    }
  }
}

export function getRecentToolFailures(toolName: string): ToolFailureEntry[] {
  const state = getState();
  const cutoff = Date.now() - TOOL_FAILURE_WINDOW_MS;
  return (state.toolFailureCounts[toolName] ?? []).filter((e) => e.timestamp > cutoff);
}

// ─── Agent Self-Review ─────────────────────────────────────────────────────────

export function recordSelfReview(review: Omit<SelfReview, "timestamp">): void {
  const full: SelfReview = {
    ...review,
    timestamp: Date.now(),
  };
  setState({ lastSelfReview: full });
  appendAudit("self_review_recorded", `Self-review from session ${review.sessionKey}`, review.taskSummary);

  // Transform gaps into optimization observation signals
  for (const gap of review.gapsIdentified) {
    recordObservation({
      kind: "optimization",
      description: `[Self-review] Agent identified: ${gap}`,
      timestamp: Date.now(),
      sessionKey: review.sessionKey,
    });
  }
}

export function getLastSelfReview(): SelfReview | null {
  return getState().lastSelfReview;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export function createDiagnostic(
  diagnostic: Omit<Diagnostic, "id" | "createdAt" | "resolved">,
): Diagnostic {
  const state = getState();
  const diag: Diagnostic = {
    ...diagnostic,
    id: newId(),
    createdAt: Date.now(),
    resolved: false,
  };
  setState({ diagnostics: [...state.diagnostics, diag] });
  appendAudit("diagnostic_created", `Diagnostic: ${diagnostic.problem}`, diagnostic.hypothesis);
  scheduleSave();
  return diag;
}

export function resolveDiagnostic(id: string): void {
  setState({
    diagnostics: getState().diagnostics.map((d) =>
      d.id === id ? { ...d, resolved: true } : d,
    ),
  });
  markDirty();
}

export function getOpenDiagnostics(): Diagnostic[] {
  return getState().diagnostics.filter((d) => !d.resolved);
}

// ─── Experiments ───────────────────────────────────────────────────────────────

export function createExperiment(
  experiment: Omit<Experiment, "id" | "createdAt" | "status">,
): Experiment {
  const state = getState();
  const exp: Experiment = {
    ...experiment,
    id: newId(),
    createdAt: Date.now(),
    status: "pending",
  };
  setState({ experiments: [...state.experiments, exp] });
  appendAudit("experiment_created", `Experiment proposed`, experiment.description);
  scheduleSave();
  return exp;
}

export function startExperiment(id: string): void {
  patchExperiment(id, { status: "running", startedAt: Date.now() });
  appendAudit("experiment_started", `Experiment started`, id);
  scheduleSave();
}

export async function validateExperiment(
  id: string,
  metrics: Record<string, number | string>,
  note?: string,
): Promise<void> {
  patchExperiment(id, {
    status: "validated",
    endedAt: Date.now(),
    validationMetrics: metrics,
    adoptionNote: note,
  });
  appendAudit("experiment_validated", `Experiment validated and adopted`, id);
  // Apply the change as an overlay context file
  await applyOverlayContext(id);
  scheduleSave();
}

export function rejectExperiment(id: string, reason?: string): void {
  patchExperiment(id, { status: "rejected", endedAt: Date.now() });
  appendAudit("experiment_rejected", `Experiment rejected${reason ? `: ${reason}` : ""}`, id);
  scheduleSave();
}

export function archiveExperiment(id: string): void {
  patchExperiment(id, { status: "archived", endedAt: Date.now() });
  appendAudit("experiment_archived", `Experiment archived`, id);
  scheduleSave();
}

export function rollbackExperiment(id: string): void {
  const exp = getState().experiments.find((e) => e.id === id);
  patchExperiment(id, { status: "archived", endedAt: Date.now() });
  appendAudit("experiment_rolled_back", `Experiment rolled back`, id);
  // Revert overlay context
  if (exp) revertOverlayContext(id);
  scheduleSave();
}

export function expireExperiment(id: string): void {
  patchExperiment(id, { status: "archived", endedAt: Date.now() });
  appendAudit("experiment_expired", `Experiment expired without decision`, id);
  scheduleSave();
}

export function getRunningExperiments(): Experiment[] {
  return getState().experiments.filter((e) => e.status === "running");
}

export function getPendingExperiments(): Experiment[] {
  return getState().experiments.filter((e) => e.status === "pending");
}

export function getAllExperiments(): Experiment[] {
  return getState().experiments;
}

function patchExperiment(id: string, patch: Partial<Experiment>): void {
  setState({
    experiments: getState().experiments.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  });
}

// ─── Overlay Context Files ───────────────────────────────────────────────────────

const OVERLAY_DIR = "governance/overlays";
const APPROVED_OVERLAY_FILE = "GOVERNANCE_ADOPTED.md";
const REVERTED_DIR = "governance/reverted";

async function applyOverlayContext(experimentId: string): Promise<void> {
  if (!_api) return;
  try {
    const { dir: workspaceDir } = await _api.runtime.agent.ensureAgentWorkspace();
    const overlayDir = `${workspaceDir}/${OVERLAY_DIR}`;
    const overlayFile = `${overlayDir}/${APPROVED_OVERLAY_FILE}`;
    const exp = getState().experiments.find((e) => e.id === experimentId);
    if (!exp) return;
    const fs = await import("node:fs/promises");
    await fs.mkdir(overlayDir, { recursive: true });
    const content = [
      `<!-- GOVERNANCE ADOPTED — experiment ${experimentId} — ${new Date().toISOString()} -->`,
      `## Adopted Change`,
      exp.description,
      "",
      `**Type:** ${exp.changeType}`,
      `**Duration:** ${Math.round(exp.bounds.durationMs / 3600000)}h`,
      exp.adoptionNote ? `**Note:** ${exp.adoptionNote}` : "",
      "",
      `This file was generated by the Adaptative Governance plugin.`,
      `Remove this file or the governance overlay to revert the change.`,
    ].join("\n");
    await fs.writeFile(overlayFile, content, "utf-8");
    appendAudit("change_adopted", `Overlay context written`, overlayFile);
  } catch (err) {
    _api?.logger.error(`[governance] Failed to write overlay context: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function revertOverlayContext(experimentId: string): Promise<void> {
  if (!_api) return;
  try {
    const { dir: workspaceDir } = await _api.runtime.agent.ensureAgentWorkspace();
    const overlayFile = `${workspaceDir}/${OVERLAY_DIR}/${APPROVED_OVERLAY_FILE}`;
    const fs = await import("node:fs/promises");
    // Move to reverted dir instead of deleting
    const revertedDir = `${workspaceDir}/${REVERTED_DIR}`;
    await fs.mkdir(revertedDir, { recursive: true });
    await fs.rename(overlayFile, `${revertedDir}/${experimentId}-${Date.now()}.md`);
    appendAudit("change_reverted", `Overlay context reverted`, experimentId);
  } catch (err) {
    _api?.logger?.debug?.(`[governance] Could not revert overlay context: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Approval Requests ─────────────────────────────────────────────────────────

export function createApprovalRequest(
  req: Omit<ApprovalRequest, "id" | "shortCode" | "requestedAt" | "decided">,
): ApprovalRequest {
  const state = getState();
  const approvalReq: ApprovalRequest = {
    ...req,
    id: newId(),
    shortCode: newShortCode(),
    requestedAt: Date.now(),
    decided: false,
  };
  setState({
    approvalRequests: [...state.approvalRequests, approvalReq],
    pendingApproval: approvalReq,
  });
  appendAudit("approval_requested", `Approval requested [${approvalReq.shortCode}]`, req.question);
  scheduleSave();
  return approvalReq;
}

export function resolveApprovalRequest(idOrShortCode: string, response: string): void {
  const state = getState();
  const updated = state.approvalRequests.map((r) =>
    r.id === idOrShortCode || r.shortCode === idOrShortCode
      ? { ...r, response, respondedAt: Date.now(), decided: true }
      : r,
  );
  const resolved = updated.find(
    (r) => r.id === idOrShortCode || r.shortCode === idOrShortCode,
  );
  setState({
    approvalRequests: updated,
    pendingApproval:
      state.pendingApproval?.id === idOrShortCode ||
      state.pendingApproval?.shortCode === idOrShortCode
        ? null
        : state.pendingApproval,
  });
  if (resolved) {
    appendAudit("approval_responded", `Approval [${resolved.shortCode}] responded: ${response}`, resolved.question);
    scheduleSave();
  }
}

export function getPendingApproval(): ApprovalRequest | null {
  return getState().pendingApproval;
}

export function getApprovalRequestByShortCode(shortCode: string): ApprovalRequest | null {
  const state = getState();
  return (
    state.approvalRequests.find((r) => r.shortCode === shortCode && !r.decided) ??
    null
  );
}

export function getAllPendingApprovals(): ApprovalRequest[] {
  const state = getState();
  return state.approvalRequests.filter((r) => !r.decided);
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

function appendAudit(
  kind: AuditKind,
  summary: string,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  const state = getState();
  const maxAudit = _pluginConfig.maxAuditEntries ?? 1000;
  const entry: AuditEntry = { id: newId(), kind, summary, detail, timestamp: Date.now(), extra };
  const auditLog =
    state.auditLog.length >= maxAudit
      ? [...state.auditLog.slice(-(maxAudit - 1)), entry]
      : [...state.auditLog, entry];
  setState({ auditLog });
}

export function getAuditLog(limit = 50): AuditEntry[] {
  return getState().auditLog.slice(-limit);
}

export function logAudit(kind: AuditKind, summary: string, detail: string, extra?: Record<string, unknown>): void {
  appendAudit(kind, summary, detail, extra);
}

// ─── Overlay Mode ─────────────────────────────────────────────────────────────

export function setOverlayMode(mode: "light" | "advanced" | "experimental"): void {
  setState({ overlayMode: mode, isOnboarded: true });
  appendAudit("overlay_mode_changed", `Overlay mode changed to ${mode}`, "");
  scheduleSave();
}

// ─── Per-Agent Governance ────────────────────────────────────────────────────

const AGENT_GOVERNANCE_FILE = "governance.json";

/**
 * Returns the workspace path for a given agentId.
 * Uses api.config to resolve agent workspace.
 */
export function getAgentWorkspace(agentId: string): string | null {
  if (!_api) return null;
  try {
    // Resolve agent workspace from config
    const agentList = _api.config.agents?.list ?? [];
    const agentEntry = agentList.find((a) => a.id === agentId);
    if (!agentEntry) return null;
    const workspace = agentEntry.workspace ?? `~/.openclaw/workspace-${agentId}`;
    // Expand ~ to home dir
    return workspace.replace(/^~/, require("os").homedir());
  } catch {
    return null;
  }
}

/**
 * Load governance state for a specific agent from their workspace.
 */
export async function loadAgentGovernance(agentId: string): Promise<PerAgentGovernance | null> {
  const workspace = getAgentWorkspace(agentId);
  if (!workspace) return null;
  try {
    const fs = await import("node:fs/promises");
    const filePath = `${workspace}/${AGENT_GOVERNANCE_FILE}`;
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as PerAgentGovernance;
  } catch {
    return null;
  }
}

/**
 * Save governance state for a specific agent to their workspace.
 */
async function saveAgentGovernance(gov: PerAgentGovernance): Promise<void> {
  const workspace = getAgentGovernancePath(gov.agentId);
  if (!workspace) return;
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(workspace, { recursive: true });
    const filePath = `${workspace}/${AGENT_GOVERNANCE_FILE}`;
    await fs.writeFile(filePath, JSON.stringify(gov, null, 2), "utf-8");
  } catch (err) {
    _api?.logger?.debug?.(`[governance] Failed to save agent governance: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getAgentGovernancePath(agentId: string): string | null {
  return getAgentWorkspace(agentId);
}

/**
 * Load governance state for all agents in the configured agents list.
 * Returns agents that have a governance.json file.
 */
export async function getAllAgentGovernance(): Promise<PerAgentGovernance[]> {
  const agentIds = _pluginConfig.agents?.length
    ? _pluginConfig.agents!
    : (_api?.config.agents?.list ?? []).map((a: { id: string }) => a.id);

  const results = await Promise.all(
    agentIds.map((id: string) => loadAgentGovernance(id)),
  );
  return results.filter((g): g is PerAgentGovernance => g !== null);
}

/**
 * Enable governance for a specific agent with the given mode.
 */
export async function setAgentGovernance(
  agentId: string,
  mode: "light" | "advanced" | "experimental",
): Promise<boolean> {
  const workspace = getAgentWorkspace(agentId);
  if (!workspace) return false;

  const gov: PerAgentGovernance = {
    agentId,
    mode,
    enabled: true,
    onboardedAt: Date.now(),
  };
  await saveAgentGovernance(gov);
  appendAudit(
    "agent_governance_enabled",
    `Governance enabled for agent ${agentId} in ${mode} mode`,
    `Agent workspace: ${workspace}`,
  );
  return true;
}

/**
 * Disable governance for a specific agent.
 */
export async function disableAgentGovernance(agentId: string): Promise<void> {
  const existing = await loadAgentGovernance(agentId);
  if (!existing) return;
  const gov: PerAgentGovernance = { ...existing, enabled: false };
  await saveAgentGovernance(gov);
  appendAudit("agent_governance_disabled", `Governance disabled for agent ${agentId}`, "");
}

/**
 * Check if governance is active for a given agent.
 */
export async function isAgentGovernanceActive(agentId: string): Promise<boolean> {
  const gov = await loadAgentGovernance(agentId);
  return gov !== null && gov.enabled;
}

/**
 * Get the list of all agent IDs (from config or plugin config).
 */
export function getConfiguredAgentIds(): string[] {
  if (_pluginConfig.agents && _pluginConfig.agents.length > 0) {
    return _pluginConfig.agents;
  }
  return (_api?.config.agents?.list ?? []).map((a: { id: string }) => a.id);
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

export function pauseGovernance(): void {
  setState({ paused: true });
  scheduleSave();
}

export function resumeGovernance(): void {
  setState({ paused: false });
  scheduleSave();
}
