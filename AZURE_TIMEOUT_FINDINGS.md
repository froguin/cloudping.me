# Azure App Service Probe Timeout Investigation & Findings

## 1. Executive Summary

- **Diagnosis Verdict**: **UNCONFIRMED HYPOTHESIS & MITIGATION TRIAL** — Outbound transport/socket resource contention (such as Azure App Service SNAT port exhaustion or socket allocation limits on F1 Free instances) is a plausible leading hypothesis for the observed block timeouts, but cannot be confirmed without Azure platform-level diagnostics or packet captures.
- **Geographic Distance vs. Transport Contention**: Grounded in saved production data, pure geographic path length exceeding the 3-second `DEFAULT_TIMEOUT_MS` is weakened as a sole explanation by contiguous block-failure patterns, successful historical measurements over the same Azure paths, and AWS Sydney baseline results. However, 3-second timeout effects under real-world network jitter, cold DNS/TLS setup, and packet loss are not refuted.
- **Minimal Azure-Only Implementation**: Outbound probe fan-out concurrency in `azure/server.ts` is lowered from hardcoded 24 to default **8** (matching AWS Lambda in `lambda/handler.ts`), with safe fallback for `process.env.PROBE_CONCURRENCY` to allow A/B testing without redeployment, plus structured round diagnostic logging.
- **Scope & Deployment Boundary**: The shared probe engine (`src/fns/probe-server.ts`) is left untouched to prevent triggering CI deployment workflows for AWS Lambda and GCP Cloud Run. All changes are strictly confined to `azure/server.ts`. Probe timeouts, sample counts, warmups, and measurement logic remain identical to preserve parity across clouds.
- **Operational Risk (270s Caller Timeout)**: Lowering concurrency reduces concurrent request bursts, but worker count is not a retained socket ceiling. If underlying failures persist, eight workers iterating through failed targets could increase round duration and risk hitting GitHub Actions' 270-second invoke timeout (`curl --max-time 270`). This change is therefore treated as an operational experiment rather than an asserted guarantee.

---

## 2. Production Data Analysis (Snapshot `2026-09-21T10:45:37.155Z`)

Saved status data from `origin/status` (commit `69c6dda`, `latest.json`) records the following outcomes:

| Origin | Total Targets | OK | Timeouts | Other Errors | Round Duration (`durationMs`) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `azure-australiaeast` | 301 | 176 | 125 | 0 | 128,077 ms (~128s) |
| `azure-koreacentral` | 301 | 252 | 49 | 0 | 60,486 ms (~60s) |
| `azure-brazilsouth` | 301 | 269 | 31 | 1 (`network`) | 69,173 ms (~69s) |
| `azure-eastus2` | 301 | 287 | 14 | 0 | 46,600 ms (~47s) |
| `azure-canadacentral` | 301 | 293 | 8 | 0 | 39,842 ms (~40s) |
| `aws-ap-southeast-2` (Sydney) | 301 | 298 | 3 | 0 | 128,825 ms (~129s) |
| `aws-ap-northeast-2` (Seoul) | 301 | 299 | 2 | 0 | 84,140 ms (~84s) |
| `gcp-europe-west1` | 301 | 298 | 2 | 1 (`network`) | 40,676 ms (~41s) |

### Observations vs. Inferences

1. **AWS Sydney Baseline (`aws-ap-southeast-2`)**:
   Probing the identical 301 targets with the same 3,000ms timeout yielded 298 successes. Actual successful measured latency ranges from Sydney AWS:
   - **Oracle** (42 targets): 42 OK, 0 timeouts, **5–470 ms**
   - **Vultr** (33 targets): 33 OK, 0 timeouts, **108–609 ms**
   - **Linode** (25 targets): 25 OK, 0 timeouts, **3–404 ms**
   - **DigitalOcean** (9 targets): 9 OK, 0 timeouts, **141–372 ms**

   *Inference*: These numbers show that small-provider targets are responsive from Sydney when network paths are clear. However, AWS and Azure maintain separate routing, transoceanic transit, and network virtualization layers; AWS performance does not prove Azure network conditions are identical.

2. **Azure Historical Ground Truth (`history.json`)**:
   In historical rounds recorded in `history.json`, `azure-australiaeast` achieved successful samples to targets that failed in the 10:15Z/10:47Z rounds:
   - `azure-australiaeast` → `oracle/sa-saopaulo-1`: historical points around **298 ms**
   - `azure-australiaeast` → `linode/us-east`: historical points around **205 ms**

   *Inference*: These historical measurements demonstrate that high-latency physical distance alone does not inherently exceed 3,000ms on these Azure paths. However, historical minimums reflect successful steady-state transfers and cannot bound cold DNS resolution, TCP/TLS handshake latency, retransmission delays under packet loss, or host event-loop stalls.

3. **Execution Index & Temporal Block Failures**:
   Jobs in `runProbe` are dispatched by `mapPool` in sequential catalog order (`src/data/datasource/providers.json`):
   - **`azure-australiaeast`**: Targets `0..181` had 6 scattered failures (`aws-me-south-1`, `aws-eusc-de-east-1`, `tencent-sa-saopaulo`, `ibm-mil01`, `ibm-eu-es`, `ibm-br-sao`). Then, from index **182 through 300** (119 consecutive targets: Oracle, DigitalOcean, Linode, Vultr, NCP, Kakao, KT, NHN, iWinv), every target timed out in an unbroken block.
   - **`azure-koreacentral`**: Targets `0..43` and `45..48` (48 targets across AWS and Azure) failed consecutively at probe start. Index 44 (`azure-koreacentral`, measured at 6 ms in this snapshot under earlier serial self-probe logic) succeeded. Later in the round, index 170 (`ibm-mil01`) also failed.
   - **`azure-brazilsouth`**: Targets `21..44` formed an unbroken block of 24 failures (`aws-cn-north-1` through `azure-koreacentral`), plus smaller clusters at 123–124, 126–128, 130, 170, and 300.

   *Inference*: Contiguous block failures align strongly with worker pool scheduling order rather than target geography. In `azure-australiaeast`, the trailing block coincided with the point where the worker pool had visited ~180 distinct remote endpoints.

---

## 3. Technical Evaluation: SNAT Hypothesis & Socket Management

### The SNAT Port Exhaustion Hypothesis
- According to [Microsoft App Service Outbound Connection Guidance](https://learn.microsoft.com/en-us/azure/app-service/troubleshoot-intermittent-outbound-connection-errors), App Service instances share infrastructure load balancers and have default preallocated quotas (typically ~128 outbound SNAT ports per instance on basic/free plans).
- When connections close, the load balancer typically retains the port mapping in a 240-second (4-minute) TIME_WAIT/cool-down state before reclamation.
- If outbound requests rapidly deplete SNAT capacity, subsequent TCP SYN packets are dropped, stalling handshakes until `DEFAULT_TIMEOUT_MS` (3,000ms) triggers an `AbortError`.

### Why SNAT Remains Unconfirmed
- Microsoft documentation notes that SNAT ports can be shared across flows directed to *different* destination IP/port tuples, while also enforcing sandbox-level cross-VM TCP connection limits.
- The repository snapshot contains HTTP probe outcomes, not OS-level TCP socket metrics or Azure portal diagnostic data ("SNAT Port Exhaustion" detector).
- The normal probe schedule runs on a 15-minute cadence (well beyond a 4-minute cooldown), so initial-target failures on `azure-koreacentral` cannot be attributed to a prior scheduled round without evidence of overlapping manual invocations or independent traffic.
- Therefore, SNAT port exhaustion is a plausible leading suspect, but remains an **unconfirmed hypothesis**.

### Worker Concurrency vs. Retained Sockets
- Capping `mapPool` concurrency at 8 limits the number of actively executing target tasks in JavaScript.
- **It does NOT establish a hard socket ceiling**:
  - Global `fetch` (backed by `undici` in Node 24) maintains connection pools with keep-alive idle timers (~4 seconds) across visited origins.
  - Sockets to earlier targets remain established in the pool while workers move to subsequent targets.
  - Fast requests (e.g. 10–20ms) can still open and retain dozens of open sockets across distinct hosts within the idle window.
  - Multiple concurrent incoming requests to the App Service instance spin up independent worker pools.
- Consequently, lowering concurrency to 8 is a burst-reduction heuristic and scheduling throttle, not a mathematically guaranteed socket cap.

---

## 4. Round Duration & Caller Budget Analysis (270s Timeout Risk)

A critical operational constraint is the GitHub Actions workflow invoke step (`.github/workflows/probe.yml:191`):

```bash
curl -fsS --max-time 270 -X POST "${url}" -H "Authorization: Bearer ${PROBE_SECRET}"
```

The caller imposes a **270-second (4.5-minute) hard timeout**.

### The Concurrency / Timeout Tradeoff
- Under `concurrency = 24`, failed targets run in parallel across 24 workers. When `azure-australiaeast` suffered 125 timeouts, 24 workers processed the failing block in approximately 5–6 waves, finishing the overall round at **128s**.
- Under `concurrency = 8`:
  - **Healthy Reference Baseline**: AWS Sydney's ~128s round at concurrency 8 serves as a reference observation for a healthy run, but this is an unvalidated expectation for Azure App Service F1 instances; successful duration is not guaranteed to fall within ~80–130s.
  - **Caller Timeout Risk**: Each target runs 2 warmup requests and 4 timed samples. If a persistent transport failure causes all 6 attempts on a failing target to consume their full 3-second timeout (an 18-second stall per target), 8 workers processing the 119 trailing targets would require at least 15 serial waves (119 / 8 ≈ 15).
  - 15 waves × 18s stall per target = **270 seconds for the failed block alone**, even before accounting for the time spent on the preceding 182 targets!
  - Under that persistent-failure scenario, concurrency 8 guarantees that the round will exceed 270 seconds, causing `curl --max-time 270` to abort and turning a partial snapshot into a complete invocation failure. (Note: A target marked `timeout` in the snapshot indicates fewer than 3 successful samples; it does not prove all 6 requests fully timed out, but the worst-case scenario represents a severe operational risk.)

Because live before/after Azure measurements under failed conditions are not yet available, concurrency 8 must be treated as a **tunable experiment**, not a proven fix.

---

## 5. Minimal Azure-Only Implementation

### 1. Scope Isolation (`azure/server.ts`)
To prevent triggering unintended redeployments of AWS Lambda (`deploy-aws.yml`) and GCP Cloud Run (`deploy-gcp.yml`), no files under `src/fns/**` were modified:
- `src/fns/probe-server.ts` retains its standard signature and default (`concurrency = 24`).
- All concurrency logic is encapsulated in `azure/server.ts`.

### 2. Implementation in `azure/server.ts`
- Safely parses `process.env.PROBE_CONCURRENCY`:
  ```ts
  const parsed = Number(process.env.PROBE_CONCURRENCY)
  const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 8
  const snapshot = await runProbe(concurrency)
  ```
  - Unset, empty, whitespace, non-numeric, `NaN`, negative numbers, `0`, and `< 1` values safely fall back to `8`.
  - Non-integer values are floored (`1.9` → `1`).
  - Operators can adjust concurrency (e.g. `12`, `16`, or back to `24`) via the App Service app settings without redeploying code.
- Structured diagnostic logging:
  Emits a JSON log to `console.log` on completion reporting `probe`, `concurrency`, `durationMs`, `cells`, `failed`, and `failRate`. This provides visibility into round duration and failure rates directly in Azure App Service log streams (`az webapp log tail`).

### 3. Preserved Parity
- No changes to probe timeouts (`DEFAULT_TIMEOUT_MS = 3000`, `CHINA_TIMEOUT_MS = 2000`).
- No changes to sample count (4) or warmup count (2).
- No changes to AWS Lambda, GCP Cloud Run, or Vercel entrypoints.

---

## 6. Verification

- `npm run build`: Successful Next.js production build.
- `npx tsc --noEmit`: Typecheck clean with 0 errors.
- `npx eslint azure/server.ts`: Clean with 0 errors and 0 warnings.
- `node scripts/measure-probe-latency.cjs synthetic`: Synthetic benchmark passed (concurrency 8 and 24 validated).
- `git diff origin/main -- src/fns/probe-server.ts`: Verified empty diff and identical blob hash `1af742b63fd190e94f28a2b552a7f966e2ddb0cd` against current `origin/main` (deploy workflows for AWS and GCP will not trigger).
