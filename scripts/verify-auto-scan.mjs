// Verify Auto scan mode: three scans of the same label walk the whole
// lifecycle — collected, at warehouse, then the delivery capture opens.
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = 'http://localhost:5190'
const TEMP = process.env.TEMP ?? '.'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const T = 'TJOB-0001-GB'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
const ctx = await browser.createBrowserContext()
await ctx.overridePermissions(BASE, ['geolocation'])
const page = await ctx.newPage()
await page.setViewport({ width: 390, height: 900, isMobile: true, hasTouch: true })
await page.setGeolocation({ latitude: 51.5237, longitude: -0.0719, accuracy: 7 })

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const waitText = (t, timeout = 25000) =>
  page.waitForFunction((x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()), { timeout }, t)
const clickText = async (sel, text) => {
  await page.waitForFunction(
    (s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim() === t),
    { timeout: 25000 },
    sel,
    text,
  )
  await page.evaluate(
    (s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim() === t).click(),
    sel,
    text,
  )
}
const setInput = (val) =>
  page.evaluate((v) => {
    const el = document.querySelector('input[placeholder="CP-849213-GB"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, val)
const shot = async (name) => {
  await page.screenshot({ path: path.join(TEMP, `${name}.png`) })
  console.log(`${name}.png`)
}

await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
await page.waitForSelector('input[type=email]', { timeout: 25000 })
await page.type('input[type=email]', 'sam@citipost.test')
await page.type('input[type=password]', 'citipost')
await page.click('button[type=submit]')
await waitText("Today's stops")
await waitText(T)

await clickText('button', 'Scan label')
await waitText('One scan per step') // Auto is the default

// Scan 1 — should record COLLECTION
await setInput(T)
await clickText('button', 'Scan parcel')
await waitText('Collection')
console.log('scan 1 -> Collection logged')
await shot('auto-1-collected')

// Scan 2 (after the debounce window) — should record WAREHOUSE
await pause(4500)
await setInput(T)
await clickText('button', 'Scan parcel')
await page.waitForFunction(
  () => document.body.innerText.includes('Warehouse') && (document.body.innerText.match(/✓/g) ?? []).length >= 2,
  { timeout: 25000 },
)
console.log('scan 2 -> Warehouse logged')
await shot('auto-2-warehouse')

// Scan 3 — should OPEN the delivery capture
await pause(4500)
await setInput(T)
await clickText('button', 'Scan parcel')
await waitText('Photograph the parcel')
const right = await page.evaluate(() => document.querySelector('h1').textContent.includes('TJOB-0001-GB'))
console.log(`scan 3 -> delivery capture opened for the right parcel: ${right}`)
await shot('auto-3-capture')

await browser.close()
console.log('AUTO lifecycle flow OK')
