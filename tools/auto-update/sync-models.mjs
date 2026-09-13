// Keeps the picker current without asking anyone to watch a provider's
// changelog. Providers add and retire models on their own schedule, and the
// gap between "it exists" and "it is in your picker" is otherwise a person
// noticing.
//
//   node tools/auto-update/sync-models.mjs [options]
//
//     --providers a,b        only these (default: every selected, credentialed one)
//     --budget N             test at most N candidates this run (default 10)
//     --only id1,id2         consider only these model ids
//     --apply                add what passes (default: report only)
//     --include-restricted   also add models whose provider restricts them to
//                            its own client (measured, not assumed -- see below)
//     --json                 machine-readable summary on stdout
//
// The reason this can run unattended is the probe. Adding a model a catalog
// merely mentions is how a picker fills up with entries that fail on first
// use -- and one class of failure, a tool call the endpoint refuses, is
// replayed on every later turn and ends the conversation for good. So nothing
// is added on the strength of being listed: each candidate has to answer a
// real turn, and on a Responses provider it has to survive the compatibility
// probe with no unhandled behaviour, before it is written anywhere.
//
// What it will not do, by design:
//   - remove anything. A model the provider stopped serving is reported, not
//     deleted: a rename, an outage and a retirement look identical from here
//     and only one of them is answered by dropping a route.
//   - touch a provider that is not already selected and credentialed. This
//     keeps an existing setup current; it does not enable or pay for anything.
//   - treat a rate limit as a verdict. A throttled candidate is left for the
//     next run rather than recorded as broken.
//   - add a model its provider restricts to its own client, unless asked.
//     That restriction is measured here, not guessed from a name.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SYNC_MODELS_SOURCE_ROOT || path.resolve(HERE, "..", "..");
const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR
  || process.env.CODEX_ROUTER_STATE_DIR
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-router");
const LOG = path.join(STATE_DIR, "sync-models.log");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 || argv[at + 1]?.startsWith("--") ? fallback : argv[at + 1];
};

const apply = has("apply");
const includeRestricted = has("include-restricted");
const asJson = has("json");
const onlyProviders = (opt("providers", "") || "").split(",").filter(Boolean);
// Measuring a candidate means sending it a real turn, and on a paid provider a
// real turn is a real charge. A provider can add dozens of models at once, so
// a run tests a bounded number of them and the rest wait for the next one --
// a schedule catches up within a few runs, and nobody wakes up to a bill for
// sixty models they never asked about.
const budget = Math.max(1, Number(opt("budget", "10")) || 10);
// Candidates are considered in the order the provider lists them, which is no
// order at all when the question is about one model. `--only` answers that
// question without paying for the forty that sort ahead of it.
const only = new Set((opt("only", "") || "").split(",").filter(Boolean));

const load = (file) => import(pathToFileURL(path.join(ROOT, "src", file)).href);
const registry = await load("model-registry.mjs");
const discovery = await load("model-discovery.mjs");
const selection = await load("provider-selection.mjs");
const credentials = await load("provider-api-key-routing.mjs");

const say = (line) => { if (!asJson) console.log(line); };
const redact = (text, key) => (key ? String(text).replaceAll(key, "[redacted]") : String(text));

// A header a provider reads to recognise its own client. Sending it is what the
// router already does for that provider; sending a request *without* it is how
// a client restriction becomes visible rather than assumed.
const CLIENT_HEADERS = {
  opencode: { "x-opencode-session": "00000000-0000-4000-8000-000000000001" },
};
const clientHeadersFor = (provider) =>
  Object.entries(CLIENT_HEADERS).find(([prefix]) => provider.id.startsWith(prefix))?.[1] ?? null;

// ── which providers are in scope ────────────────────────────────────────────
// Selection says a provider is wanted; a credential says it is reachable. Both
// are required: discovery against a provider with no key is a round trip that
// can only fail, and adding its models is a picker full of entries that error
// on first use.
function providersInScope() {
  const selected = new Set(selection.readProviderSelection());
  const scoped = [];
  for (const provider of registry.PROVIDERS.values()) {
    if (onlyProviders.length ? !onlyProviders.includes(provider.id) : !selected.has(provider.id)) continue;
    let configured = false;
    try {
      configured = credentials.effectiveProviderCredentialStatus(provider, { persistent: true }).configured === true;
    } catch { configured = false; }
    if (!configured) { say(`skip   ${provider.id}: no credential`); continue; }
    if (provider.kind !== "openai-compatible") { say(`skip   ${provider.id}: no model-list endpoint`); continue; }
    scoped.push(provider);
  }
  return scoped;
}

function credentialFor(provider) {
  for (const name of provider.credential?.environment ?? []) {
    if (process.env[name]) return process.env[name].trim();
  }
  const file = provider.credential?.file;
  if (file) {
    try { return readFileSync(path.join(STATE_DIR, file), "utf8").trim(); } catch { /* fall through */ }
  }
  return null;
}

// ── does the endpoint actually answer for this model ────────────────────────
// A status line is not an answer: this endpoint family returns 200 with an
// upstream failure in the body, and a model can accept the connection and then
// never respond. Both are unusable, and both are caught here rather than by
// someone whose first message hangs.
async function ask(provider, modelId, key, { withClientHeaders = true } = {}) {
  // An absent protocol is the registry's default, Chat Completions -- not
  // Responses. Reading it the other way sends Responses bodies to a Chat
  // Completions endpoint, which answers 500 for every candidate alike.
  const responses = provider.protocol === "openai-responses";
  const url = provider.baseUrl + (responses ? "/responses" : "/chat/completions");
  const body = responses
    ? { model: modelId, stream: false, store: false, max_output_tokens: 16,
        input: [{ role: "user", content: [{ type: "input_text", text: "say ok" }] }] }
    : { model: modelId, stream: false, max_tokens: 16,
        messages: [{ role: "user", content: "say ok" }] };
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(withClientHeaders ? clientHeadersFor(provider) ?? {} : {}),
  };
  try {
    const res = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    const inner = parsed?.error?.message;
    return {
      status: res.status,
      ok: res.ok && !inner,
      message: inner ? redact(inner, key) : "",
      throttled: res.status === 429 || /rate.?limit/i.test(inner ?? ""),
    };
  } catch (error) {
    const timedOut = error.name === "TimeoutError";
    return {
      status: 0,
      ok: false,
      message: timedOut ? "no response within 45s" : redact(error.message, key),
      throttled: false,
    };
  }
}

// ── the compatibility gate ──────────────────────────────────────────────────
// Only Responses providers are probed, because that is the surface the probe
// speaks. A Chat Completions model clears the turn check and nothing more, and
// the summary says so rather than implying a measurement that did not happen.
function probe(providerId, modelId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, "tools", "compat-probe", "probe.mjs"),
      "--model", `${providerId}/${modelId}`, "--candidate", "--tier", "smoke",
    ], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", () => resolve({ ok: false, why: "probe failed to start" }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, why: "probe exited non-zero" });
      const notable = /要注意 (\d+) 件/.exec(out);
      const count = notable ? Number(notable[1]) : 0;
      resolve(count > 0
        ? { ok: false, why: `probe found ${count} unhandled behaviour(s)` }
        : { ok: true, why: "probe clean" });
    });
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", (e) => resolve({ code: 1, out: String(e.message) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// ── main ────────────────────────────────────────────────────────────────────
const summary = { checked: 0, candidates: 0, added: [], rejected: [], deferred: [], gone: [], errors: [] };

for (const provider of providersInScope()) {
  summary.checked += 1;
  let found;
  try {
    found = await discovery.discoverProviderModels(provider.id, { refresh: true });
  } catch (error) {
    summary.errors.push({ provider: provider.id, why: String(error.message) });
    say(`error  ${provider.id}: ${error.message}`);
    continue;
  }

  for (const id of found.unavailable ?? []) {
    summary.gone.push({ provider: provider.id, model: id });
    say(`gone   ${provider.id}/${id} (registered, no longer served)`);
  }
  for (const [id, reason] of Object.entries(found.blocked ?? {})) {
    say(`held   ${provider.id}/${id}: ${reason}`);
  }

  const key = credentialFor(provider);
  const accepted = [];
  for (const id of found.addable ?? []) {
    if (only.size && !only.has(id)) continue;
    if (summary.candidates >= budget) {
      summary.deferred.push({ provider: provider.id, model: id, why: "budget reached" });
      continue;
    }
    summary.candidates += 1;

    const turn = await ask(provider, id, key);
    if (turn.throttled) {
      summary.deferred.push({ provider: provider.id, model: id, why: "rate limited" });
      say(`later  ${provider.id}/${id}: rate limited, will retry next run`);
      continue;
    }
    if (!turn.ok) {
      const why = turn.message || `HTTP ${turn.status}`;
      summary.rejected.push({ provider: provider.id, model: id, why });
      say(`reject ${provider.id}/${id}: ${why.slice(0, 120)}`);
      continue;
    }

    // Measured, not guessed: the same request minus the header the provider
    // uses to recognise its own client. A refusal that names that restriction
    // is the provider saying this model is not for third-party traffic.
    if (!includeRestricted && clientHeadersFor(provider)) {
      const bare = await ask(provider, id, key, { withClientHeaders: false });
      if (!bare.ok && !bare.throttled && /can only be used in|only available in/i.test(bare.message)) {
        summary.rejected.push({ provider: provider.id, model: id, why: `provider restricts it to its own client: ${bare.message.slice(0, 90)}` });
        say(`reject ${provider.id}/${id}: provider restricts it to its own client (--include-restricted to override)`);
        continue;
      }
    }

    const responses = provider.protocol === "openai-responses";
    const checked = responses ? await probe(provider.id, id) : { ok: true, why: "turn only (not a Responses surface)" };
    if (!checked.ok) {
      summary.rejected.push({ provider: provider.id, model: id, why: checked.why });
      say(`reject ${provider.id}/${id}: ${checked.why}`);
      continue;
    }

    accepted.push(id);
    summary.added.push({ provider: provider.id, model: id, evidence: `HTTP ${turn.status}; ${checked.why}` });
    say(`ok     ${provider.id}/${id}: HTTP ${turn.status}; ${checked.why}`);
  }

  if (apply && accepted.length) {
    const curated = await run([path.join(ROOT, "src", "curate-models.mjs"), provider.id, "--models", accepted.join(","), "--apply"]);
    if (curated.code !== 0) {
      summary.errors.push({ provider: provider.id, why: `curate-models: ${curated.out.trim().slice(0, 200)}` });
      say(`error  ${provider.id}: curate-models exited ${curated.code}`);
    }
  }
}

if (apply && summary.added.length && !summary.errors.length) {
  const refreshed = await run([path.join(ROOT, "src", "refresh-catalog.mjs")]);
  if (refreshed.code !== 0) summary.errors.push({ why: `refresh-catalog: ${refreshed.out.trim().slice(0, 200)}` });
}

try {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), apply, ...summary })}\n`, "utf8");
} catch { /* the log is a convenience, not a result */ }

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  say("");
  say(`providers ${summary.checked}  candidates ${summary.candidates}  added ${summary.added.length}  `
    + `rejected ${summary.rejected.length}  deferred ${summary.deferred.length}  no longer served ${summary.gone.length}`);
  if (!apply && summary.added.length) say("Report only. Pass --apply to add them.");
  if (apply && summary.added.length) say("They appear in the picker the next time Codex starts.");
}

process.exit(summary.errors.length ? 1 : 0);
