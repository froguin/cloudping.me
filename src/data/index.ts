import providers from './datasource/providers.json'
import aws from './datasource/regions/aws.json'
import azure from './datasource/regions/azure.json'
import gcp from './datasource/regions/gcp.json'
import alibaba from './datasource/regions/alibaba.json'
import tencent from './datasource/regions/tencent.json'
import ibm from './datasource/regions/ibm.json'
import oracle from './datasource/regions/oracle.json'
import digitalocean from './datasource/regions/digitalocean.json'
import vultr from './datasource/regions/vultr.json'
import hetzner from './datasource/regions/hetzner.json'
import ovh from './datasource/regions/ovh.json'
import scaleway from './datasource/regions/scaleway.json'
import ncp from './datasource/regions/ncp.json'
import kakaocloud from './datasource/regions/kakaocloud.json'
import ktcloud from './datasource/regions/ktcloud.json'
import nhncloud from './datasource/regions/nhncloud.json'
import linode from './datasource/regions/linode.json'

export interface CloudProvider {
  key: string
  display_name: string
  short_name?: string
}

export interface CloudRegion {
  key: string
  display_name: string
  country: string
  location: string
  geo: string
  ping_url: string
  disabled?: boolean
  disabled_reason?: string
}

const regionsMap: Record<string, CloudRegion[]> = {
  aws,
  azure,
  gcp,
  alibaba,
  tencent,
  ibm,
  oracle,
  digitalocean,
  vultr,
  hetzner,
  ovh,
  scaleway,
  ncp,
  kakaocloud,
  ktcloud,
  nhncloud,
  linode,
}

export function getAllProviders(): CloudProvider[] {
  return providers
}

export function getAllCloudRegions(): Record<string, CloudRegion[]> {
  const result: Record<string, CloudRegion[]> = {}
  for (const provider of providers) {
    if (regionsMap[provider.key]) {
      result[provider.key] = regionsMap[provider.key].filter((region) => !region.disabled)
    }
  }
  return result
}
