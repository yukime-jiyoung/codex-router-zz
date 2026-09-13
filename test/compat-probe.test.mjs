// The probe needs a provider credential to reach an endpoint, so nothing in
// the suite ran it and a Windows-shaped `file://` string survived review: on a
// POSIX root it produced four slashes and a path beginning "//". A dry run
// exercises every step up to the send -- repository root, registry import,
// catalog selection, request construction -- without a credential and without
// a network, so the matrix runs it on all three platforms.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(REPO, "tools", "compat-probe", "probe.mjs");
const MODEL = "opencode-zen-responses/muse-spark-1.3-contributor-free";
const FAKE_KEY = "dry-run-placeholder-never-sent";

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    // An empty state directory keeps a developer's real credential file out of
    // the run, and the placeholder below is what the probe resolves instead.
    const child = spawn(process.execPath, [PROBE, ...args], {
      cwd: REPO,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_API_KEY: FAKE_KEY,
        OPENCODE_GO_API_KEY: "",
        COMPAT_PROBE_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "compat-probe-")),
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("the probe resolves its own repository and model on this platform", { timeout: 60000 }, async () => {
  const { code, out, err } = await run(["--model", MODEL, "--tier", "full", "--dry-run"]);
  assert.equal(code, 0, `probe exited ${code}\n${err}`);

  // Importing the registry through a hand-built file:// URL is what broke on
  // POSIX, and it fails before any of this is printed.
  assert.match(out, /muse-spark-1\.3-contributor-free/, "resolved the model through the registry");
  assert.match(out, /opencode\.ai/, "resolved the provider endpoint");
  assert.match(out, /--dry-run/, "stopped before sending");

  // A credential reaching an artifact or a log is the one failure that cannot
  // be undone after the fact, so the probe is held to it even when it refuses.
  assert.doesNotMatch(out + err, new RegExp(FAKE_KEY), "the credential is never printed");
});

test("an unknown model is refused rather than probed", { timeout: 60000 }, async () => {
  const { code, out, err } = await run(["--model", "opencode-zen-responses/not-a-model", "--dry-run"]);
  assert.notEqual(code, 0, `expected a refusal, got:\n${out}`);
  assert.match(err, /unknown model/, err);
});

// Not a dry run: the credential is resolved before the first request is built,
// so an install with no key stops here rather than part-way through a sequence.
// Nothing is sent, because nothing gets as far as being sent.
test("a provider with no credential says where to put one", { timeout: 60000 }, async () => {
  const { code, err } = await run(["--model", MODEL], {
    OPENCODE_API_KEY: "",
    OPENCODE_GO_API_KEY: "",
  });
  assert.notEqual(code, 0, "expected a refusal");
  assert.match(err, /no credential resolved/);
  // The message has to name both routes to a credential, because the state
  // directory it points at differs per platform and per CODEX_HOME.
  assert.match(err, /OPENCODE_API_KEY/, err);
  assert.match(err, /opencode-go-api-key\.secret/, err);
});
