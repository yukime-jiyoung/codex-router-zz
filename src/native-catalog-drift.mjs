import { existsSync, readFileSync } from "node:fs";
import { NATIVE_CATALOG_PATH, CONFIG_PATH } from "./paths.mjs";
import { nativeCatalogIsReusable, readModelsCache, routedCatalogConfigured } from "./catalog.mjs";
import { codexBinaryFingerprint, codexVersion } from "./codex-binary.mjs";
import { refreshNativeAccountCatalog } from "./native-account-catalog.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { routedCodexAgentStatus } from "./codex-agent-catalog.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
  subagentEligibleModels,
} from "./multi-agent-state.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { selectedConfiguredListedModels } from "./provider-selection.mjs";

// Marker prefix config-manager.mjs writes around router-owned Codex blocks.
// Keep this compatibility surface aligned with target-integration.mjs.
const managedMarkerPattern = /^# BEGIN (?:kimi-)?codex-(?:router|proxy)-/m;

export function managedCodexConfigDetected(contents) {
  return typeof contents === "string" && managedMarkerPattern.test(contents);
}

/**
 * Check if Codex integration is installed (has managed config).
 * Same logic as target-integration.mjs codexIntegrationInstalled().
 */
function codexIntegrationInstalled() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    return managedCodexConfigDetected(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // Fail closed: if config exists but cannot be read, assume not installed.
    // This is conservative for drift detection - missing a check is safer than
    // attempting republish when integration state is unknown.
    return false;
  }
}

/**
 * Check whether the router-managed Codex agent definitions disagree with the
 * current routed-model and subagent settings. Any uncertainty returns false:
 * startup reconciliation must never turn an unreadable config into a write.
 */
export function routedAgentCatalogDriftDetected({
  integrationInstalled = codexIntegrationInstalled,
  readConfig = () => readFileSync(CONFIG_PATH, "utf8"),
  selectedModels = selectedConfiguredListedModels,
  readSettings = readMultiAgentSettings,
  readHidden = readHiddenModels,
  agentStatus = routedCodexAgentStatus,
} = {}) {
  if (!integrationInstalled()) return false;
  try {
    const contents = readConfig();
    if (!routedCatalogConfigured(contents)) return false;
    const settings = readSettings();
    const hidden = readHidden();
    const effective = applyMultiAgentCapabilities(selectedModels(), settings, { hidden });
    const eligible = subagentEligibleModels(effective, settings);
    return !agentStatus(eligible).ok;
  } catch {
    // Startup reconciliation must never turn an uncertain read into a write.
    return false;
  }
}

/**
 * Check if native catalog drift requires republish, without blocking startup.
 * Returns true if drift detected (fingerprint/version mismatch).
 */
export function nativeCatalogDriftDetected() {
  // models_cache.json is account-derived. The discovery kill-switch applies
  // to the comparison just as it does to the live refresh that precedes it.
  if (discoveryDisabled()) return false;
  // Only applies when Codex integration is active
  if (!codexIntegrationInstalled() && !existsSync(NATIVE_CATALOG_PATH)) {
    return false;
  }

  try {
    const cache = readModelsCache();
    if (!cache.catalog) {
      // No models_cache.json or invalid - nothing to compare
      return false;
    }

    // If no stored catalog exists yet, no drift to detect
    if (!existsSync(NATIVE_CATALOG_PATH)) {
      return false;
    }

    // Read the stored native catalog
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));

    // Check account-cache, CLI-version, and installed-binary identity.
    const version = codexVersion();
    const binaryFingerprint = codexBinaryFingerprint();
    return !nativeCatalogIsReusable(
      parsed,
      version,
      cache.fingerprint,
      binaryFingerprint,
    );
  } catch {
    // Any error means we can't reliably detect drift
    return false;
  }
}

/**
 * Asynchronously republish catalog if native drift detected.
 * Runs in background after startup, does not block.
 */
export async function republishOnNativeDrift({
  refreshAccountCatalog = refreshNativeAccountCatalog,
  refreshTargetPicker,
  nativeDriftDetected = nativeCatalogDriftDetected,
  routedAgentDriftDetected = routedAgentCatalogDriftDetected,
} = {}) {
  // model_catalog_json stops Codex's own account cache writer. Refresh the
  // fixed ChatGPT account endpoint first; on any failure the updater leaves
  // the prior cache untouched and the local drift comparison remains safe.
  await refreshAccountCatalog();
  const nativeDrift = nativeDriftDetected();
  const routedAgentDrift = routedAgentDriftDetected();
  if (!nativeDrift && !routedAgentDrift) {
    return false;
  }

  const driftLabel = nativeDrift
    ? routedAgentDrift
      ? "Native catalog and routed agent drift"
      : "Native catalog drift"
    : "Routed agent drift";

  try {
    // Dynamic import to avoid startup dependency
    const refresh = refreshTargetPicker || (
      await import("./target-integration.mjs")
    ).refreshTargetPickerIfInstalled;
    await refresh();
    console.error(`[codex-router] ${driftLabel} detected and republished automatically.`);
    return true;
  } catch (error) {
    console.error(
      `[codex-router] ${driftLabel} detected but republish failed: ${error.message}`
    );
    return false;
  }
}
