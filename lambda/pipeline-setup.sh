#!/usr/bin/env bash
# One-time (idempotent) bootstrap for the AWS-native CI/CD pipeline that
# auto-deploys lambda/handler.ts to all 13 Lambda regions on push to main.
#
# Creates, in us-east-1 (cheapest CodeBuild region, single central build):
#   - S3 bucket for pipeline artifacts
#   - IAM role for CodeBuild (scoped to lambda:UpdateFunctionCode on the 13
#     cloudping-probe function ARNs only -- never UpdateFunctionConfiguration,
#     so PROBE_SECRET / env vars set outside CI are never touched)
#   - IAM role for CodePipeline
#   - CodeStar Connection to GitHub (created PENDING -- see note below)
#   - CodeBuild project (source: CODEPIPELINE, buildspec: lambda/buildspec.yml)
#   - CodePipeline (V2) with a Git push trigger filtered to
#     lambda/**, src/fns/**, src/data/** so frontend/GCP/Azure-only commits
#     never start a build.
#
# IMPORTANT -- manual step required after running this script:
#   CodeStar Connections cannot complete GitHub App authorization via the API.
#   This script prints a console URL; open it, click "Update pending
#   connection", and approve the GitHub App for froguin/cloudping.me. Until
#   you do this the pipeline's Source stage will fail.
#
# Safe to re-run: every step checks for the resource first.
set -euo pipefail

ACCOUNT_ID="090451331601"
REGION="us-east-1"
REPO_ID="froguin/cloudping.me"
BRANCH="main"

BUCKET="cloudping-pipeline-artifacts-${ACCOUNT_ID}"
CODEBUILD_ROLE="cloudping-codebuild-role"
CODEPIPELINE_ROLE="cloudping-codepipeline-role"
CONNECTION_NAME="cloudping-github"
PROJECT_NAME="cloudping-lambda-deploy"
PIPELINE_NAME="cloudping-lambda-pipeline"

LAMBDA_REGIONS="us-east-1 us-east-2 us-west-2 ca-central-1 eu-west-1 eu-central-1 ap-northeast-1 ap-northeast-2 ap-southeast-1 ap-southeast-2 sa-east-1 af-south-1 me-central-1"

echo "=== S3 artifact bucket ==="
if ! aws s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
  aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null
  aws s3api put-bucket-versioning --bucket "${BUCKET}" --versioning-configuration Status=Enabled >/dev/null
  aws s3api put-public-access-block --bucket "${BUCKET}" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
  aws s3api put-bucket-encryption --bucket "${BUCKET}" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
  echo "created ${BUCKET}"
else
  echo "exists ${BUCKET}"
fi

echo ""
echo "=== IAM role: ${CODEBUILD_ROLE} ==="
lambda_resources_json=$(printf '"arn:aws:lambda:%s:'"${ACCOUNT_ID}"':function:cloudping-probe",' ${LAMBDA_REGIONS} | sed 's/,$//')
codebuild_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/codebuild/${PROJECT_NAME}*"
    },
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "ArtifactsBucket",
      "Effect": "Allow",
      "Action": ["s3:GetBucketAcl", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "LambdaDeploy",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"],
      "Resource": [${lambda_resources_json}]
    }
  ]
}
JSON
)
if ! aws iam get-role --role-name "${CODEBUILD_ROLE}" >/dev/null 2>&1; then
  aws iam create-role --role-name "${CODEBUILD_ROLE}" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "created role ${CODEBUILD_ROLE}"
else
  echo "exists role ${CODEBUILD_ROLE}"
fi
aws iam put-role-policy --role-name "${CODEBUILD_ROLE}" --policy-name cloudping-codebuild-policy \
  --policy-document "${codebuild_policy}" >/dev/null
CODEBUILD_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE}"

echo ""
echo "=== IAM role: ${CODEPIPELINE_ROLE} ==="
if ! aws iam get-role --role-name "${CODEPIPELINE_ROLE}" >/dev/null 2>&1; then
  aws iam create-role --role-name "${CODEPIPELINE_ROLE}" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codepipeline.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "created role ${CODEPIPELINE_ROLE}"
else
  echo "exists role ${CODEPIPELINE_ROLE}"
fi
CODEPIPELINE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${CODEPIPELINE_ROLE}"

echo ""
echo "=== CodeStar Connection ==="
CONNECTION_ARN=$(aws codestar-connections list-connections --region "${REGION}" \
  --query "Connections[?ConnectionName=='${CONNECTION_NAME}'].ConnectionArn | [0]" --output text)
if [ "${CONNECTION_ARN}" = "None" ] || [ -z "${CONNECTION_ARN}" ]; then
  CONNECTION_ARN=$(aws codestar-connections create-connection --region "${REGION}" \
    --provider-type GitHub --connection-name "${CONNECTION_NAME}" --query ConnectionArn --output text)
  echo "created connection ${CONNECTION_ARN} (status: PENDING)"
else
  echo "exists connection ${CONNECTION_ARN}"
fi
CONN_STATUS=$(aws codestar-connections get-connection --region "${REGION}" --connection-arn "${CONNECTION_ARN}" --query 'Connection.ConnectionStatus' --output text)
echo "connection status: ${CONN_STATUS}"
if [ "${CONN_STATUS}" != "AVAILABLE" ]; then
  echo ">>> ACTION REQUIRED: open https://${REGION}.console.aws.amazon.com/codesuite/settings/connections?region=${REGION}"
  echo ">>> click '${CONNECTION_NAME}' -> 'Update pending connection' -> authorize the GitHub App for ${REPO_ID}"
fi

echo ""
echo "=== Now that we have the connection ARN, finish CodePipeline role policy ==="
codepipeline_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:GetBucketVersioning"],
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"]
    },
    {
      "Sid": "Connection",
      "Effect": "Allow",
      "Action": "codestar-connections:UseConnection",
      "Resource": "${CONNECTION_ARN}"
    },
    {
      "Sid": "Build",
      "Effect": "Allow",
      "Action": ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      "Resource": "arn:aws:codebuild:${REGION}:${ACCOUNT_ID}:project/${PROJECT_NAME}"
    }
  ]
}
JSON
)
aws iam put-role-policy --role-name "${CODEPIPELINE_ROLE}" --policy-name cloudping-codepipeline-policy \
  --policy-document "${codepipeline_policy}" >/dev/null
echo "policy attached"

echo ""
echo "=== CodeBuild project: ${PROJECT_NAME} ==="
if ! aws codebuild batch-get-projects --region "${REGION}" --names "${PROJECT_NAME}" \
  --query 'projects[0].name' --output text 2>/dev/null | grep -qx "${PROJECT_NAME}"; then
  aws codebuild create-project --region "${REGION}" \
    --name "${PROJECT_NAME}" \
    --source "type=CODEPIPELINE,buildspec=lambda/buildspec.yml" \
    --artifacts "type=CODEPIPELINE" \
    --environment "type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL" \
    --service-role "${CODEBUILD_ROLE_ARN}" >/dev/null
  echo "created project ${PROJECT_NAME}"
else
  aws codebuild update-project --region "${REGION}" \
    --name "${PROJECT_NAME}" \
    --source "type=CODEPIPELINE,buildspec=lambda/buildspec.yml" \
    --artifacts "type=CODEPIPELINE" \
    --environment "type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL" \
    --service-role "${CODEBUILD_ROLE_ARN}" >/dev/null
  echo "exists project ${PROJECT_NAME} (settings refreshed)"
fi

echo ""
echo "=== CodePipeline: ${PIPELINE_NAME} ==="
pipeline_json=$(cat <<JSON
{
  "pipeline": {
    "name": "${PIPELINE_NAME}",
    "roleArn": "${CODEPIPELINE_ROLE_ARN}",
    "artifactStore": { "type": "S3", "location": "${BUCKET}" },
    "pipelineType": "V2",
    "stages": [
      {
        "name": "Source",
        "actions": [
          {
            "name": "Source",
            "actionTypeId": { "category": "Source", "owner": "AWS", "provider": "CodeStarSourceConnection", "version": "1" },
            "configuration": {
              "ConnectionArn": "${CONNECTION_ARN}",
              "FullRepositoryId": "${REPO_ID}",
              "BranchName": "${BRANCH}"
            },
            "outputArtifacts": [{ "name": "SourceOutput" }]
          }
        ]
      },
      {
        "name": "Build",
        "actions": [
          {
            "name": "Build",
            "actionTypeId": { "category": "Build", "owner": "AWS", "provider": "CodeBuild", "version": "1" },
            "configuration": { "ProjectName": "${PROJECT_NAME}" },
            "inputArtifacts": [{ "name": "SourceOutput" }]
          }
        ]
      }
    ],
    "triggers": [
      {
        "providerType": "CodeStarSourceConnection",
        "gitConfiguration": {
          "sourceActionName": "Source",
          "push": [
            {
              "branches": { "includes": ["${BRANCH}"] },
              "filePaths": { "includes": ["lambda/**", "src/fns/**", "src/data/**"] }
            }
          ]
        }
      }
    ]
  }
}
JSON
)
if aws codepipeline get-pipeline --region "${REGION}" --name "${PIPELINE_NAME}" >/dev/null 2>&1; then
  echo "${pipeline_json}" | jq '{pipeline: (.pipeline + {version: 1})}' > /tmp/cloudping-pipeline-update.json 2>/dev/null || echo "${pipeline_json}" > /tmp/cloudping-pipeline-update.json
  aws codepipeline update-pipeline --region "${REGION}" --cli-input-json "file:///tmp/cloudping-pipeline-update.json" >/dev/null
  rm -f /tmp/cloudping-pipeline-update.json
  echo "exists pipeline ${PIPELINE_NAME} (definition refreshed)"
else
  echo "${pipeline_json}" > /tmp/cloudping-pipeline-create.json
  aws codepipeline create-pipeline --region "${REGION}" --cli-input-json "file:///tmp/cloudping-pipeline-create.json" >/dev/null
  rm -f /tmp/cloudping-pipeline-create.json
  echo "created pipeline ${PIPELINE_NAME}"
fi

echo ""
echo "=== Done ==="
echo "Connection ARN: ${CONNECTION_ARN}"
echo "Connection status: ${CONN_STATUS}"
if [ "${CONN_STATUS}" != "AVAILABLE" ]; then
  echo "Remember to authorize the GitHub App (see ACTION REQUIRED above) before pushing."
fi
