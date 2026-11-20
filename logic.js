// Pure logic, shared by the app and checks.mjs. Port of Scheduling.swift and Service.cents (Models.swift).
// Every day and time is Rome's (Andrea, 2026-11-20: shops in Italy), whatever the device's time zone.

export const TZ = 'Europe/Rome'
const partsOf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock time in Rome of an instant. month 0-11, dow 0 = Sunday (as Date). */
export function rome(d) {
  const p = Object.fromEntries(partsOf.formatToParts(d).map(x => [x.type, x.value]))
  return { year: +p.year, month: +p.month - 1, day: +p.day, hour: +p.hour, minute: +p.minute, dow: DOW[p.weekday] }
}

/** The instant of a wall-clock time in Rome. Like `new Date(y, m, d, h, min)`, days may overflow (d + 1). */
export function romeDate(year, month, day, hour = 0, minute = 0) {
  const wall = Date.UTC(year, month, day, hour, minute)
  let t = wall
  for (let i = 0; i < 2; i++) { // second pass: daylight saving change between the guess and the answer
    const r = rome(new Date(t))
    t += wall - Date.UTC(r.year, r.month, r.day, r.hour, r.minute)
  }
  return new Date(t)
}

/** Slot grid, in minutes. */
export const STEP = 30

/** Index 0 = Sunday ... 6 = Saturday (Date.getDay()). null = closed. Mon-Fri 09:00-19:00. */
export const defaultWeek = () => [null, null, ...Array.from({ length: 5 }, () => ({ open: 540, close: 1140 }))]

/**
 * Start times on `day` (Rome) where a service of `duration` minutes fits inside opening hours,
 * is in the future and does not overlap any `busy` interval ({start, end} Dates).
 */
export function freeStarts(day, week, duration, busy, now) {
  const d = rome(day), hours = week[d.dow]
  if (!(duration > 0) || !hours) return []
  const result = []
  for (let minute = hours.open; minute <= hours.close - duration; minute += STEP) {
    const start = romeDate(d.year, d.month, d.day, Math.floor(minute / 60), minute % 60)
    const end = new Date(start.getTime() + duration * 60000)
    if (start > now && !busy.some(b => start < b.end && end > b.start)) result.push(start)
  }
  return result
}

/** True when an appointment does not fit inside the opening hours of its day (Rome), or the day is closed. */
export function isOutside(start, end, week) {
  const s = rome(start), e = rome(end), hours = week[s.dow]
  return !hours || !sameDay(start, end) || s.hour * 60 + s.minute < hours.open || e.hour * 60 + e.minute > hours.close
}

/**
 * What the owner types as a price: "15", "15,5" or "15.50" → 1550. null when it is not a number or outside
 * what the database accepts (0 to 10 000 €).
 */
export function cents(text) {
  const normalized = String(text).trim().replaceAll(',', '.')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(normalized)) return null
  const euros = Number(normalized)
  return euros <= 10000 ? Math.round(euros * 100) : null
}

// Formatting, Italian as on the iPhone.
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })
export const priceText = c => euro.format(c / 100)
/** Date text in Rome's time zone: `dayText(d, { weekday: 'short' })`. */
export const dayText = (d, options) => d.toLocaleDateString('it-IT', { timeZone: TZ, ...options })
export const time = d => d.toLocaleTimeString('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
export const longDay = d => dayText(d, { weekday: 'long', day: 'numeric', month: 'long' })
export const fullDate = d => `${dayText(d, { dateStyle: 'full' })} alle ${time(d)}`
export const shortDate = d => `${dayText(d, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time(d)}`
export const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** Days are Rome's midnights. */
export const startOfDay = d => { const r = rome(d); return romeDate(r.year, r.month, r.day) }
export const addDays = (d, n) => { const r = rome(d); return romeDate(r.year, r.month, r.day + n, r.hour, r.minute) }
export const sameDay = (a, b) => dayValue(a) === dayValue(b)
/** <input type="date"> value ↔ Rome's midnight. */
export const dayValue = d => { const r = rome(d); return `${r.year}-${String(r.month + 1).padStart(2, '0')}-${String(r.day).padStart(2, '0')}` }
export const parseDay = v => { const [y, m, d] = v.split('-').map(Number); return romeDate(y, m - 1, d) }

/**
 * Calendar file with an alarm one hour before: the web stand-in for the iPhone's local reminder.
 * The browser cannot schedule a notification while closed, the phone's calendar can.
 */
export function ics({ id, title, detail, start, end }) {
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const text = s => String(s).replace(/[\\;,]/g, c => '\\' + c).replace(/\r?\n/g, '\\n')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BarberBook//IT', 'BEGIN:VEVENT',
    `UID:${id}@barberbook`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${text(title)}`, `DESCRIPTION:${text(detail)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', "DESCRIPTION:Appuntamento tra un'ora", 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
}
