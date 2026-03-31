import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { GOVERNANCE_TOOLS } from "./tools/index.js";
import { registerObserverHooks } from "./hooks/observer.js";
import { createGovernanceService } from "./service.js";
import { registerCommands } from "./commands.js";
import {
  initState,
  loadState,
  getState,
  setOverlayMode,
  logAudit,
} from "./state.js";
import type { PluginConfig } from "./types.js";

// ─── Entry point ───────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "adaptative-governance",
  name: "Adaptative Governance",
  description:
    "Adaptive governance overlay — observes agent behavior, detects improvement opportunities, runs bounded experiments, and asks for approval before structural changes",

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Partial<PluginConfig>;

    // Initialize state with runtime references
    initState(api, cfg);

    // Load persisted state from disk
    loadState().catch((err) => {
      api.logger.warn(`[adaptative-governance] State load failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    // ── Onboarding ──────────────────────────────────────────────────────────────
    const state = getState();

    if (!state.isOnboarded) {
      logAudit(
        "onboarding_completed",
        "Plugin first startup — onboarding pending",
        `User must choose overlay mode: light/advanced/experimental`,
      );

      // If user pre-configured overlayMode via plugin config, apply it directly
      if (cfg.overlayMode) {
        setOverlayMode(cfg.overlayMode as "light" | "advanced" | "experimental");
        api.logger.info(`[adaptative-governance] Onboarded with preset mode: ${cfg.overlayMode}`);
      }
    }

    // ── Register all tools ─────────────────────────────────────────────────────
    for (const tool of GOVERNANCE_TOOLS) {
      api.registerTool(tool);
    }

    // ── Register chat commands ────────────────────────────────────────────────
    registerCommands(api);

    // ── Register observer hooks ────────────────────────────────────────────────
    if (cfg.autoObserve !== false) {
      registerObserverHooks(api);
    }

    // ── Register governance service ───────────────────────────────────────────
    const svc = createGovernanceService(api);
    api.registerService({
      id: "adaptative-governance",
      start: async () => {
        await svc.start();
        api.logger.info("[adaptative-governance] Service started");
      },
      stop: () => {
        svc.stop();
        api.logger.info("[adaptative-governance] Service stopped");
      },
    });

    api.logger.info(
      `[adaptative-governance] Registered — overlay: ${getState().overlayMode}, onboarded: ${getState().isOnboarded}`,
    );
  },
});
