/** Light page header (§7 brand accents on a web-app surface): gold uppercase
 *  eyebrow, Georgia-serif title, optional mono barcode line. The brand navy
 *  now lives in the global app bar, so this reads as a page heading. */
export function TopBar({
  eyebrow,
  title,
  mono,
  onBack,
}: {
  eyebrow: string
  title: string
  mono?: string
  onBack?: () => void
}) {
  return (
    <div className="relative border-b border-line bg-white px-[18px] py-4 lg:px-8">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-1.5 block text-[11px] font-semibold text-navy-500"
        >
          ‹ Today's stops
        </button>
      )}
      <div className="text-[10.5px] font-semibold uppercase tracking-[2px] text-gold">
        {eyebrow}
      </div>
      <div className="mt-[3px] font-serif text-xl text-ink">{title}</div>
      {mono && (
        <div className="mt-[5px] font-mono text-xs tracking-[1px] text-muted">{mono}</div>
      )}
    </div>
  )
}
