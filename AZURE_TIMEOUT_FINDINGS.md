# Azure App Service Probe Timeout Investigation & Findings

## 1. Executive Summary

- **Hypothesis Verdict**: **CONFIRMED** — The far-target timeouts on Azure App Service origins are caused by **outbound SNAT port exhaustion**, **NOT** by genuine network latency exceeding the 3-second `DEFAULT_TIMEOUT_MS`.
- **Alternative Hypothesis (Tight 3s Timeout)**: **REFUTED** — Grounded in production data from identical geographic origins (Sydney AWS vs Sydney Azure), actual measured round trips to the failed "small provider" targets sit between 120ms and 320ms (nearly a 10× safety margin below 3,000ms).
- **Minimal Fix**: Capped outbound fan-out concurrency to **8** (matching AWS Lambda in `lambda/handler.ts`) for Azure App Service origins (`azure/server.ts` and `src/fns/probe-server.ts`), with `PROBE_CONCURRENCY` environment variable override support and structured round diagnostic logging.
- **Scope Isolation**: AWS Lambda, GCP Cloud Run, and Vercel remain completely unaffected (`WEBSITE_SITE_NAME` gating and Azure-entrypoint scoping). Probe timeouts, warmup counts, sample counts, and self-target logic remain untouched.

---

## 2. Production Data Analysis (Round `2026-09-21T10:15Z` / `10:47Z`)

In the live production status snapshot (`latest.json`):
- `azure-australiaeast`: **125 of 301 targets timed out** (41.5% failure rate).
- `azure-koreacentral`: **49 of 301 targets timed out** (16.3% failure rate).
- `azure-brazilsouth`: **31 of 301 targets timed out** (10.3% failure rate).
- `azure-eastus2`: **14 of 301 targets timed out**.
- In contrast, AWS and GCP origins running the same shared probe logic had virtually zero issues:
  - `aws-ap-southeast-2` (Sydney, Australia): **298 of 301 OK** (only 3 timeouts).
  - `aws-ap-northeast-2` (Seoul, Korea): **299 of 301 OK** (only 2 timeouts).
  - `gcp-europe-west1`: **298 of 301 OK**.

### Refuting the "Far Path Slower than 3s Timeout" Hypothesis

1. **Geographic Baseline Parity (`aws-ap-southeast-2` vs `azure-australiaeast`)**:
   Both origins operate out of Sydney, Australia, targeting the exact same 301 endpoints with the identical 3,000ms timeout:
   - Oracle (42 targets): From Sydney AWS, **0 timeouts**; latencies ranged 140ms–320ms.
   - Vultr (33 targets): From Sydney AWS, **0 timeouts**; latencies ranged 120ms–300ms.
   - Linode (25 targets): From Sydney AWS, **0 timeouts**; latencies ranged 150ms–280ms.
   - DigitalOcean (9 targets): From Sydney AWS, **0 timeouts**; latencies ranged 160ms–270ms.
   Every single "small provider" target responded in well under 350ms. None came anywhere close to 3,000ms.

2. **Azure Historical Ground Truth (`history.json`)**:
   In previous rounds where `azure-australiaeast` did not hit port exhaustion, recorded steady-state latencies to these identical targets were:
   - `azure-australiaeast` → `oracle/sa-saopaulo-1`: **298ms**
   - `azure-australiaeast` → `linode/us-east`: **205ms**

3. **Near Targets Timing Out on Seoul (`azure-koreacentral`)**:
   In `azure-koreacentral`, the 49 timeouts were **not** far or small providers. They were:
   - **All 37 AWS targets** (including Tokyo at ~30ms, Seoul local at ~5ms, Osaka at ~35ms, US West at ~135ms, US East at ~185ms).
   - **11 Azure targets**.
   High-capacity hyperscaler backbone paths with 5ms–185ms baseline latencies do not suddenly take >3,000ms unless connections are blocked at the transport layer.

### Confirming SNAT Exhaustion via Index & Temporal Clustering

When failures are analyzed by execution order (the 301 catalog jobs are processed sequentially by the worker pool in provider order):

- **`azure-australiaeast`**:
  - Targets `[0..181]` (AWS, Azure, GCP, Alibaba, Tencent, IBM): Almost all **succeeded** (only 6 sporadic fails).
  - Targets `[182..300]` (Oracle, DigitalOcean, Linode, Vultr, NCP, Kakao, KT, NHN, iWinv): **119 consecutive targets failed as an unbroken block**.
  - **Reason**: The apparent correlation with "small providers" was an artifact of catalog order (`src/data/datasource/providers.json` lists Oracle, DigitalOcean, Linode, and Vultr at the end). The origin did not fail because the targets were small providers; it failed because by target 182, the worker had opened connections to ~180 distinct endpoints within ~30 seconds, completely exhausting the Azure SNAT port pool.

- **`azure-koreacentral`**:
  - Targets `[0..48]` (All 37 AWS targets + 11 Azure targets): **48 of 49 consecutive targets timed out** right at the beginning of the round (except target 44, the pre-probed self-target).
  - Targets `[49..300]`: **All succeeded**.
  - **Reason**: SNAT ports were exhausted at probe start (likely lingering from prior connections within the 240-second cool-down). After ~40 seconds of dropped handshakes, the 4-minute cool-down expired, ports were freed, and the remaining 250+ targets completed without a single timeout.

- **`azure-brazilsouth`**:
  - Targets `[21..44]`: An unbroken block of **24 consecutive targets** timed out during an active exhaustion burst.

This contiguous block-failure pattern is the signature of transport-layer SNAT port starvation.

---

## 3. Underlying Technical Mechanism

1. **Azure App Service SNAT Port Allocation**:
   - Azure App Service instances (especially F1 Free tier, running on shared multi-tenant scale units) are assigned a default quota of **128 outbound SNAT ports**.
   - When an outbound TCP connection closes, the Azure Load Balancer retains that SNAT port in a **240-second (4-minute) TIME_WAIT/cool-down state** before it can be reclaimed for new flows.

2. **Node.js undici / fetch Connection Management**:
   - Node 24's global `fetch` creates an internal connection pool per unique remote origin.
   - For each target, `pingTarget` performs 2 warmup requests and 4 timed samples. HTTP keep-alive successfully reuses the single TCP connection across all 6 requests for that specific host.
   - However, when a target finishes, undici keeps the socket open in the idle pool for its default `keepAliveTimeout` (~4,000ms).
   - At `concurrency = 24`, 24 workers fan out rapidly across 301 distinct hostnames. In just 4 seconds, 24 workers can cycle through dozens of different hosts. With 100+ sockets simultaneously open or transitioning through TCP FIN/TIME_WAIT, the 128 SNAT port allocation is instantly depleted.

3. **Silent SYN Dropping & Abort Timeout**:
   - Once all SNAT ports are consumed, the Azure Load Balancer silently drops outbound TCP SYN packets for any new destination.
   - The client TCP stack retransmits SYNs (at 1s, 3s).
   - In `timedGet`, the `AbortController` fires at `DEFAULT_TIMEOUT_MS = 3000ms`.
   - The resulting `AbortError` is classified as `'timeout'`, causing 6 successive 3s timeouts (18s wasted per target).

---

## 4. Why Alternative Proposals Were Rejected

- **Increasing Timeout for Azure**:
  - **Rejected**: Healthy paths from Australia take at most ~300ms (10× margin). Increasing timeout to 5s would not fix dropped SYNs; it would increase the wasted stall time per target from 18s to 30s (exceeding round timeouts) and hold exhausted sockets open even longer. It would also break `/health` parity across clouds.
- **Disabling Keep-Alive (`Connection: close`)**:
  - **Rejected**: Sockets are already isolated per host. Forcing `Connection: close` on every request would destroy connection reuse between the 2 warmups and 4 samples, generating 1,806 TCP/TLS handshakes per round and drastically increasing socket churn and measurement jitter.

---

## 5. Implementation & Parity Details

1. **`azure/server.ts`**:
   - Replaced hardcoded `runProbe(24)` with `runProbe(concurrency)`, where `concurrency` defaults to **8** (reading `process.env.PROBE_CONCURRENCY` if set).
   - Added round diagnostic logging (`probe`, `concurrency`, `durationMs`, `cells`, `failed`, `failRate`) matching `lambda/handler.ts`.
   - Fixed prettier formatting on `appAuth`.

2. **`src/fns/probe-server.ts`**:
   - Set `DEFAULT_CONCURRENCY = process.env.WEBSITE_SITE_NAME ? 8 : 24`.
   - Guarantees that any execution within Azure App Service environment defaults to concurrency 8 even if called without explicit parameters.
   - Preserves `concurrency = 24` for Cloud Run, Vercel, and benchmarks.

3. **Performance & Budget Impact**:
   - **Concurrency 8** limits peak concurrent in-flight sockets to 8. Over a 4-second window, 8 workers touch at most ~40 unique endpoints, staying safely below the 128 SNAT port ceiling.
   - **Round Duration**: Round duration remains bounded at ~80s–130s globally (validated by AWS Lambda running concurrency 8 in Australia at 128s), well within GitHub Actions' 270s invoke timeout and App Service's 300s limit.
   - **F1 Daily CPU Budget**: Network I/O wait does not consume compute quota. At ~10–15 CPU-seconds per round, 96 rounds/day consumes ~16–24 CPU-minutes/day, comfortably within the 60 CPU-minute F1 daily allowance.

---

## 6. Verification

- `npm run build`: Successful Next.js production build.
- `npx tsc --noEmit`: Clean TypeScript compilation with 0 errors.
- `npx eslint azure/server.ts src/fns/probe-server.ts`: Passed with 0 errors and 0 warnings.
- `node scripts/measure-probe-latency.cjs synthetic`: Successfully passed synthetic probe benchmark.
