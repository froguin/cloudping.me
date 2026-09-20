# Probe latency accuracy

Measured on 2026-09-21 from the local macOS worktree, Node v26.9.0 and curl
8.7.1. These are local measurements and a controlled repro, not a deployed
Lambda A/B test. Production bundles target Node 24.

## What the probe measures

`timedGet` stops when `fetch` resolves response headers, **before** draining the
body. It measures HTTP response latency, including connection setup when needed,
target processing, and delays before JavaScript resumes. It is not raw TCP/ICMP
RTT. Curl's `time_starttransfer` is the closest baseline; `time_total` also includes
the body ([curl timing definitions](https://curl.se/docs/manpage.html)). The cache
buster is retained; it avoids cached responses but cannot remove server processing.

A live test against `https://dynamodb.ap-northeast-2.amazonaws.com/ping` used
32 sequential HTTP/1.1 curl requests in one process, 20 TCP connects after DNS
resolution, and 12 probe rounds with two warmups and four samples each:

| Measurement | Median (ms) |
| --- | ---: |
| TCP connection after DNS | 8.81 |
| Curl headers, excluding two warmups | 7.59 |
| Curl total, excluding two warmups | 7.73 |
| Existing probe's reported per-round median | 9.00 |
| High-resolution median of the same probe samples | 8.96 |
| High-resolution minimum of the same probe samples | 8.06 |

These are separate network batches, so TCP and HTTP numbers can cross as the path
varies. The first curl request took 41.46 ms (14.42 ms DNS, TCP complete at 22.40 ms,
TLS complete at 32.91 ms); connection reuse avoids that setup on subsequent requests.
The largest difference between `Date.now()` and `performance.now()` elapsed time
on the same measured request was 0.76 ms. Clock quantization cannot explain a
persistent 12 ms excess. Minimum selection reduced the local difference from
warmed curl total from 1.27 to 0.33 ms; it did not demonstrate a 12 ms correction.

**The reported production 12 ms gap was not reproduced here.** HTTP processing,
connection reuse, and origin scheduling are possible contributors; these data do
not establish their individual contributions on the production Lambda. Merely
increasing warmups does not establish or fix the cause.

## Reproducing origin scheduling noise

The harness runs the real `runProbe` with 24 test targets. A separate HTTP server
process delays headers by 20 ms. For the 23 background targets only, the client
adds 8 ms of synchronous work after each fetch, simulating origin callback/CPU
contention. Curl runs outside that event loop. Four rounds per configuration use
exactly 144 requests each. This tests the mechanism, not Lambda's actual CPU load.

Medians across the four rounds, in milliseconds:

| Pool concurrency | Original reported value | Minimum alone, same original samples | Changed `runProbe` | Round duration, before → after |
| --- | ---: | ---: | ---: | ---: |
| 8 | 67.00 | 58.33 | 21.46 | 1217.5 → 1495.5 |
| 24 | 193.50 | 188.70 | 21.22 | 1213.5 → 1307.5 |

Curl's warmed total median was 21.73 ms before and 21.20 ms after. The fixed
concurrency-8 runs ranged from 21.07 to 26.63 ms; unrelated local scheduling noise
can still affect the isolated pass. Total round durations also varied, so this
toy workload is not a production billing estimate.

Minimum alone leaves every sample inflated under sustained contention. Isolating
the self-target before starting the pool removes that source of inflation. The
Lambda wrapper already defaults to concurrency **8**, although `runProbe` defaults
to 24; both were tested. The reproduced mechanism supports origin contention as a
cause of the reported Seoul spikes, but does not prove every production spike has
that cause.

## Change and cost

- Report the fastest successful sample, rounded once to 0.01 ms. Keep four attempts,
  two warmups, and the requirement for at least three successful samples.
- Use the monotonic high-resolution `performance.now()` for elapsed request time.
  Keep wall-clock timestamps for snapshot dates and cache busting.
- Measure an exact `${provider}-${region}` match to the resolved origin ID first,
  then reuse that result in its original position. The remaining pool keeps its
  requested concurrency. Canonical AWS/GCP/Azure IDs match; custom IDs and Vercel's
  generic ID fall back to normal scheduling, without guessing geographic proximity.
- Update `/health` to say “Latest min”; 24h P50 remains the median of per-run values.
  Existing history can contain values from the earlier median-based probe.

No extra requests, memory allocation tier changes, or global concurrency reduction.
The tradeoff is loss of overlap for the self-target's six requests: about 120 ms
on a healthy 20 ms path, plus setup/processing overhead. A self-target that times
out on every request can add up to 18 seconds of serial timeout budget. Minimum
still includes unavoidable HTTP processing and can remain inflated if all samples
are delayed. It estimates the least congested HTTP response, not typical latency
or a guaranteed network RTT.

## Reproduce and validate

From the repo root after `npm ci`:

```sh
# Original source used for the measurements.
git show b2685403bf9956dd02008a35b58c9df3c425e993:src/fns/probe-server.ts > /tmp/cloudping-probe-before.ts
PROBE_SOURCE=/tmp/cloudping-probe-before.ts node scripts/measure-probe-latency.cjs live
PROBE_SOURCE=/tmp/cloudping-probe-before.ts node scripts/measure-probe-latency.cjs synthetic
node scripts/measure-probe-latency.cjs synthetic
node scripts/measure-probe-latency.cjs live
npm run build
npx tsc --noEmit
npm run lint
```

The harness transpiles the selected TypeScript source in memory, injects test
catalog data only for the synthetic run, and emits raw samples plus summaries.
Run benchmarks without a simultaneous build. Live mode makes 104 HTTP requests
and 20 TCP connections; synthetic mode only uses localhost.

Build and separate TypeScript checking passed. Focused checks also passed for
fractional minimum selection, body draining outside the clock, failed warmups,
three-success gating, timeout classification, origin matching, failed-self result
reuse, output order, request counts, and remaining pool concurrency. The changed
TypeScript files pass ESLint. Repository-wide `npm run lint` reports 37 existing
errors in unchanged files (formatting, CommonJS configuration, and accessibility).
The build also warns about the existing `/health` page-data size (~1.19 MB).
