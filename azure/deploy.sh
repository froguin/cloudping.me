#!/usr/bin/env bash
# Deploy the cloudping probe to Azure App Service (F1 Free tier) in one region.
#
# Parity with the AWS Lambda / GCP Cloud Run origins: same runProbe code, Node 24
# runtime, app-level PROBE_SECRET auth. F1 is a genuinely free (no-cost) tier:
# 60 CPU-minutes/day, 1 GB RAM, shared compute, no custom autoscale. Actual
# production CPU Time must be monitored per app; recent probe origins use roughly
# 5-7 CPU-min/day despite much longer wall-clock network waits.
#
# One F1 App Service Plan is created per region (F1 plans are region-scoped and
# each hosts a single always-free app here).
#
# Prereqs: az login (MFA), PROBE_SECRET exported.
# Usage: PROBE_SECRET=xxx ./azure/deploy.sh australiacentral [southafricanorth ...]
set -euo pipefail

: "${PROBE_SECRET:?export PROBE_SECRET first}"
if [ "$#" -eq 0 ]; then echo "usage: PROBE_SECRET=xxx $0 <region> [region ...]" >&2; exit 1; fi

RG="${RG:-cloudping-probe}"
APP_PREFIX="${APP_PREFIX:-cloudping-probe}"
RUNTIME="NODE:24-lts"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "${build_dir}"' EXIT

echo "Bundling server with esbuild..."
npx --yes esbuild "${repo_root}/azure/server.ts" \
  --bundle --platform=node --target=node24 --format=cjs \
  --alias:@app/data="${repo_root}/src/data" \
  --outfile="${build_dir}/server.js" >/dev/null

# App Service (Oryx) runs `npm start`; provide a minimal package.json so it does.
cat > "${build_dir}/package.json" <<'JSON'
{ "name": "cloudping-probe", "version": "1.0.0", "private": true,
  "scripts": { "start": "node server.js" }, "engines": { "node": ">=24" } }
JSON

( cd "${build_dir}" && zip -qr app.zip server.js package.json )
zip_path="${build_dir}/app.zip"
echo "Bundle: $(du -h "${zip_path}" | cut -f1)"

# Resource group (idempotent; use the region of the first arg as the RG home).
if ! az group show -n "${RG}" >/dev/null 2>&1; then
  az group create -n "${RG}" -l "$1" -o none
  echo "Created resource group ${RG}"
fi

for region in "$@"; do
  plan="${APP_PREFIX}-plan-${region}"
  app="${APP_PREFIX}-${region}"
  echo ""
  echo "=== ${region} ==="

  # F1 plan (Linux). --sku F1 --is-linux; one per region.
  if ! az appservice plan show -g "${RG}" -n "${plan}" >/dev/null 2>&1; then
    az appservice plan create -g "${RG}" -n "${plan}" -l "${region}" \
      --sku F1 --is-linux -o none
    echo "Created F1 plan ${plan}"
  fi

  if ! az webapp show -g "${RG}" -n "${app}" >/dev/null 2>&1; then
    az webapp create -g "${RG}" -p "${plan}" -n "${app}" --runtime "${RUNTIME}" -o none
    echo "Created web app ${app}"
  fi

  # App settings: secret + explicit origin id/label so the column self-labels.
  az webapp config appsettings set -g "${RG}" -n "${app}" --settings \
    "PROBE_SECRET=${PROBE_SECRET}" \
    "PROBE_ORIGIN_ID=azure-${region}" \
    "PROBE_ORIGIN_LABEL=Azure App Service (${region})" \
    "SCM_DO_BUILD_DURING_DEPLOYMENT=false" \
    "WEBSITES_PORT=8080" -o none

  # Ensure the app listens on the port App Service probes (Oryx sets PORT).
  az webapp config set -g "${RG}" -n "${app}" --startup-file "node server.js" -o none

  echo "Deploying zip..."
  az webapp deploy -g "${RG}" -n "${app}" --src-path "${zip_path}" --type zip -o none

  url="https://$(az webapp show -g "${RG}" -n "${app}" --query defaultHostName -o tsv)"
  echo "App URL: ${url}"
done

echo ""
echo "Add these URLs to the GitHub Actions AZURE_PROBE_URLS variable (space-separated)."
