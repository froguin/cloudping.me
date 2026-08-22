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
import ncp from './datasource/regions/ncp.json'
import kakaocloud from './datasource/regions/kakaocloud.json'
import ktcloud from './datasource/regions/ktcloud.json'
import nhncloud from './datasource/regions/nhncloud.json'
import iwinv from './datasource/regions/iwinv.json'
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
  ncp,
  kakaocloud,
  ktcloud,
  nhncloud,
  iwinv,
  linode,
}

export function getAllProviders(): CloudProvider[] {
  return providers
}

export function getAllCloudRegions(): Record<string, CloudRegion[]> {
  const result: Record<string, CloudRegion[]> = {}
  for (const provider of providers) {
    if (regionsMap[provider.key]) {
      result[provider.key] = regionsMap[provider.key]
    }
  }
  return result
}
