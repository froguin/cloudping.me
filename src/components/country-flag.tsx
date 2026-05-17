import { getCountryName } from '@app/fns/country'
import Image from 'next/image'

export interface CountryFlagProps {
  countryCode: string
  className?: string
  width: number
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
      <Image
        width={props.width}
        height={props.width}
        style={{
          objectFit: 'contain',
          width: '100%',
          height: '100%',
        }}
        className={`inline ${props.className}`}
        src={`/images/country/${props.countryCode.toLowerCase()}.svg`}
        title={countryName}
        alt={countryName}
      />
    </div>
  )
}
