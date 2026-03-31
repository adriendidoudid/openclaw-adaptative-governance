import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  recordObservation,
  getState,
  getSessionConclusions,
  addSessionConclusion,
  recordToolFailure,
} from "../state.js";
import type { ObservationSignal, ToolFailureEntry } from "../types.js";
import { onAgentTaskComplete } from "../service.js";
import { isAgentGovernanceActive } from "../state.js";

// Handler type matching what api.registerHook expects
type GovernanceHookHandler = Parameters<OpenClawPluginApi["registerHook"]>[1];

// Captured at registerObserverHooks time — used for analysis callbacks
let _observerApi: OpenClawPluginApi | null = null;

// ─── Signal Keywords ───────────────────────────────────────────────────────────

const UNCERTAINTY_MARKERS = [
  "i'm not sure",
  "i am not sure",
  "not certain",
  "unsure",
  "unclear",
  "might be",
  "could be",
  "perhaps",
  "possibly",
  "i don't know",
  "i dont know",
  "difficult to say",
  "hard to determine",
  "needs more",
  "incomplete",
];

const QUALITY_DROP_MARKERS = [
  "contradiction",
  "inconsistent",
  "doesn't match",
  "doesn't align",
  "regression",
  "worse than",
  "degraded",
  "lower quality",
];

// Expiry for contradiction window is 1 hour — managed in state.ts

// ─── Helper: detect opposite conclusions ───────────────────────────────────────

function isOpposite(a: string, b: string): boolean {
  const pos = ["buy", "up", "positive", "bull", "increase", "gain", "expand", "add", "long"];
  const neg = ["sell", "down", "negative", "bear", "decrease", "reduce", "short", "remove"];
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const aPos = pos.some((w) => aLower.includes(w));
  const aNeg = neg.some((w) => aLower.includes(w));
  const bPos = pos.some((w) => bLower.includes(w));
  const bNeg = neg.some((w) => bLower.includes(w));
  return (aPos && bNeg) || (aNeg && bPos);
}

// ─── message:preprocessed observer ───────────────────────────────────────────

export const messagePreprocessedHandler: GovernanceHookHandler = async (event) => {
  const state = getState();
  if (state.paused || !state.isOnboarded) return;

  const ctx = (event as { context?: Record<string, unknown> }).context ?? {};
  const bodyForAgent = (ctx.bodyForAgent as string | undefined) ?? "";
  if (!bodyForAgent || bodyForAgent.length < 10) return;

  const signals: ObservationSignal[] = [];
  const bodyLower = bodyForAgent.toLowerCase();
  const now = Date.now();
  const sk = (event as { sessionKey?: string }).sessionKey ?? "default";

  // 1. Uncertainty signals
  for (const marker of UNCERTAINTY_MARKERS) {
    if (bodyLower.includes(marker)) {
      signals.push({
        kind: "uncertainty",
        description: `Uncertainty marker: "${marker}"`,
        timestamp: now,
        sessionKey: sk,
      });
      break;
    }
  }

  // 2. Quality-drop / inconsistency signals
  for (const marker of QUALITY_DROP_MARKERS) {
    if (bodyLower.includes(marker)) {
      signals.push({
        kind: "quality_drop",
        description: `Quality concern: "${marker}"`,
        timestamp: now,
        sessionKey: sk,
      });
      break;
    }
  }

  // 3. Contradiction detection — compare against stored session conclusions
  const history = getSessionConclusions(sk);
  for (const entry of history) {
    if (isOpposite(entry.content, bodyForAgent)) {
      signals.push({
        kind: "contradiction",
        description: `Contradiction: earlier conclusion differs from current output`,
        timestamp: now,
        sessionKey: sk,
      });
      break;
    }
  }

  // Always record conclusion for future contradiction checks
  addSessionConclusion(sk, bodyForAgent);

  // 4. Log signals
  for (const signal of signals) {
    recordObservation(signal);
  }
};

// ─── tool_result_persist observer ────────────────────────────────────────────

export const toolResultPersistHandler: GovernanceHookHandler = async (event) => {
  const state = getState();
  if (state.paused || !state.isOnboarded) return;

  // tool_result_persist event shape:
  // { id, type: "tool_result_persist", sessionKey, context: { toolName, result, error, durationMs } }
  const ctx = (event as { context?: Record<string, unknown> }).context ?? {};
  const toolName = (ctx.toolName as string | undefined) ?? "unknown";
  const errorMsg = (ctx.error as string | undefined) ?? "";
  const sk = (event as { sessionKey?: string }).sessionKey;

  if (!errorMsg) return;

  // Record tool failure for spike detection
  const entry: ToolFailureEntry = {
    toolName,
    errorMessage: errorMsg,
    timestamp: Date.now(),
    sessionKey: sk,
  };
  recordToolFailure(entry);
};

// ─── message:received handler ─────────────────────────────────────────────────

export const messageReceivedHandler: GovernanceHookHandler = async (event) => {
  const state = getState();
  if (state.paused || !state.isOnboarded) return;
  if (!_observerApi) return;

  // Extract agent ID from sessionKey (format: "agent:<agentId>:...")
  const sk = (event as { sessionKey?: string }).sessionKey ?? "";
  const segments = sk.split(":");
  const agentId = segments[1] ?? "default";

  // Only run governance analysis if this agent has governance enabled
  const governanceActive = await isAgentGovernanceActive(agentId);
  if (!governanceActive) return;

  onAgentTaskComplete(_observerApi);
};

// ─── Registry helper ───────────────────────────────────────────────────────────

export function registerObserverHooks(api: OpenClawPluginApi): void {
  _observerApi = api;
  api.registerHook(["message:preprocessed"], messagePreprocessedHandler);
  api.registerHook(["message:received"], messageReceivedHandler);
  api.registerHook(["tool_result_persist"], toolResultPersistHandler);
}
