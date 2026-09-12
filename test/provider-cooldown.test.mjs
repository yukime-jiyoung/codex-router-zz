import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-cooldown-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const {
  activeProviderCooldown,
  cooldownScope,
  nextQuotaCooldownExpiry,
  quotaResetAt,
  recordProviderCooldown,
  temporarilyUnavailableSubagentSlugs,
} = await import("../src/provider-cooldown.mjs");

const NOW = Date.parse("2026-08-11T22:00:00.000Z");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("subscription variants share a breaker while separately billed Zen does not", () => {
  assert.equal(cooldownScope("opencode-go"), "opencode-go");
  assert.equal(cooldownScope("opencode-go-messages"), "opencode-go");
  assert.equal(cooldownScope("opencode-go-responses"), "opencode-go");
  assert.equal(cooldownScope("opencode-zen"), "opencode-zen");
});

test("a body-only subscription reset opens a durable provider circuit", () => {
  const bodyText = JSON.stringify({
    error: { message: "5-hour usage limit reached. Resets in 1hr 20min." },
  });
  assert.equal(quotaResetAt(bodyText, NOW), NOW + 80 * 60_000);
  const recorded = recordProviderCooldown({
    providerId: "opencode-go-responses",
    status: 429,
    bodyText,
    headers: new Headers(),
    translatedType: "billing_error",
    now: NOW,
  });
  assert.equal(recorded.until, NOW + 80 * 60_000);
  assert.equal(recorded.reason, "quota");
  assert.equal(
    activeProviderCooldown("opencode-go-messages", { now: NOW + 1_000 }).until,
    NOW + 80 * 60_000,
  );
  assert.equal(activeProviderCooldown("opencode-zen", { now: NOW + 1_000 }), undefined);
});

test("plain 429s without pacing headers get a short bounded circuit", () => {
  const recorded = recordProviderCooldown({
    providerId: "deepseek",
    status: 429,
    bodyText: "rate limited",
    headers: new Headers(),
    translatedType: "rate_limit_error",
    now: NOW,
  });
  assert.equal(recorded.until, NOW + 60_000);
  assert.equal(recorded.reason, "rate_limit");
  assert.equal(activeProviderCooldown("deepseek", { now: NOW + 60_001 }), undefined);
});

test("only hard quota circuits temporarily remove subagent models", () => {
  const models = [
    { slug: "opencode-go/kimi-k3", provider: "opencode-go" },
    { slug: "opencode-go-messages/minimax-m3", provider: "opencode-go-messages" },
    { slug: "opencode-zen/kimi-k3", provider: "opencode-zen" },
    { slug: "deepseek/deepseek-v4-pro", provider: "deepseek" },
  ];
  assert.deepEqual(
    [...temporarilyUnavailableSubagentSlugs(models, { now: NOW + 1_000 })].sort(),
    ["opencode-go-messages/minimax-m3", "opencode-go/kimi-k3"],
  );
  assert.equal(nextQuotaCooldownExpiry({ now: NOW + 1_000 }), NOW + 80 * 60_000);
  assert.deepEqual(
    [...temporarilyUnavailableSubagentSlugs(models, { now: NOW + 80 * 60_000 + 1 })],
    [],
  );
});
