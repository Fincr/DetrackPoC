// Dev-time E2E check of the parcel lifecycle: sign in as a driver, record a
// collection scan, a warehouse scan, and an out-of-order (skip-warning) scan
// via the stage-aware scan sheet, then screenshot the run sheet chips.
// Run with the dev server + local Supabase up:
//   node scripts/verify-lifecycle.mjs [baseUrl]
// Requires puppeteer-core (npm i --no-save puppeteer-core) and local Chrome.
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://localhost:5190'
const OUT = process.env.TEMP ?? '.'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 430, height: 1100 },
})
// A real (injected) GPS fix — the quick scans should record these coords.
const context = browser.defaultBrowserContext()
await context.overridePermissions(BASE, ['geolocation'])
const page = await browser.newPage()
await page.setGeolocation({ latitude: 51.50138, longitude: -0.14189, accuracy: 9 })

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}\\${name}.png` })
  console.log(`${name}.png`)
}
/** Click the first element matching selector whose trimmed text equals `text`. */
const clickText = async (sel, text) => {
  await page.waitForFunction(
    (s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim() === t),
    { timeout: 15000 },
    sel,
    text,
  )
  await page.evaluate(
    (s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim() === t).click(),
    sel,
    text,
  )
}
// case-insensitive: CSS text-transform (section labels are uppercased) is
// reflected in innerText
const waitText = (t) =>
  page.waitForFunction(
    (x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()),
    { timeout: 15000 },
    t,
  )

// Sign in as the demo driver
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
await page.waitForSelector('input[type=email]', { timeout: 15000 })
await page.type('input[type=email]', 'sam@citipost.test')
await page.type('input[type=password]', 'citipost')
await page.click('button[type=submit]')
await waitText("Today's stops")
await new Promise((r) => setTimeout(r, 1000))
await shot('lc-1-stops-before')

// Open the scan sheet → Collect mode → type-in scan
await clickText('button', 'Scan label')
await waitText('Or type the tracking number')
await clickText('button', 'Collect')
await page.type('input[placeholder="CP-849213-GB"]', 'CP-849213-GB')
await clickText('button', 'Record scan')
await waitText('Collection')
await new Promise((r) => setTimeout(r, 800))
await shot('lc-2-collected')

// Same parcel → Warehouse
await clickText('button', 'Warehouse')
await page.type('input[placeholder="CP-849213-GB"]', 'CP-849213-GB')
await clickText('button', 'Record scan')
await page.waitForFunction(
  () => (document.body.innerText.match(/✓/g) ?? []).length >= 2, // two session-log entries
  { timeout: 15000 },
)
await new Promise((r) => setTimeout(r, 500))

// Out-of-order: warehouse scan for a parcel never collected → skip warning
await page.type('input[placeholder="CP-849213-GB"]', 'CP-100003-GB')
await clickText('button', 'Record scan')
await waitText('Skipped collection')
await new Promise((r) => setTimeout(r, 800))
await shot('lc-3-warehouse-and-warning')

// Close the sheet; chips should advance (and lose "queued" once synced)
await clickText('button', 'Done')
await waitText('At warehouse')
await new Promise((r) => setTimeout(r, 3000)) // let the sync + realtime settle
await shot('lc-4-stops-after')

await browser.close()
console.log('lifecycle flow OK')
