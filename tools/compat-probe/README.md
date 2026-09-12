# compat-probe

Measures what an OpenAI-compatible endpoint actually accepts, instead of trusting what a catalog says about it.

```sh
node tools/compat-probe/probe.mjs --model <provider>/<model> [--tier smoke|full] [--dry-run]
```

Reads the route from the router's own registry and the credential from where the router would look, so a model that probes clean is a model the router can reach. Nothing is printed, logged, or written that could carry a credential.

## What it sends

Controlled pairs. Two requests differing in exactly one field, so a result tells you which field moved the boundary — not merely that something failed.

```
T_HISTORY_EMPTY_ARGS_001
  A: a prior tool call whose arguments are "{}"
  B: the same call with ""
```

Tools are declared and never executed. `store: false`, output capped, requests serialised with backoff. `--dry-run` prints the request count first.

## What it reports

| outcome | meaning |
|---|---|
| `accepted_honored` | the parameter did something |
| `accepted_unconditional` | the endpoint was already doing it — the parameter is redundant, not ignored |
| `accepted_ignored` | accepted and discarded. **Returns 200 and passes any status-only test** |
| `rejected` | refused, with the upstream's own `param` and `type` |
| `unobservable` | the task cannot separate the pair; said plainly rather than guessed |

Distinguishing the second row from the fourth is the point. A probe that collapses them reports a working endpoint as broken — this one did, once, before the control was read on both halves of the pair.

## What it writes

One record per test under `observations/`, each carrying the evidence: what was sent, what came back, what the control did, when, and under which test id. A capability value with no evidence attached is how a wrong number travels from one catalog into three downstream applications.

`profiles/` holds the same thing collapsed into the shape a router would consume.

## Verdicts are three-way

`spec`, `reference` and `target` stay separate. A refusal that follows the written specification is not the endpoint's fault, and treating it as one produces a workaround for correct behaviour. Without a reference credential the reference verdict stays `unknown` and the conclusion says so.

## Tiers

- `smoke` — the acceptance boundaries that have broken production, and the silent-ignore checks. ~26 requests.
- `full` — adds sequence tests: the model is made to emit a tool call, and **its own output** is replayed back with one field changed at a time. Synthetic history is how four reproduction attempts passed while production kept failing; hand-built input silently omitted the one field that mattered.
- `limits` — context and schema ceilings. Expensive, not run by default.
