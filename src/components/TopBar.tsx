/** Navy top bar (§7): gold uppercase eyebrow, Georgia-serif title, optional
 *  mono barcode line, gold-to-transparent underline. */
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
    <div className="gold-underline relative bg-navy px-[18px] pb-4 pt-3.5 text-white">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-1 block text-[11px] font-semibold text-[#9fb0d6]"
        >
          ‹ Today's stops
        </button>
      )}
      <div className="text-[10.5px] font-semibold uppercase tracking-[2px] text-gold-soft">
        {eyebrow}
      </div>
      <div className="mt-[3px] font-serif text-lg">{title}</div>
      {mono && (
        <div className="mt-[5px] font-mono text-xs tracking-[1px] text-[#9fb0d6]">{mono}</div>
      )}
    </div>
  )
}
