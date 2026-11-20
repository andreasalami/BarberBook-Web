// Self-check for the slot logic, price input and QR encoder. From the project root:
//   node checks/checks.mjs
// Times are Rome's whatever the machine's time zone: also try TZ=America/New_York node checks/checks.mjs
// With an argument, also writes QR matrices for checks/qr-decode.swift (see README → Controlli).
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { freeStarts, cents, defaultWeek, hhmm, ics, isOutside, rome, romeDate, startOfDay, addDays, dayValue, parseDay, time } from '../logic.js'
import { qr } from '../qr.js'

const at = (day, h, m = 0) => romeDate(2026, 10, day, h, m)
const hm = d => { const r = rome(d); return hhmm(r.hour * 60 + r.minute) }
const tuesday = at(17, 0), monday = at(16, 0), past = at(1, 0), week = defaultWeek()
assert.equal(rome(tuesday).dow, 2)

// Rome's wall clock: 17 Nov 10:00 is 09:00 UTC (winter), 17 Jul 10:00 is 08:00 UTC (summer).
assert.equal(at(17, 10).toISOString(), '2026-11-17T09:00:00.000Z')
assert.equal(romeDate(2026, 6, 17, 10).toISOString(), '2026-07-17T08:00:00.000Z')
assert.equal(time(at(17, 10)), '10:00')
// Daylight saving ends on 25 Oct 2026: that day has 25 hours, the next midnight is still a Rome midnight.
assert.equal(addDays(romeDate(2026, 9, 25), 1).toISOString(), '2026-10-25T23:00:00.000Z')
assert.equal(startOfDay(at(17, 23, 30)).toISOString(), '2026-11-16T23:00:00.000Z')
assert.equal(dayValue(parseDay('2026-11-17')), '2026-11-17')
assert.equal(dayValue(at(17, 0, 30)), '2026-11-17') // 23:30 UTC on the 16th

// Open day, nothing booked: 09:00 ... 18:30 every 30 minutes.
const all = freeStarts(tuesday, week, 30, [], past)
assert.equal(all.length, 20); assert.equal(hm(all[0]), '09:00'); assert.equal(hm(all.at(-1)), '18:30')
// Closed day.
assert.deepEqual(freeStarts(monday, week, 30, [], past), [])
// Busy 10:00-10:30 removes 10:00 but keeps 09:30 and 10:30 (touching is fine).
const free = new Set(freeStarts(tuesday, week, 30, [{ start: at(17, 10), end: at(17, 10, 30) }], past).map(hm))
assert(!free.has('10:00') && free.has('09:30') && free.has('10:30'))
// A 15-minute booking at 11:15 still blocks the 11:00 slot of a 30-minute service.
assert(!freeStarts(tuesday, week, 30, [{ start: at(17, 11, 15), end: at(17, 11, 30) }], past).map(hm).includes('11:00'))
// Past slots are hidden.
assert.equal(hm(freeStarts(tuesday, week, 30, [], at(17, 12))[0]), '12:30')
// Service longer than the opening window.
assert.deepEqual(freeStarts(tuesday, [{ open: 540, close: 560 }, null, null, null, null, null, null], 30, [], past), [])

// Bookings left outside new opening hours (Tuesday open 09:00-19:00, Monday closed).
assert(!isOutside(at(17, 18, 30), at(17, 19), week))
assert(isOutside(at(17, 18, 30), at(17, 19, 30), week))
assert(isOutside(at(17, 8, 30), at(17, 9), week))
assert(isOutside(at(16, 10), at(16, 10, 30), week))

// Prices typed by the owner: Italian comma or dot; junk and out-of-range values refused.
assert.equal(cents('15'), 1500); assert.equal(cents('15,5'), 1550); assert.equal(cents(' 15.50 '), 1550)
assert.equal(cents('0'), 0); assert.equal(cents('0,29'), 29)
for (const bad of ['', 'abc', '-1', '10001', '1.500,00']) assert.equal(cents(bad), null, bad)

// Calendar file: one-hour alarm, special characters escaped, CRLF lines.
const cal = ics({ id: 'x', title: 'Taglio, barba', detail: 'con Luca', start: at(17, 10), end: at(17, 10, 30) })
assert(cal.includes('TRIGGER:-PT1H') && cal.includes('SUMMARY:Taglio\\, barba') && cal.includes('DTSTART:20261117T090000Z'))
assert(cal.split('\r\n').length > 10)

// QR: size grows with the text (version 1 = 21 modules), finder pattern in the corners.
const samples = ['PROVA2', 'https://andreasalami.github.io/BarberBook-Web/?shop=BARBA2',
  'https://example.com/' + 'x'.repeat(150) + '?shop=ABCDEF']
const matrices = samples.map(qr)
assert.equal(matrices[0].length, 21)
for (const m of matrices) {
  const n = m.length
  assert(m[0][0] && m[0][6] && m[6][0] && !m[1][1] && m[3][3] && m[0][n - 1] && m[n - 1][0] && m[n - 8][8])
}
assert(matrices[2].length >= 45) // version 7+: exercises the version information blocks
assert.throws(() => qr('x'.repeat(300)))

if (process.argv[2]) {
  writeFileSync(process.argv[2], samples.map((s, i) => s + '\n' + matrices[i].map(r => r.map(Number).join('')).join('\n')).join('\n\n'))
}
console.log('Scheduling, price, calendar and QR checks passed')
