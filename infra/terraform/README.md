# Terraform — cloudping.me infrastructure

Imports the already-deployed cloudping.me infrastructure (AWS + GCP + Azure) and
the deploy-pipeline identities into Terraform state managed by **HCP Terraform**
(org `froguin`, project/workspace `cloudping`). This is an **import + management**
layer, not the deploy path — actual code deploys still run through
`.github/workflows/deploy-*.yml` and `*/deploy.sh`.

## What's managed (82 resources)

- **AWS (32)**: 13 `cloudping-probe` Lambdas (nodejs24.x), the `cloudping-probe-clock`
  Lambda (kept on nodejs20.x — a separate change owns any runtime bump), the
  EventBridge `rate(30 minutes)` rule + target + permission, 4 Function URLs,
  3 IAM roles + policies, and the GitHub Actions OIDC provider.
- **GCP (23)**: 6 Cloud Run probe services, Artifact Registry repo, the Workload
  Identity Federation pool/provider, and the deployer/invoker service accounts + IAM.
- **Azure (27)**: the `cloudping-probe` resource group, 11 F1 App Service plans + web
  apps (NODE|24-lts), and the Azure AD app + federated credential + role assignment.

## Execution model (local exec, HCP state)

The workspace runs with **`execution-mode = local`**: Terraform executes on your
machine using your local `aws` / `gcloud` / `az` CLI credentials, while **state
lives in HCP** (encrypted, locked, versioned). You never manage a state file
by hand.

## Secrets

Two secrets are consumed by the config: `probe_secret` and `github_dispatch_token`
(both `sensitive`). They are stored in **two** places, and must be rotated in both:

1. **`secrets.auto.tfvars`** (this directory, git-ignored) — the source of values
   for local runs. Terraform auto-loads `*.auto.tfvars`, so `plan`/`apply` need no
   `TF_VAR_*` exports and never read them back out of a deployed resource. Copy
   `secrets.auto.tfvars.example` and fill it in.
2. **HCP workspace variables** (sensitive) — kept for the future remote-execution
   path. HCP sensitive variables are write-only (values can't be read back), which
   is why local runs keep their own copy in `secrets.auto.tfvars`.

> The `.tf` sources contain **no** plaintext secrets — only `var.` references.

## Usage

```bash
cd infra/terraform
cp secrets.auto.tfvars.example secrets.auto.tfvars   # first time only; fill in values
terraform init
terraform plan     # should report: No changes
terraform apply
```

Make sure your CLIs are authenticated: `aws sts get-caller-identity`,
`gcloud config list`, `az account show`.

## Adding a new region

New regions are still **deployed** by the existing scripts/workflows, then
**imported** here:

1. Deploy the new origin the usual way (e.g. `PROBE_SECRET=… ./lambda/deploy.sh <region>`
   for AWS, or the GCP/Azure `deploy.sh`). That path already injects `PROBE_SECRET`.
2. Add the region to the relevant list in `variables.tf` (`aws_probe_regions` /
   `gcp_probe_regions` / `azure_probe_regions`).
3. Add a matching `resource` + `import {}` block for the new resource(s) in
   `aws.tf` / `gcp.tf` / `azure.tf`, using the real resource id.
4. `terraform plan` — expect only the new resource(s) as `to import`, everything
   else `No changes`. Then `terraform apply`.

The secret values do **not** need to be re-fetched from anywhere per region — they
come from `secrets.auto.tfvars` locally (and the HCP variables for remote runs).

## Rotating secrets

1. Rotate the upstream secret (regenerate `PROBE_SECRET`, or the GitHub token).
2. Update `secrets.auto.tfvars` **and** the HCP workspace variable.
3. `terraform apply` to push the new value to every origin.
