import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { startSyncTriggers } from './lib/syncWorker.ts'
import { DispatcherScreen } from './screens/DispatcherScreen.tsx'

// Auto-update service worker — keeps the offline app shell fresh.
registerSW({ immediate: true })

// §8 sync triggers: app load, `online` events, short interval.
startSyncTriggers()

/** Two top-level views, one hash route: #/dispatch = dispatcher, else driver. */
function Root() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return hash === '#/dispatch' ? <DispatcherScreen /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
