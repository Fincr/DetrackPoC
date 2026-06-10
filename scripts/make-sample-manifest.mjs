// Generate a realistic PARCEL manifest .xlsx for testing the Jobs import.
// Headers deliberately differ from our field names (e.g. "Delivery Address",
// "Service") to exercise the column auto-mapper. Usage:
//   node scripts/make-sample-manifest.mjs "C:\path\sample parcel manifest.xlsx"
import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

const headers = ['Tracking Number', 'Recipient Name', 'Delivery Address', 'Postcode', 'Service', 'Weight (kg)']
const rows = [
  ['DBM-260610-001', 'Meridian Logistics', 'Unit 4, Hailey Road Industrial Estate, Erith', 'DA18 4AA', 'Domestic', 2.4],
  ['DBM-260610-002', 'Patricia Holloway', '14 Larkspur Close, Maidstone', 'ME14 9QT', 'Domestic', 0.8],
  ['DBM-260610-003', 'Brightwell Imports Ltd', '22 Queen Street, Edinburgh', 'EH2 1JX', 'International', 5.1],
  ['DBM-260610-004', 'Atlantique Wines (UK)', '8 Harbour View, Cardiff Bay, Cardiff', 'CF10 5BZ', 'International', 12.0],
  ['DBM-260610-005', 'Acme Home Goods', '3 Foundry Lane, Holbeck, Leeds', 'LS11 9XE', 'Fulfilment', 3.3],
  ['DBM-260610-006', 'Tillys Toy Shop', '27 St Giles Street, Norwich', 'NR2 1JN', 'Fulfilment', 1.2],
  ['DBM-260610-007', 'NN4 Regional Sort Hub', 'Unit 9, Saddlers Way, Northampton', 'NN4 7HD', 'Sortation', 8.7],
  ['DBM-260610-008', 'Harbour Pharmacy', '5 Marine Parade, Brighton', 'BN2 1TL', 'Domestic', 0.5],
]

const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'Manifest')

const out = process.argv[2] ?? 'sample parcel manifest.xlsx'
writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
console.log(`wrote ${out} — ${rows.length} parcels`)
