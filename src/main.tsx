import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { startSyncTriggers } from './lib/syncWorker.ts'

// Auto-update service worker — keeps the offline app shell fresh.
registerSW({ immediate: true })

// §8 sync triggers: app load, `online` events, short interval.
startSyncTriggers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
