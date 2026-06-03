import { useState } from 'react'
import { PhoneFrame } from './components/PhoneFrame'
import { useParcels } from './hooks/useParcels'
import type { CompletedPod } from './lib/pod'
import type { Parcel } from './lib/types'
import { CaptureScreen } from './screens/CaptureScreen'
import { ResultScreen } from './screens/ResultScreen'
import { StopsScreen } from './screens/StopsScreen'

/** Simple screen state machine — a PoC doesn't need a router. */
type View =
  | { name: 'stops' }
  | { name: 'capture'; parcel: Parcel; scannedValue: string }
  | { name: 'done'; result: CompletedPod; previewUrl: string }

export default function App() {
  const { parcels, error, reload } = useParcels()
  const [view, setView] = useState<View>({ name: 'stops' })

  return (
    <PhoneFrame>
      {view.name === 'stops' && (
        <StopsScreen
          parcels={parcels}
          error={error}
          onSelect={(parcel, scannedValue) =>
            setView({ name: 'capture', parcel, scannedValue: scannedValue ?? parcel.tracking_number })
          }
        />
      )}

      {view.name === 'capture' && (
        <CaptureScreen
          parcel={view.parcel}
          trackingScanned={view.scannedValue}
          stopIndex={(parcels?.findIndex((p) => p.id === view.parcel.id) ?? 0) + 1}
          stopCount={parcels?.length ?? 0}
          onBack={() => setView({ name: 'stops' })}
          onComplete={(result, previewUrl) => {
            void reload() // refresh stop statuses behind the confirmation
            setView({ name: 'done', result, previewUrl })
          }}
        />
      )}

      {view.name === 'done' && (
        <ResultScreen
          result={view.result}
          previewUrl={view.previewUrl}
          onReset={() => setView({ name: 'stops' })}
        />
      )}
    </PhoneFrame>
  )
}
