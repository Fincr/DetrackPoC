// Full lifecycle walkthrough for the demo: collection scan → warehouse scan →
// delivery capture (photo + confirm) as the driver, then the dispatcher view.
// Screenshots land in %TEMP%. Run with dev server + local Supabase up:
//   node scripts/walkthrough-lifecycle.mjs [baseUrl]
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://localhost:5190'
const OUT = process.env.TEMP ?? '.'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PHOTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'i2i-logo.png')
const TRACKING = 'CP-849213-GB'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
const context = browser.defaultBrowserContext()
await context.overridePermissions(BASE, ['geolocation'])

// ── Driver phone ────────────────────────────────────────────────────────────
const page = await browser.newPage()
await page.setViewport({ width: 430, height: 1000 })
// The delivery address for CP-849213-GB is in Erith — stand the "driver" there
await page.setGeolocation({ latitude: 51.48132, longitude: 0.16505, accuracy: 8 })

const shot = async (p, name) => {
  await p.screenshot({ path: `${OUT}\\${name}.png` })
  console.log(`${name}.png`)
}
const clickText = async (p, sel, text) => {
  await p.waitForFunction(
    (s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim() === t),
    { timeout: 20000 },
    sel,
    text,
  )
  await p.evaluate(
    (s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim() === t).click(),
    sel,
    text,
  )
}
const waitText = (p, t) =>
  p.waitForFunction(
    (x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()),
    { timeout: 20000 },
    t,
  )
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// Sign in as the driver
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
await page.waitForSelector('input[type=email]', { timeout: 20000 })
await page.type('input[type=email]', 'sam@citipost.test')
await page.type('input[type=password]', 'citipost')
await page.click('button[type=submit]')
await waitText(page, "Today's stops")
await pause(1000)
await shot(page, 'wt-1-awaiting-collection')

// STAGE 1 — collection scan at the sender
await clickText(page, 'button', 'Scan label')
await waitText(page, 'Or type the tracking number')
await clickText(page, 'button', 'Collect')
await page.type('input[placeholder="CP-849213-GB"]', TRACKING)
await clickText(page, 'button', 'Record scan')
await waitText(page, 'Collection')
await pause(800)
await shot(page, 'wt-2-collected-scan')

// STAGE 2 — warehouse scan at the depot
await clickText(page, 'button', 'Warehouse')
await page.type('input[placeholder="CP-849213-GB"]', TRACKING)
await clickText(page, 'button', 'Record scan')
await page.waitForFunction(
  () => (document.body.innerText.match(/✓/g) ?? []).length >= 2,
  { timeout: 20000 },
)
await pause(800)
await shot(page, 'wt-3-warehouse-scan')
await clickText(page, 'button', 'Done')
await waitText(page, 'At warehouse')
await pause(2500) // sync + realtime settle: chip loses "queued"
await shot(page, 'wt-4-stops-at-warehouse')

// STAGE 3 — delivery: open the stop, photograph, confirm
await clickText(page, 'div', 'Meridian Logistics')
await waitText(page, 'Photograph the parcel')
const fileInput = await page.$('input[type=file]')
await fileInput.uploadFile(PHOTO)
await waitText(page, 'Retake') // stamped photo is in
await pause(600)
await shot(page, 'wt-5-capture-ready')
await clickText(page, 'button', 'Confirm delivery')
await waitText(page, 'Synced to dispatch')
await pause(800)
await shot(page, 'wt-6-receipt-synced')

// Back to the run — the stop is done
await clickText(page, 'button', "Back to today's stops")
await waitText(page, 'done')
await pause(1500)
await shot(page, 'wt-7-stops-delivered')

// ── Dispatcher (separate session) ───────────────────────────────────────────
const adminCtx = await browser.createBrowserContext()
const admin = await adminCtx.newPage()
await admin.setViewport({ width: 1440, height: 950 })
await admin.goto(`${BASE}/#/dispatch`, { waitUntil: 'networkidle2' })
await admin.waitForSelector('input[type=email]', { timeout: 20000 })
await admin.type('input[type=email]', 'admin@citipost.test')
await admin.type('input[type=password]', 'citipost')
await admin.click('button[type=submit]')
await waitText(admin, 'Captured PODs')
await pause(2000)
await shot(admin, 'wt-8-dispatch-pod')

await browser.close()
console.log('walkthrough complete')
