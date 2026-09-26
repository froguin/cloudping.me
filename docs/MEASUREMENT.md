# Measurement contract

cloudping reports HTTP round-trip latency from **two different vantage points**.
They are intentionally different measurements, and this document is the shared
contract they both follow so the numbers are produced consistently even though
they can never be identical.

## Two vantage points, two questions

| | From You | Health |
|---|---|---|
| Where it runs | The end user's **browser** | Cloud **probe origins** (AWS Lambda / GCP Cloud Run / Azure App Service / Vercel Function) |
| Question answered | "How fast is **my** connection to this region?" | "How fast is the path from cloud datacenter X to region Y?" |
| Code | `src/fns/time.ts` (`ping`) | `src/fns/probe-server.ts` (`runProbe`) |
| Data flow | Live, in the browser | Probed every ~30 min by GitHub Actions, published to `latest.json`, read via `/api/health-matrix` |

The vantage points are physically different network origins. You cannot move a
user's browser into a datacenter, so **the two pages will never show the same
number for the same region, and that is expected** — they are answering
different questions. Comparing a "From You" value directly against a "Health"
cell is a category error; the UI labels each accordingly.

## What is shared vs. what is not

Shared, in `src/fns/measure-core.ts` (transport-free, side-effect-free pure
helpers, safe on both browser and server):

- **Cache-buster contract** — every measured request appends the
  `_cloudping=<timestamp>-<random>` query param (`CACHE_BUSTER_PARAM`,
  `withCacheBuster`) so no cache layer can serve a stale response and skew timing.
- **Implausible-sample floor** — `MIN_PLAUSIBLE_MS` and `filterPlausible`: a
  sub-RTT reading is a measurement artifact and is dropped before aggregation.
- **Statistics** — one definition of `percentile` (nearest-rank), `fastest`
  (min), `median`, and `summarize` (raw count + min + p50/p80/p95). Both vantage
  points compute the same statistic the same way.

Deliberately **not** shared:

- **Transport (the actual `fetch`)** — the browser must use `mode: 'no-cors'`
  (opaque responses, no headers, credentials omitted) to reach arbitrary region
  endpoints without CORS; the server uses a normal `GET` with a `user-agent`
  header and drains the body. These are irreconcilable, so each vantage point
  owns its own request code.
- **Per-vantage parameters** — warmup count, sample count, and timeout are
  configuration that legitimately differs:

  | Parameter | From You (browser) | Health (server) |
  |---|---|---|
  | warmup requests | 1 | 2 |
  | timed samples per round | 1 | 4 |
  | timeout | 8000 ms | 3000 ms (China 2000 ms) |
  | reported statistic | p50 / p80 / p95 | fastest (min); 24h P50 for the 24h view |

  A browser page-load budget (fast, cheap on battery/data) and a serverless
  probe round (thorough, bounded GB-seconds) want different values, so these
  stay with each caller rather than in the shared core.
- **Near cells re-measured serially (server only)** — every cell whose pooled
  latency is under a threshold (the matrix diagonal and other nearby regions) is
  re-measured on its own, lowest-value-first within a wall-time budget, after the
  concurrent fan-out drains; the reported value is `min(pool, serial)`. On a small
  (~0.28 vCPU) Lambda the fan-out intermittently exhausts the CPU quota, and the
  kernel parks the whole process for tens of ms; `performance.now()` elapsed
  absorbs that wait even on a warm, reused socket (confirmed by a spin probe that
  saw 4–5× wall/CPU inflation, and by per-sample instrumentation showing the slow
  samples reused their socket). That park adds a roughly fixed number of ms, so it
  barely dents far cells (150 ms+) but inflates near cells (true 3–30 ms) by 2–6×.
  Re-measuring them alone, on a quiet loop, restores the true value; the budget
  and the min-only update keep it cheap and monotonic (a serial reading can only
  lower a value, never raise it). Near cells are therefore measured differently
  from far cells — the diagonal and same-metro cells are already flagged "on-net"
  (non-comparable) in the `/health` UI. It is deliberately a POST-pass, not a
  pre-pass: a pre-pass was tried and reverted because the first outbound call also
  pays the invocation's startup JIT/network-path-init cost.


## Rationale

This split follows a cross-model design review (see the design discussion in
the PR history): keep the **methodology** consistent (one cache-buster, one set
of statistics, one artifact-floor concept) while keeping the **transport** and
the **tuning parameters** separate, because forcing identical transport or
identical aggregation across two physically different vantage points would add
complexity without making the numbers any more comparable.
