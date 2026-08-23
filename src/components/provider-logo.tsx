export interface CloudProviderLogoProps {
  providerKey: string
  providerName: string
  className?: string
  width: number
  loading?: 'lazy' | 'eager'
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
      <img
        width={props.width}
        height={props.width}
        style={{
          objectFit: 'contain',
          width: '100%',
          height: '100%',
          display: 'block',
        }}
        className={props.className}
        src={`/images/provider/${props.providerKey}.svg`}
        title={props.providerName}
        alt={props.providerName}
        loading={props.loading || 'lazy'}
        decoding="async"
      />
    </div>
  )
}
