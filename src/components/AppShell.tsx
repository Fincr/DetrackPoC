import type { ReactNode } from 'react'
import type { Driver } from '../lib/types'
import { DriverSwitcher } from './DriverSwitcher'
import { SyncBadge } from './SyncBadge'

/** Responsive web-app shell — a real product UI, not a device mockup.
 *  Laptop: a persistent navy sidebar (brand · driver · sync · dispatcher)
 *  beside a content area that fills the page.
 *  Mobile/tablet: the sidebar collapses to a slim navy top bar and the
 *  content runs edge-to-edge like an installed app.
 *  The Driver slot is a live switcher (PoC stand-in for auth) — it picks whose
 *  run the app shows and who PODs are stamped to. */
export function AppShell({
  children,
  drivers,
  selectedDriverId,
  onSelectDriver,
}: {
  children: ReactNode
  drivers: Driver[] | null
  selectedDriverId: string
  onSelectDriver: (id: string) => void
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      {/* Desktop sidebar — persistent chrome on every screen */}
      <aside className="sticky top-0 hidden h-dvh flex-col bg-navy px-5 py-6 text-white lg:flex">
        <Brand large />

        <div className="mt-8">
          <SidebarLabel>Driver</SidebarLabel>
          <div className="mt-2">
            <DriverSwitcher drivers={drivers} selectedId={selectedDriverId} onSelect={onSelectDriver} />
          </div>
        </div>

        <div className="mt-8">
          <SidebarLabel>Sync status</SidebarLabel>
          <div className="mt-2">
            <SyncBadge />
          </div>
        </div>

        <a
          href="#/allocate"
          className="mt-auto flex items-center justify-between rounded-xl border border-white/[0.12] px-3.5 py-3 text-[13px] font-semibold text-[#cdd7ee] transition hover:bg-white/5"
        >
          Dispatcher view
          <span aria-hidden>→</span>
        </a>
      </aside>

      {/* Mobile/tablet top bar — brand + sync on top, driver switcher below */}
      <header className="gold-underline sticky top-0 z-30 bg-navy text-white lg:hidden">
        <div className="flex items-center justify-between gap-3 px-[18px] pb-2 pt-[max(10px,env(safe-area-inset-top))]">
          <Brand />
          <SyncBadge />
        </div>
        <div className="px-[18px] pb-2.5">
          <DriverSwitcher drivers={drivers} selectedId={selectedDriverId} onSelect={onSelectDriver} compact />
        </div>
      </header>

      {/* Content area — fills the page beside the sidebar */}
      <main className="min-w-0">{children}</main>
    </div>
  )
}

function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 leading-none">
      <span className={`font-serif tracking-[0.3px] text-white ${large ? 'text-[17px]' : 'text-[15px]'}`}>
        Citipost
      </span>
      <span className="text-[10.5px] font-bold uppercase tracking-[2.5px] text-gold-soft">ePOD</span>
    </div>
  )
}

function SidebarLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-[1.4px] text-[#8295bd]">{children}</p>
  )
}
