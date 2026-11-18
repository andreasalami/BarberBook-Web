// Pure logic, shared by the app and checks.mjs. Port of Scheduling.swift and Service.cents (Models.swift).

/** Slot grid, in minutes. */
export const STEP = 30

/** Index 0 = Sunday ... 6 = Saturday (Date.getDay()). null = closed. Mon-Fri 09:00-19:00. */
export const defaultWeek = () => [null, null, ...Array.from({ length: 5 }, () => ({ open: 540, close: 1140 }))]

/**
 * Start times on `day` (local time) where a service of `duration` minutes fits inside opening hours,
 * is in the future and does not overlap any `busy` interval ({start, end} Dates).
 */
export function freeStarts(day, week, duration, busy, now) {
  const hours = week[day.getDay()]
  if (!(duration > 0) || !hours) return []
  const result = []
  for (let minute = hours.open; minute <= hours.close - duration; minute += STEP) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60)
    const end = new Date(start.getTime() + duration * 60000)
    if (start > now && !busy.some(b => start < b.end && end > b.start)) result.push(start)
  }
  return result
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
export const time = d => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
export const longDay = d => d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
export const fullDate = d => `${d.toLocaleDateString('it-IT', { dateStyle: 'full' })} alle ${time(d)}`
export const shortDate = d => `${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}, ${time(d)}`
export const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime()
/** <input type="date"> value ↔ local midnight. */
export const dayValue = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const parseDay = v => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d) }

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
