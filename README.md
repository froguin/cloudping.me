# ⚡ Cloudping.me

Real-time browser-based latency tester for **15 cloud providers** — including AWS, Azure, GCP, Akamai Cloud, and Korean CSP providers.

🌐 **[cloudping.me](https://cloudping.me)**

![Cloudping.me screenshot](./public/images/large-screenshot.png)

## Features

- 🌍 15 cloud providers, 300+ regions worldwide
- 📊 Real-time latency with P50 / P80 / P95 percentiles
- 🔍 Filter by provider and geographic location
- 🌙 Dark / Light theme toggle
- 🇰🇷 Korean CSPs: NAVER Cloud, Kakao Cloud, KT Cloud, NHN Cloud, iwinv
- 📡 Shared [latency matrix](https://www.cloudping.me/health) from a Vercel Function probe (not from your browser)

## Cloud Providers

AWS · Azure · GCP · Alibaba Cloud · Tencent Cloud · IBM Cloud · Oracle Cloud · DigitalOcean · Akamai Cloud · Vultr · NAVER Cloud · Kakao Cloud · KT Cloud · NHN Cloud · iwinv

## Getting Started

```bash
npm install --omit=optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The latency tester only needs Next.js and React. Site URL, Google Analytics, and Vercel Analytics/Speed Insights are production-only and live in the Vercel project env — not in this repo.

| | App (OSS) | Production site |
|---|---|---|
| `next`, `react`, `react-dom` | required | required |
| `@vercel/analytics`, `@vercel/speed-insights` | omit | `optionalDependencies` + `NEXT_PUBLIC_SITE_TELEMETRY=1` |
| `NEXT_PUBLIC_SITE_URL` | unset | Vercel env (canonical / Open Graph) |
| `NEXT_PUBLIC_GA_ID` | unset | Vercel env |
| `NEXT_PUBLIC_HEALTH_JSON_URL` | GitHub `status` branch default | Vercel Blob snapshot URL (see Health board) |

See `.env.example`. Local clones do not send analytics.

## CLI

Ping the same regions from the terminal. Data comes from `src/data/datasource`, not from the website API.

```bash
go run ./cli
go run ./cli -geo Asia
go run ./cli -provider aws,linode   # Note: 'linode' is the provider key for Akamai Cloud
go run ./cli -c 6
go run ./cli -json
```

The `-provider` flag filters by the provider `key` defined in `src/data/datasource/providers.json`, rather than the display name. Where keys differ from display names:

| Display Name | Key (`-provider`) |
|---|---|
| Akamai Cloud | `linode` (Akamai acquired Linode) |
| NAVER Cloud | `ncp` |
| Kakao Cloud | `kakaocloud` |
| KT Cloud | `ktcloud` |
| NHN Cloud | `nhncloud` |

## Health board

`/` measures from the visitor's browser. `/health` is a To \ From latency heatmap (cloudping.co-style colors: &lt;100 / 100–180 / &gt;180ms). Rows are cloud regions. Columns are probe origins: a Vercel Function (`icn1`) and, when configured, AWS Lambda in `ap-northeast-2`. Each cell is the P50 of five HTTP GETs after a warmup, timed to response headers.

An EventBridge rule in `ap-northeast-2` fires every 15 minutes and `workflow_dispatch`es the Probe workflow. GitHub Actions then wakes the probe URLs and writes `latest.json`, a `history.json` 24h rolling buffer, and `vercel.json` (`{"git": {"deploymentEnabled": false}}`) on the `status` branch so the board can show a 24h P50. Writing `vercel.json` ensures pushes to the orphaned `status` branch do not trigger Vercel deployment records against Hobby tier's 100 deploys/day limit. The workflow cron is only a fallback.

### Snapshot delivery (Vercel Blob)

The production board reads `latest.json` from a public **Vercel Blob** store (the value of `NEXT_PUBLIC_HEALTH_JSON_URL`), which is served over Cloudflare-style CDN with zero egress cost and a `Cache-Control: max-age=60`. The `status` git branch stays a full mirror (`latest.json` + `history.json`) and doubles as a rollback backup — unset `NEXT_PUBLIC_HEALTH_JSON_URL` to fall back to the GitHub `raw` URL instantly.

The Probe workflow mirrors only `latest.json` to Blob (one write per run) using the `@vercel/blob` SDK with `addRandomSuffix:false` + `allowOverwrite:true` so the URL stays stable. To stay inside Blob's free tier (2,000 advanced operations/month), the mirror step is gated: even though the clock fires every 15 minutes, it uploads only when the existing blob's `Last-Modified` is older than ~28 minutes (`BLOB_MIN_INTERVAL_SEC`), giving ~1,440 writes/month. A manual `workflow_dispatch` with `force_blob=true` bypasses the gate for validation.

Set up: create a public store (`vercel blob create-store <name> --access public`), connect it to the project, then add the generated `BLOB_READ_WRITE_TOKEN` as a GitHub Actions secret and point `NEXT_PUBLIC_HEALTH_JSON_URL` at the store's public `latest.json` URL. If `BLOB_READ_WRITE_TOKEN` is absent the mirror step no-ops and the git `status` branch keeps serving.

Set `PROBE_SECRET` on Vercel, the Lambda, and GitHub Actions. During rotation, set the previous value as `PROBE_SECRET_PREV` on Vercel and Lambda so both tokens are accepted until the new value is live everywhere, then clear `PREV`. GitHub also needs `PROBE_URL` (Vercel `/api/probe`) and optional `PROBE_URL_AWS_ICN` (Lambda Function URL). The EventBridge clock Lambda needs `GITHUB_DISPATCH_TOKEN` (fine-grained PAT: this repo, Actions write).

## Based on

[webping.cloud](https://github.com/goenning/webping.cloud) by [@goenning](https://github.com/goenning)
