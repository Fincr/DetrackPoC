import type { ReactNode } from 'react'

/** The §7 stage: lead heading on the navy desk background, then the 390px
 *  phone frame with the layered bezel shadow. All driver screens render inside. */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center gap-[22px] px-4 pb-14 pt-7">
      <header className="max-w-[430px] text-center">
        <h1 className="font-serif text-[21px] font-semibold tracking-[0.2px] text-white">
          Electronic Proof of Delivery
        </h1>
        <p className="mt-1.5 text-[13.5px] leading-[1.6] text-[#aeb8d4]">
          Scan the label, photograph the parcel — timestamp and location are
          burned into the image and packaged into a delivery record.
        </p>
        <a href="#/dispatch" className="mt-2 inline-block text-xs text-[#9fb0d6] underline">
          Dispatcher view →
        </a>
      </header>
      <div className="relative w-[390px] max-w-full overflow-hidden rounded-phone bg-paper shadow-phone">
        {children}
      </div>
    </div>
  )
}
