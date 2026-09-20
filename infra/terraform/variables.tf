variable "aws_account_id" {
  type        = string
  description = "AWS Account ID"
  default     = "090451331601"
}

variable "aws_default_region" {
  type        = string
  description = "Default AWS region for provider and singletons (clock lambda, eventbridge)"
  default     = "ap-northeast-2"
}

variable "aws_probe_regions" {
  type        = list(string)
  description = "List of AWS regions where cloudping-probe Lambda is deployed"
  default = [
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "eu-west-1",
    "eu-central-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-south-1",
    "sa-east-1",
    "af-south-1",
    "me-central-1"
  ]
}

variable "gcp_project_id" {
  type        = string
  description = "GCP Project ID"
  default     = "froguin3"
}

variable "gcp_default_region" {
  type        = string
  description = "Default GCP region"
  default     = "asia-northeast1"
}

variable "gcp_probe_regions" {
  type        = list(string)
  description = "List of GCP regions where cloudping-probe Cloud Run is deployed"
  default = [
    "asia-northeast1",
    "asia-northeast3",
    "asia-south1",
    "europe-west1",
    "southamerica-east1",
    "us-west1"
  ]
}

variable "azure_subscription_id" {
  type        = string
  description = "Azure Subscription ID"
  default     = "b399bb18-0873-460b-a8bd-8b51f8a75ada"
}

variable "azure_probe_regions" {
  type        = list(string)
  description = "List of Azure regions where cloudping-probe App Service is deployed"
  default = [
    "australiaeast",
    "southafricanorth",
    "eastus2",
    "westeurope",
    "koreacentral",
    "brazilsouth",
    "canadacentral"
  ]
}

variable "probe_secret" {
  type        = string
  description = "Bearer secret for cloudping probes (set via HCP workspace variable, sensitive)"
  sensitive   = true
}

variable "github_dispatch_token" {
  type        = string
  description = "GitHub token the clock Lambda uses to workflow_dispatch probe.yml (set via HCP workspace variable, sensitive)"
  sensitive   = true
}
