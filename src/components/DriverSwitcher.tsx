import type { Driver } from '../lib/types'

/** PoC stand-in for "who's signed in": a native <select> dressed to sit on the
 *  navy chrome. Switching driver re-filters the run to that driver's allocated
 *  stops and stamps the choice onto subsequent PODs. Native select keeps it
 *  robust on mobile (the OS picker) — we just style the shell. */
export function DriverSwitcher({
  drivers,
  selectedId,
  onSelect,
  compact = false,
}: {
  drivers: Driver[] | null
  selectedId: string
  onSelect: (id: string) => void
  compact?: boolean
}) {
  const selected = drivers?.find((d) => d.id === selectedId)
  const name = selected?.name ?? 'Driver'
  const initial = name.trim().charAt(0).toUpperCase() || 'D'

  return (
    <div
      className={`relative flex items-center gap-2.5 rounded-xl border border-white/[0.12] bg-white/[0.04] ${
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5'
      }`}
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-navy-500 font-serif text-sm text-white">
        {initial}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13.5px] font-semibold text-white">{name}</div>
        <div className="truncate font-mono text-[11px] text-[#9fb0d6]">{selectedId}</div>
      </div>
      <ChevronGlyph />
      {/* Transparent native select on top — its options drive the picker */}
      <select
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Switch driver"
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0"
      >
        {/* Keep the current id selectable even before the fleet has loaded */}
        {!selected && <option value={selectedId}>{selectedId}</option>}
        {drivers?.map((d) => (
          <option key={d.id} value={d.id} className="text-ink">
            {d.name} · {d.id}
          </option>
        ))}
      </select>
    </div>
  )
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-none stroke-[#9fb0d6]" fill="none" strokeWidth="2" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
