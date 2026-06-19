// Pure-function tests for the enrichment transforms (no DB/stack). Node 24
// type-stripping imports the real src/lib modules under test.
//   node scripts/test-enrich.mjs
import {
  composeAddressLine, composeRecipient, composeSenderAddress, senderName,
  postcodeArea, shipmentToParcelInput,
} from '../src/lib/enrich.ts'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

const row = {
  tracking_number: 'TRK1',
  recipient_full_name: 'Jane Doe',
  recipient_company: 'Acme Optics',
  recipient_address1: '1 High St',
  recipient_address2: 'Unit 4',
  recipient_address3: '',
  recipient_city: 'Bromley',
  recipient_county: 'Kent',
  recipient_postcode: 'BR1 1AA',
}

console.log('compose')
check('address joins non-empty parts with ", "',
  composeAddressLine(row) === '1 High St, Unit 4, Bromley, Kent', composeAddressLine(row))
check('recipient prefers full name', composeRecipient(row) === 'Jane Doe')
check('recipient falls back to company',
  composeRecipient({ ...row, recipient_full_name: '' }) === 'Acme Optics')
check('recipient falls back to placeholder',
  composeRecipient({ ...row, recipient_full_name: '', recipient_company: '' }) === '(no name)')

console.log('postcodeArea')
check('SL4 1DE → SL', postcodeArea('SL4 1DE') === 'SL')
check('DY11 7FL → DY', postcodeArea('DY11 7FL') === 'DY')
check('B2 4RQ → B', postcodeArea('B2 4RQ') === 'B')
check('lowercase + spaces tolerated', postcodeArea('  dy11 7fl ') === 'DY')
check('blank → ""', postcodeArea('') === '')
check('null → ""', postcodeArea(null) === '')
check('numeric junk → ""', postcodeArea('1234') === '')

console.log('sender')
const srow = { ...row,
  sender_company: '', sender_address1: '5 Mill St', sender_address2: '', sender_address3: '',
  sender_city: 'Windsor', sender_county: 'Berkshire', sender_postcode: 'SL4 1DE' }
check('composeSenderAddress joins parts', composeSenderAddress(srow) === '5 Mill St, Windsor, Berkshire')
check('senderName blank company → null (no map)', senderName(srow) === null)
check('senderName uses Sender_Company when present',
  senderName({ ...srow, sender_company: 'Specsavers' }) === 'Specsavers')
check('senderName falls back to lookup map',
  senderName(srow, { 'SL4 1DE': 'Specsavers Windsor' }) === 'Specsavers Windsor')

console.log('shipmentToParcelInput')
const pi = shipmentToParcelInput(srow, { 'SL4 1DE': 'Specsavers Windsor' })
check('both areas + sender block + mapped name',
  pi.delivery_area === 'BR' && pi.collection_area === 'SL' &&
  pi.sender_postcode === 'SL4 1DE' && pi.sender_address_line === '5 Mill St, Windsor, Berkshire' &&
  pi.sender_name === 'Specsavers Windsor', JSON.stringify(pi))
check('raw row kept in meta', pi.meta.recipient_city === 'Bromley')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
