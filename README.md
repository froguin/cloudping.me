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
| `NEXT_PUBLIC_HEALTH_JSON_URL` | GitHub `status` branch default | override snapshot URL |

See `.env.example`. Local clones do not send analytics.

## CLI

Ping the same regions from the terminal. Data comes from `src/data/datasource`, not from the website API.

```bash
go run ./cli
go run ./cli -geo Asia
go run ./cli -provider aws,linode
go run ./cli -c 6
go run ./cli -json
```

## Health board

`/` measures from the visitor's browser. `/health` is a To \\ From latency heatmap (cloudping.co-style colors: &lt;100 / 100–180 / &gt;180ms). Rows are cloud region ping URLs. Columns are probe origins — currently one Vercel Function region (Hobby is single-region, so this is not cloud-to-cloud).

GitHub Actions wakes `/api/probe` every 15 minutes and writes `latest.json` on the `status` branch.

Set `PROBE_SECRET` on Vercel and the same value plus `PROBE_URL` (e.g. `https://www.cloudping.me/api/probe`) as GitHub Actions secrets.

## Based on

[webping.cloud](https://github.com/goenning/webping.cloud) by [@goenning](https://github.com/goenning)
