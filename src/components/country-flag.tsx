import { getCountryName } from '@app/fns/country'

export interface CountryFlagProps {
  countryCode: string
  className?: string
  width: number
  loading?: 'lazy' | 'eager'
}

export function CountryFlag(props: CountryFlagProps): JSX.Element {
  const countryName = getCountryName(props.countryCode)
  return (
    <div
      style={{
        width: props.width,
        height: props.width,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        verticalAlign: 'middle',
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
        src={`/images/country/${props.countryCode.toLowerCase()}.svg`}
        title={countryName}
        alt={countryName}
        loading={props.loading || 'lazy'}
        decoding="async"
      />
    </div>
  )
}
