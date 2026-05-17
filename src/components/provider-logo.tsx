import Image from 'next/image'

export interface CloudProviderLogoProps {
  providerKey: string
  providerName: string
  className?: string
  width: number
}

export function CloudProviderLogo(props: CloudProviderLogoProps): JSX.Element {
  return (
    <div
      style={{
        width: props.width,
        height: props.width,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        width={props.width}
        height={props.width}
        style={{
          objectFit: 'contain',
          width: '100%',
          height: '100%',
        }}
        className={`inline ${props.className}`}
        src={`/images/provider/${props.providerKey}.svg`}
        title={props.providerName}
        alt={props.providerName}
      />
    </div>
  )
}
