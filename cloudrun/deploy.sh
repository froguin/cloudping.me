#!/usr/bin/env bash
# Deploy the cloudping probe to one or more GCP Cloud Run regions.
#
# Parity with the AWS Lambda origins: same runProbe code, 300s timeout,
# min-instances 0, ~256MB-equivalent (512Mi / 0.5 vCPU is Cloud Run's floor for
# reliable cold starts). Each region self-labels via PROBE_ORIGIN_ID=gcp-<region>.
#
# Prereqs: gcloud auth, PROBE_SECRET exported, project set.
# Usage: PROBE_SECRET=xxx ./cloudrun/deploy.sh asia-northeast3 southamerica-east1
set -euo pipefail

SERVICE="cloudping-probe"
: "${PROBE_SECRET:?export PROBE_SECRET first}"
if [ "$#" -eq 0 ]; then echo "usage: PROBE_SECRET=xxx $0 <region> [region ...]" >&2; exit 1; fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "${build_dir}"' EXIT

echo "Bundling server with esbuild..."
npx --yes esbuild "${repo_root}/cloudrun/server.ts" \
  --bundle --platform=node --target=node20 --format=cjs \
  --alias:@app/data="${repo_root}/src/data" \
  --outfile="${build_dir}/server.js" >/dev/null
cp "${repo_root}/cloudrun/Dockerfile" "${build_dir}/Dockerfile"

for region in "$@"; do
  echo ""
  echo "=== ${region} ==="
  gcloud run deploy "${SERVICE}" \
    --source "${build_dir}" \
    --region "${region}" \
    --no-allow-unauthenticated \
    --cpu 0.5 --memory 512Mi --timeout 300 \
    --min-instances 0 --max-instances 1 \
    --set-env-vars "PROBE_SECRET=${PROBE_SECRET},PROBE_ORIGIN_ID=gcp-${region},PROBE_ORIGIN_LABEL=GCP Cloud Run (${region})" \
    --quiet
  url="$(gcloud run services describe "${SERVICE}" --region "${region}" --format='value(status.url)')"
  echo "Service URL: ${url}"
done
