// Observation records. A capability value without the evidence that produced it
// is how a wrong `contextWindow` travels from one catalog into three downstream
// applications, so nothing here stores a verdict on its own.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SCHEMA = "compat-observation/1";
export const PROBE_VERSION = "1.0.0";

// Every outcome this probe can reach. `accepted_ignored` is the one that matters
// most: a 400 announces itself, while a parameter the endpoint accepts and then
// discards looks like success to any test that only reads the status line.
export const OUTCOME = {
  ACCEPTED_HONORED: "accepted_honored",
  // The endpoint already does what the parameter asks for, with or without it.
  // Harmless, and emphatically not the same as discarding it -- conflating the
  // two reported a working usage counter as broken on 2026-09-12.
  ACCEPTED_UNCONDITIONAL: "accepted_unconditional",
  ACCEPTED_IGNORED: "accepted_ignored",
  REJECTED: "rejected",
  OUTPUT_SHAPE_DIFFERS: "output_shape_differs",
  ERROR_UPSTREAM: "error_upstream",
  UNOBSERVABLE: "unobservable",
};

// Anything token-shaped is removed before an excerpt is written anywhere. The
// probe holds a live credential; no artifact it produces may carry one.
export function scrub(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out
    .replace(/(sk|xai|gsk|Bearer|token|secret|key|authorization)[-_ :="']*[A-Za-z0-9_-]{12,}/gi, "$1 [REDACTED]")
    .slice(0, 600);
}

export function fingerprint({ baseUrl, endpointPath, protocol, model }) {
  return "sha256:" + createHash("sha256")
    .update([baseUrl, endpointPath, protocol, model].join("|"))
    .digest("hex")
    .slice(0, 32);
}

// `spec`, `reference` and `target` stay separate on purpose. Collapsing them is
// how "the endpoint rejected it" turns into "the endpoint is wrong", which on
// 2026-09-11 produced a workaround for what may well be a conformant refusal.
export function conclude({ spec, reference, target }) {
  if (target === OUTCOME.ACCEPTED_UNCONDITIONAL) return "CONFORMANT";
  if (target === OUTCOME.ACCEPTED_IGNORED) return "SILENT_DIVERGENCE";
  if (target === OUTCOME.ERROR_UPSTREAM) return "INCONCLUSIVE";
  const targetRejects = target === OUTCOME.REJECTED;
  if (!targetRejects) return "CONFORMANT";
  if (spec === "required_rejection") {
    return reference === OUTCOME.ACCEPTED_HONORED ? "REFERENCE_LENIENT" : "CONFORMANT";
  }
  if (spec === "must_accept") return "CONFORMANCE_FAILURE";
  if (reference === OUTCOME.ACCEPTED_HONORED) return "BEHAVIORAL_DIVERGENCE";
  return "DIVERGENCE_UNCONFIRMED";
}

export function buildRecord({
  test, endpoint, model, accountTier,
  variantA, variantB, target, reference, ttlDays = 30, notes,
}) {
  const testedAt = new Date();
  const expires = new Date(testedAt.getTime() + ttlDays * 86400_000);
  return {
    schema: SCHEMA,
    test_id: test.id,
    feature: test.feature,
    endpoint,
    model,
    account_tier: accountTier ?? null,
    spec: { verdict: test.spec ?? "unspecified", source: test.specSource ?? null },
    reference: reference ?? { verdict: "unknown", endpoint: null, reason: "no reference credential available" },
    target,
    conclusion: conclude({
      spec: test.spec ?? "unspecified",
      reference: reference?.verdict,
      target: target.verdict,
    }),
    reliability: test.reliability,
    variant_a: variantA,
    variant_b: variantB,
    declared: test.declared ?? { source: null, value: null },
    observed: { value: target.verdict, confidence: test.reliability === "S" ? "high" : "medium" },
    notes: notes ?? null,
    tested_at: testedAt.toISOString(),
    expires_at: expires.toISOString(),
    source: "active_probe",
    probe_version: PROBE_VERSION,
  };
}

export function save(records, outDir) {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `observations-${stamp}.json`);
  writeFileSync(file, JSON.stringify(records, null, 2) + "\n", "utf8");
  return file;
}

// The profile a router would actually consume. Derived from observations rather
// than written by hand, and it carries the evidence pointer with every value.
export function toProfile(records) {
  const profile = { schema: "compat-profile/1", generated_at: new Date().toISOString(), features: {} };
  for (const record of records) {
    profile.features[record.feature] = {
      observed: record.observed.value,
      conclusion: record.conclusion,
      confidence: record.observed.confidence,
      test_id: record.test_id,
      tested_at: record.tested_at,
      expires_at: record.expires_at,
    };
  }
  return profile;
}
