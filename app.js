// BarberBook on the web: same screens and rules as the iPhone app (BarberBook/*.swift), same Supabase backend.
// The user picks a role on first visit. Customers open a shop by code or QR link (remembered as their default);
// owners sign in with Google and create or manage their own shop. The server enforces who may do what (RLS).
import * as api from './api.js'
import { addDays, cents, dayValue, defaultWeek, freeStarts, fullDate, hhmm, ics, longDay, parseDay, priceText as formatPrice,
  sameDay, shortDate, startOfDay, STEP, time } from './logic.js'
import { qrDataURL } from './qr.js'

// MARK: Storage (UserDefaults on the iPhone)

const area = persistent => { try { return persistent ? localStorage : sessionStorage } catch { return null } }
const pref = (key, persistent = true) => ({
  get: () => { try { return area(persistent)?.getItem(key) ?? null } catch { return null } },
  set: v => { try { v == null ? area(persistent)?.removeItem(key) : area(persistent)?.setItem(key, v) } catch {} },
})
const ROLE = pref('barberbook.role'), SHOP_CODE = pref('barberbook.shopCode'), NAME = pref('barberbook.customerName')
/** Set when the user switches from customer to owner in this tab: the owner area shows customers' names, so it asks
 *  for Google again even if a session exists. A fresh visit as owner does not ask. */
const OWNER_SIGN_IN = pref('barberbook.ownerSignIn', false)
const DEMO = pref('barberbook.demo', false)

/** Open the site with ?demo to try every screen with in-memory data and no network (as `-demo YES` on the iPhone). */
const demo = new URLSearchParams(location.search).has('demo') || DEMO.get() === '1'
if (demo) DEMO.set('1')
const D = demo ? demoData() : null

const S = {
  phase: 'loading', failMessage: '',
  role: ROLE.get() ?? '',
  /** Customer: the shop opened by code. Owner: their own shop (null until created). */
  shop: null, staff: [], services: [],
  /** Signed in with Google. Anonymous sessions can book but never own a shop. */
  signedIn: false,
  ownerSignInRequired: OWNER_SIGN_IN.get() === '1',
  tab: { customer: 'book', owner: 'agenda' },
  form: null, mine: [], newStaff: '',
  agenda: { start: startOfDay(new Date()), bookings: [] },
}

const SLOT_TAKEN = 'Questo orario è appena stato preso. Scegline un altro.'
const SPAN = 5

function setOwnerSignInRequired(value) { S.ownerSignInRequired = value; OWNER_SIGN_IN.set(value ? '1' : null) }
function setRole(role) { S.role = role; ROLE.set(role || null); load() }

/** Goes straight to the other role; the "Sono un cliente / Sono il titolare" screen is only for the first visit. */
function switchRole() {
  if (S.role === 'owner') return setRole('customer')
  setOwnerSignInRequired(true) // identify again before showing customers' names
  setRole('owner')
}
const switchRoleLabel = () => S.role === 'owner' ? 'Passa a Cliente' : 'Passa a Negoziante'

// MARK: Loading

let loadID = 0

async function load() {
  const id = ++loadID, role = S.role, code = SHOP_CODE.get()
  Object.assign(S, { phase: 'loading', shop: null, staff: [], services: [], form: null, mine: [] })
  render()
  try {
    let shop = null
    if (demo) {
      S.signedIn = true
      shop = role === 'owner' ? D.shop : D.shop.code === code ? D.shop : null
    } else {
      const user = api.user()
      S.signedIn = user?.is_anonymous === false
      if (role === 'owner' && user && S.signedIn) shop = (await api.select('shops', [['owner_id', `eq.${user.id}`]]))[0] ?? null
      else if (role === 'customer' && code) shop = (await api.select('shops', [['code', `eq.${code}`]]))[0] ?? null
    }
    if (id !== loadID) return // a newer load replaced this one
    S.shop = shop
    if (role === 'customer' && code && !shop) {
      SHOP_CODE.set(null)
      showAlert('Attenzione', `Nessun negozio trovato con il codice ${code}.`)
    }
    if (shop) await reloadCatalog()
    if (id !== loadID) return
    S.phase = 'ready'
  } catch (e) {
    if (id !== loadID) return
    if (isExpired(e)) S.signedIn = false
    S.phase = 'failed'
    S.failMessage = message(e)
  }
  render()
  enterTab()
}

async function reloadCatalog() {
  if (!S.shop) return
  if (demo) { S.staff = [...D.staff]; S.services = [...D.services]; return }
  const filter = [['shop_id', `eq.${S.shop.id}`], ['order', 'name']]
  ;[S.staff, S.services] = await Promise.all([api.select('staff', filter), api.select('services', filter)])
}

/** The shop's hours, staff and services again: the owner may have changed them since the page opened,
 *  and the server refuses bookings that no longer match them. */
async function refreshShop() {
  const code = S.shop?.code
  if (demo || !code) return
  await run(async () => {
    const fresh = (await api.select('shops', [['code', `eq.${code}`]]))[0]
    if (fresh) S.shop = fresh
    await reloadCatalog()
  })
}

const staffName = id => S.staff.find(s => s.id === id)?.name ?? '—'

/** ponytail: today's list price, matched by service name; null if the service was renamed or removed.
 *  Store the price on the booking if price history ever matters (receipts, price changes). */
function bookingPrice(b) {
  const c = b.shops?.services?.find(s => s.name === b.service_name)?.price_cents
    ?? S.services.find(s => s.shop_id === b.shop_id && s.name === b.service_name)?.price_cents
  return c == null ? null : formatPrice(c)
}

// MARK: Customer: pick a shop

/** Codes are 6 letters/digits; anything else is ignored. */
const normalizeCode = raw => { const code = raw.trim().toUpperCase(); return /^[A-Z0-9]{4,12}$/.test(code) ? code : null }

function openShop(raw) {
  const code = normalizeCode(raw)
  if (!code) return showAlert('Attenzione', 'Codice non valido.')
  SHOP_CODE.set(code)
  load()
}

function leaveShop() {
  SHOP_CODE.set(null)
  Object.assign(S, { shop: null, staff: [], services: [], form: null, mine: [] })
  render()
}

/** What the QR code in the shop opens: this site on that shop. Any phone camera reads it, no app needed. */
const shopLink = code => `${location.origin}${location.pathname}?shop=${code}${demo ? '&demo' : ''}`

// MARK: Account (owners and customers)

/** Leaves the page for Google; boot() completes the sign-in on return. */
const signInWithGoogle = () => run(() => api.startGoogle())

/** The next server call starts a fresh anonymous session. A customer keeps the shop code in this browser. */
function signOut() { api.signOut(); load() }

/** Owner or customer. Deletes the server account and everything it owns, then the local copies. */
async function deleteAccount() {
  if (!demo && !(await run(() => api.deleteAccount()))) return false
  SHOP_CODE.set(null)
  NAME.set(null)
  leaveShop()
  return true
}

async function createShop(name) {
  if (demo) { S.shop = D.shop; await reloadCatalog(); render(); return }
  // ponytail: a random code collision (1 in ~10^9 per shop) fails the insert; the owner just taps again.
  const created = await attempt(() => api.insert('shops', { name, week: defaultWeek() }))
  if (!created) return
  S.shop = created
  await run(reloadCatalog)
  render()
  enterTab()
}

async function saveShop(updated) {
  if (demo) { D.shop = updated; S.shop = updated; return true }
  if (!(await run(() => api.update('shops', updated.id, { name: updated.name, week: updated.week })))) return false
  S.shop = updated
  return true
}

async function saveStaff(member) {
  if (demo) { D.staff.push(member); S.staff = [...D.staff] }
  else await run(async () => { await api.upsert('staff', member); await reloadCatalog() })
  render()
}

async function saveService(service) {
  if (demo) {
    D.services = D.services.filter(s => s.id !== service.id).concat(service).sort((a, b) => a.name.localeCompare(b.name))
    S.services = [...D.services]
    return true
  }
  return run(async () => { await api.upsert('services', service); await reloadCatalog() })
}

/** Upcoming bookings of one staff member, which go with them when they are deleted (on delete cascade).
 *  null when the count could not be read: the caller must not delete without it. */
async function upcomingBookings(staffID) {
  if (demo) return D.bookings.filter(b => b.staff_id === staffID && b.ends_at > new Date()).length
  const rows = await attempt(() => api.select('bookings', [['select', 'id'], ['staff_id', `eq.${staffID}`],
    ['ends_at', `gt.${new Date().toISOString()}`]]))
  return rows?.length ?? null
}

/** `table` is "staff" or "services". */
async function deleteRow(table, id) {
  if (demo) {
    D.staff = D.staff.filter(s => s.id !== id)
    D.bookings = D.bookings.filter(b => b.staff_id !== id) // as the server does
    D.services = D.services.filter(s => s.id !== id)
    S.staff = [...D.staff]; S.services = [...D.services]
  } else await run(async () => { await api.remove(table, id); await reloadCatalog() })
  render()
}

// MARK: Bookings

const toBooking = b => ({ ...b, starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at) })

/** Busy intervals of one staff member on `day`, without names (database function `busy`). */
async function busy(staffID, day) {
  const from = startOfDay(day), to = addDays(from, 1)
  if (demo) return D.bookings.filter(b => b.staff_id === staffID && b.starts_at < to && b.ends_at > from)
    .map(b => ({ start: b.starts_at, end: b.ends_at }))
  const rows = await attempt(() => api.rpc('busy', { p_staff: staffID, p_from: from.toISOString(), p_to: to.toISOString() })) ?? []
  return rows.map(r => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }))
}

/** The database refuses overlapping bookings of the same staff member (exclusion constraint), so two customers
 *  tapping the same slot at the same moment cannot both win. */
async function book(service, staffID, start, customerName, isOwner) {
  if (!S.shop) return null
  const booking = { id: crypto.randomUUID(), shop_id: S.shop.id, staff_id: staffID, service_name: service.name,
    customer_name: customerName, starts_at: start, ends_at: new Date(start.getTime() + service.minutes * 60000) }
  if (demo) {
    if (D.bookings.some(b => b.staff_id === staffID && b.starts_at < booking.ends_at && b.ends_at > start)) {
      showAlert('Attenzione', SLOT_TAKEN)
      return null
    }
    D.bookings.push({ ...booking, staff: { name: staffName(staffID) }, shops: { name: S.shop.name } })
    if (isOwner) D.ownerBookings.add(booking.id) // the owner's: no customer account, as on the server
    return booking
  }
  const saved = await attempt(() => api.insert('bookings',
    { ...booking, starts_at: booking.starts_at.toISOString(), ends_at: booking.ends_at.toISOString() }))
  return saved && toBooking(saved)
}

async function cancel(booking) {
  if (demo) { D.bookings = D.bookings.filter(b => b.id !== booking.id); return true }
  return run(() => api.remove('bookings', booking.id))
}

/** Owner agenda: every booking of the shop starting in the `days` days from `from`. null on failure, so the agenda
 *  keeps what it shows instead of looking free. `quiet`: background refresh, no alert (it would pop up offline). */
async function agendaBookings(from, days, quiet = false) {
  const to = addDays(from, days)
  if (demo) return D.bookings.filter(b => b.starts_at >= from && b.starts_at < to).sort((a, b) => a.starts_at - b.starts_at)
  if (!S.shop) return []
  // No embedded price list here: the owner already has it in `services` (see bookingPrice).
  const query = [['select', '*,staff(name)'], ['shop_id', `eq.${S.shop.id}`], ['starts_at', `gte.${from.toISOString()}`],
    ['starts_at', `lt.${to.toISOString()}`], ['order', 'starts_at']]
  const work = async () => (await api.select('bookings', query)).map(toBooking)
  if (quiet) { try { return await work() } catch { return null } }
  return attempt(work)
}

/** Customer: own upcoming (and in progress) bookings in every shop. */
async function myBookings() {
  const now = new Date()
  if (demo) return D.bookings.filter(b => b.ends_at > now && !D.ownerBookings.has(b.id)).sort((a, b) => a.starts_at - b.starts_at)
  const me = api.user()?.id
  if (!me) return []
  return await attempt(async () => (await api.select('bookings', [['select', '*,shops(name,services(name,price_cents)),staff(name)'],
    ['customer_id', `eq.${me}`], ['ends_at', `gt.${now.toISOString()}`], ['order', 'starts_at']])).map(toBooking)) ?? []
}

/** Calendar file with an alarm one hour before: the web stand-in for the iPhone's local reminder. */
function addToCalendar(b) {
  const file = ics({ id: b.id, title: `${b.service_name} · ${b.shops?.name ?? S.shop?.name ?? 'BarberBook'}`,
    detail: `con ${b.staff?.name ?? staffName(b.staff_id)}`, start: b.starts_at, end: b.ends_at })
  const url = URL.createObjectURL(new Blob([file], { type: 'text/calendar' }))
  const link = h('a', { href: url, download: 'appuntamento.ics' })
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// MARK: Errors

async function run(work) {
  try { await work(); return true } catch (e) { handle(e); return false }
}
async function attempt(work) {
  try { return await work() } catch (e) { handle(e); return null }
}
function handle(e) {
  if (isExpired(e)) { S.signedIn = false; render() } // owners go back to the sign-in screen
  showAlert('Attenzione', message(e))
}
const isExpired = e => e instanceof api.Failure && e.code === api.SESSION_EXPIRED

function message(e) {
  if (!(e instanceof api.Failure)) return e?.message ?? String(e)
  switch (e.code) {
    case '23P01': return SLOT_TAKEN
    // Table checks answer in English ("new row … violates check constraint"); the booking rules answer in Italian.
    case '23514': return e.message.startsWith('new row') ? 'Testo troppo lungo o dati non validi.' : e.message
    case api.SESSION_EXPIRED: case 'offline': return e.message
    case '42501': return 'Operazione non permessa con questo account.'
    case 'validation_failed':
      if (e.message.includes('provider is not enabled')) return 'Accesso con Google non ancora attivo su Supabase (Authentication → Sign In / Providers → Google).'
      break
    case 'manual_linking_disabled':
      return 'Collegamento account disattivato su Supabase (Authentication → Sign In / Providers → Allow manual linking).'
  }
  return e.status === 401 ? 'Sessione scaduta. Accedi di nuovo.' : e.message
}

// MARK: DOM helpers

/** Element with properties (booleans and `value` as properties, the rest as attributes, on* as listeners). */
function h(tag, props, ...children) {
  const el = document.createElement(tag)
  el.append(...children.flat(Infinity).filter(c => c != null && c !== false && c !== '')
    .map(c => c instanceof Node ? c : document.createTextNode(String(c))))
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false && !(k in el)) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value' || typeof v === 'boolean') el[k] = v
    else el.setAttribute(k, String(v))
  }
  return el
}

const ICON = {
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  store: 'M4 10h16l-1.5-5h-13zM5 10v10h14V10M10 20v-5h4v5',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 7.6 20 19M8.6 16.4 20 5',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
}
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'icon')
  path.setAttribute('d', ICON[name])
  svg.append(path)
  return svg
}

const page = (...children) => h('main', { class: 'page' }, children)
const section = (title, ...content) => h('section', { class: 'group' }, title && h('h2', {}, title), content)
const header = (title, ...actions) => h('header', { class: 'bar' }, h('h1', {}, title), h('div', { class: 'actions' }, actions))
const textButton = (label, onclick, cls = 'link') => h('button', { type: 'button', class: cls, onclick }, label)
const plural = n => n === 1 ? '1 appuntamento' : `${n} appuntamenti`

/** Alerts and action menus. Each gets its own <dialog>, so a queued one never receives the previous one's events. */
let alerts = Promise.resolve()
function showAlert(title, text, buttons = [{ label: 'OK', value: true }]) {
  const list = buttons.filter(Boolean)
  const show = () => new Promise(resolve => {
    let settled = false
    const dlg = h('dialog', { class: 'alert' })
    const finish = value => { if (settled) return; settled = true; if (dlg.open) dlg.close(); resolve(value) }
    dlg.append(h('div', { class: 'alert-box' }, title && h('h2', {}, title), text && h('p', {}, text),
      h('div', { class: list.length > 2 ? 'alert-buttons vertical' : 'alert-buttons' }, list.map(b =>
        h('button', { type: 'button', class: ['alert-button', b.destructive && 'danger', b.cancel && 'cancel'].filter(Boolean).join(' '),
          onclick: () => { b.action?.(); finish(b.value ?? null) } }, b.label)))))
    dlg.addEventListener('close', () => { dlg.remove(); finish(list.find(b => b.cancel)?.value ?? null) })
    dlg.addEventListener('click', e => { if (e.target === dlg && list.some(b => b.cancel)) dlg.close() })
    document.body.append(dlg)
    dlg.showModal()
  })
  const result = alerts.then(show)
  alerts = result.catch(() => {})
  return result
}
const confirmBox = (title, text, label) =>
  showAlert(title, text, [{ label, value: true, destructive: true }, { label: 'Annulla', value: false, cancel: true }])

/** Sheets (forms over the current screen). `build` is called again by renderSheet() after a change. */
let sheet = null
function openSheet(build, onClose) {
  closeSheet()
  const dlg = h('dialog', { class: 'sheet' })
  sheet = { dlg, build }
  dlg.addEventListener('close', () => { dlg.remove(); if (sheet?.dlg === dlg) sheet = null; onClose?.() })
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close() })
  document.body.append(dlg)
  renderSheet()
  dlg.showModal()
}
function renderSheet() { sheet?.dlg.replaceChildren(sheet.build()) }
function closeSheet() { sheet?.dlg.close() }
const sheetPage = (title, actions, ...content) =>
  h('div', { class: 'sheet-page' }, header(title, actions), h('div', { class: 'sheet-body' }, content))
const closeButton = () => textButton('Chiudi', closeSheet)

// MARK: Screens

function render() { document.getElementById('app').replaceChildren(view()) }

function view() {
  if (S.phase === 'loading') return h('main', { class: 'hero' }, h('p', { class: 'secondary' }, 'Caricamento…'))
  if (S.phase === 'failed') return h('main', { class: 'hero' }, h('h1', {}, 'Impossibile caricare'),
    h('p', { class: 'secondary' }, S.failMessage), textButton('Riprova', load, 'primary'), textButton(switchRoleLabel(), switchRole))
  if (S.role === 'owner') {
    if (!S.signedIn || S.ownerSignInRequired) return ownerSignInView()
    if (!S.shop) return setupView()
    return tabs('owner', [['agenda', 'Agenda', 'calendar', agendaView], ['settings', 'Negozio', 'store', settingsView]])
  }
  if (S.role === 'customer') {
    if (!S.shop) return shopPickerView()
    return tabs('customer', [['book', 'Prenota', 'scissors', bookView], ['mine', 'Le mie', 'list', mineView]])
  }
  return roleChoiceView()
}

function tabs(role, items) {
  const current = S.tab[role]
  return h('div', { class: 'tabbed' }, items.find(i => i[0] === current)[3](),
    h('nav', { class: 'tabbar', 'aria-label': 'Sezioni' }, items.map(([id, label, glyph]) =>
      h('button', { type: 'button', class: id === current ? 'tab active' : 'tab', 'aria-current': id === current ? 'page' : null,
        onclick: () => { S.tab[role] = id; render(); enterTab(); scrollTo(0, 0) } }, icon(glyph), h('span', {}, label)))))
}

/** Loads what the visible tab shows (SwiftUI's .task on each tab). */
function enterTab() {
  if (S.phase !== 'ready' || !S.shop) return
  const tab = S.tab[S.role]
  if (S.role === 'customer' && tab === 'mine') reloadMine()
  if (S.role === 'customer' && tab === 'book') { S.form ??= newForm(false); loadSlots(S.form, render) }
  if (agendaVisible()) reloadAgenda()
}

/** First screen: the user says whether they are a customer or the owner. Stored in this browser. */
function roleChoiceView() {
  const role = (title, subtitle, glyph, onclick) => h('button', { type: 'button', class: 'role card', onclick },
    icon(glyph), h('span', { class: 'role-text' }, h('strong', {}, title), h('span', { class: 'secondary' }, subtitle)), icon('right'))
  return h('main', { class: 'hero' },
    h('img', { src: 'icon-512.png', alt: '', class: 'logo', width: '96', height: '96' }),
    h('h1', {}, 'BarberBook'),
    h('p', { class: 'secondary' }, "Come vuoi usare l'app?"),
    h('div', { class: 'stack' },
      role('Sono un cliente', 'Prenota e gestisci i tuoi appuntamenti', 'person', () => setRole('customer')),
      role('Sono il titolare', "Crea il tuo negozio e gestisci l'agenda", 'store', () => setRole('owner'))),
    h('p', { class: 'footnote secondary' }, 'Puoi cambiare profilo in qualsiasi momento.'))
}

/** Customer: open a shop by its code. The QR code in the shop opens the site already on the shop. */
function shopPickerView() {
  let code = ''
  const open = h('button', { type: 'submit', class: 'primary', disabled: true }, 'Apri il negozio')
  return page(header('Il tuo negozio', textButton(switchRoleLabel(), switchRole)),
    h('form', { onsubmit: e => { e.preventDefault(); if (code.trim().length >= 4) openShop(code) } },
      section(null, h('div', { class: 'card' }, h('input', { class: 'code-input', placeholder: 'Codice del negozio',
        'aria-label': 'Codice del negozio', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: false,
        maxlength: '12', oninput: e => { code = e.target.value; open.disabled = code.trim().length < 4 } })),
      h('p', { class: 'footer' }, demo ? 'Demo: usa il codice BARBA2.'
        : 'Il codice te lo dà il negozio. Puoi anche inquadrare il QR del negozio con la fotocamera del telefono.')),
      open))
}

/** Google. Supabase receives the account's email and name; the shops never see them. */
const signInButtons = () => h('div', { class: 'stack' },
  textButton('Continua con Google', signInWithGoogle, 'secondary-button'),
  h('p', { class: 'footnote secondary' }, 'Con Google il server riceve email e nome del tuo account Google.'))

/** Owner: Google. The account only links the owner to their shop. */
function ownerSignInView() {
  return h('main', { class: 'hero' }, icon('store'), h('h1', {}, 'Accesso titolare'),
    h('p', { class: 'secondary' }, 'Accedi per creare o gestire il tuo negozio.'),
    signInButtons(),
    demo && textButton('Entra nella demo', () => { setOwnerSignInRequired(false); render(); enterTab() }, 'secondary-button'),
    textButton(switchRoleLabel(), switchRole))
}

/** Customer, optional: an account only lets them find their bookings again on another phone or computer. */
function customerSignIn() {
  openSheet(() => sheetPage('Accedi', closeButton(), h('div', { class: 'hero inset' }, icon('person'),
    h('p', { class: 'secondary' }, 'Non serve per prenotare. Con un account ritrovi le tue prenotazioni anche su un altro telefono o computer; quelle già fatte restano tue.'),
    signInButtons(), textButton('Non ora', closeSheet))))
}

function setupView() {
  let name = ''
  const create = h('button', { type: 'submit', class: 'primary', disabled: true }, 'Crea il negozio')
  const menu = () => showAlert(null, null, [{ label: 'Esci', value: 'out' }, { label: switchRoleLabel(), value: 'switch' },
    { label: 'Annulla', cancel: true }]).then(v => v === 'out' ? signOut() : v === 'switch' && switchRole())
  return page(header('Nuovo negozio', textButton('Account', menu)),
    h('form', { onsubmit: e => { e.preventDefault(); if (name.trim()) createShop(name.trim()) } },
      section(null, h('div', { class: 'card' }, 'Crea il tuo negozio. Riceverai un codice e un QR da dare ai clienti: lo inquadrano e prenotano subito da te.')),
      section('Nome del negozio', h('div', { class: 'card' }, h('input', { placeholder: 'Es. Barberia Da Mario', 'aria-label': 'Nome del negozio',
        maxlength: '80', oninput: e => { name = e.target.value; create.disabled = !name.trim() } }))),
      create))
}

/** Account menu, top right of every tab, for customers and owners alike. Everyday actions first, account next,
 *  the destructive one last. Owners have no "Cambia negozio": an account owns exactly one shop. */
async function accountMenu(isOwner) {
  const choice = await showAlert('Account', null, [
    !isOwner && { label: 'Cambia negozio', value: 'leave' },
    { label: switchRoleLabel(), value: 'switch' },
    S.signedIn ? { label: "Esci dall'account", value: 'out' } : { label: 'Accedi con Google', value: 'in' },
    { label: isOwner ? 'Elimina account e negozio' : 'Elimina i miei dati', value: 'delete', destructive: true },
    { label: 'Annulla', cancel: true },
  ])
  if (choice === 'leave') leaveShop()
  if (choice === 'switch') switchRole()
  if (choice === 'out') signOut()
  if (choice === 'in') customerSignIn()
  if (choice === 'delete' && await confirmBox(isOwner ? 'Eliminare account e negozio?' : 'Eliminare i tuoi dati?',
    isOwner ? 'Vengono cancellati il negozio, operatori, servizi e tutte le prenotazioni dei clienti. Non si può annullare.'
      : 'Le tue prenotazioni vengono cancellate e i negozi non vedranno più il tuo nome. Non si può annullare.',
    isOwner ? 'Elimina tutto' : 'Elimina') && await deleteAccount()) setRole('')
}
const accountButton = isOwner => textButton('Account', () => accountMenu(isOwner))

// MARK: Booking form (customers book for themselves, the owner for a walk-in or a phone call)

const newForm = isOwner => ({ isOwner, serviceID: S.services[0]?.id, staffID: S.staff[0]?.id, day: startOfDay(new Date()),
  slots: [], slot: null, name: isOwner ? '' : NAME.get() ?? '', saving: false, request: 0 })

function bookView() { return page(header('Prenota', accountButton(false)), bookingForm(S.form ??= newForm(false), render)) }

function bookingForm(f, rerender) {
  if (!S.services.length || !S.staff.length) return section(null, h('div', { class: 'card' }, 'Il negozio non ha ancora pubblicato servizi e operatori. Riprova più tardi.'))
  const change = patch => { Object.assign(f, patch); rerender(); loadSlots(f, rerender) }
  const row = (label, control) => h('label', { class: 'row' }, h('span', {}, label), control)
  const book = h('button', { type: 'button', class: 'primary', disabled: !f.name.trim() || f.saving, onclick: () => confirmBooking(f, rerender) },
    f.saving ? 'Prenotazione in corso…' : f.slot && `Prenota alle ${time(f.slot)}`)
  return h('div', { class: 'booking' },
    section('Appuntamento', h('div', { class: 'card rows' },
      row('Servizio', h('select', { value: f.serviceID, onchange: e => change({ serviceID: e.target.value }) },
        S.services.map(s => h('option', { value: s.id }, `${s.name} · ${s.minutes} min · ${formatPrice(s.price_cents)}`)))),
      S.staff.length > 1 && row('Operatore', h('select', { value: f.staffID, onchange: e => change({ staffID: e.target.value }) },
        S.staff.map(s => h('option', { value: s.id }, s.name)))),
      row('Giorno', h('input', { type: 'date', required: true, min: dayValue(new Date()), value: dayValue(f.day),
        onchange: e => e.target.value && change({ day: parseDay(e.target.value) }) })))),
    // The name has its own card and title, so it is clear the customer must type it.
    section(f.isOwner ? 'Cliente' : 'Il tuo nome', h('div', { class: 'card' }, h('input', {
      placeholder: f.isOwner ? 'Nome del cliente' : 'Scrivi qui il tuo nome', 'aria-label': f.isOwner ? 'Nome del cliente' : 'Il tuo nome',
      autocomplete: f.isOwner ? 'off' : 'name', maxlength: '60', value: f.name,
      oninput: e => { f.name = e.target.value; book.disabled = !f.name.trim() || f.saving } })),
      !f.isOwner && h('p', { class: 'footer' }, "Il nome è visibile solo a te e al negozio. Dopo la prenotazione puoi aggiungerla al calendario, con un promemoria un'ora prima.")),
    section('Orari liberi', h('div', { class: 'card slots' }, f.slots.length
      ? h('div', { class: 'slot-grid' }, f.slots.map(s => {
          const selected = f.slot?.getTime() === s.getTime()
          return h('button', { type: 'button', class: selected ? 'slot selected' : 'slot', 'aria-pressed': String(selected),
            onclick: () => { f.slot = s; rerender() } }, time(s))
        }))
      : h('p', { class: 'secondary' }, 'Nessun orario libero in questo giorno.'))),
    f.slot && h('div', { class: 'bookbar' }, book))
}

async function loadSlots(f, rerender) {
  const service = S.services.find(s => s.id === f.serviceID), request = ++f.request
  if (!service || !f.staffID || !S.shop) { f.slots = []; f.slot = null; rerender(); return }
  const intervals = await busy(f.staffID, f.day)
  if (request !== f.request) return // a newer choice replaced this one
  f.slots = freeStarts(f.day, S.shop.week, service.minutes, intervals, new Date())
  if (f.slot && !f.slots.some(s => s.getTime() === f.slot.getTime())) f.slot = null // a refresh keeps a time still free
  rerender()
}

/** Hours, staff and services from the server, then the free times. Keeps the choices that still exist. */
async function refreshForm(f, rerender) {
  await refreshShop()
  if (!S.services.some(s => s.id === f.serviceID)) f.serviceID = S.services[0]?.id
  if (!S.staff.some(s => s.id === f.staffID)) f.staffID = S.staff[0]?.id
  await loadSlots(f, rerender)
}

async function confirmBooking(f, rerender) {
  const service = S.services.find(s => s.id === f.serviceID)
  if (!service || !f.staffID || !f.slot || f.saving) return
  f.saving = true
  rerender()
  const customer = f.name.trim()
  const booking = await book(service, f.staffID, f.slot, customer, f.isOwner)
  f.saving = false
  if (!booking) return refreshForm(f, rerender) // refused (slot taken, service or hours changed): show what is bookable now
  if (!f.isOwner) NAME.set(customer)
  loadSlots(f, rerender)
  await showAlert('Prenotazione confermata', `${booking.service_name} con ${staffName(booking.staff_id)}, ${fullDate(booking.starts_at)}.`,
    f.isOwner ? [{ label: 'OK' }] : [{ label: 'Aggiungi al calendario', action: () => addToCalendar(booking) }, { label: 'OK' }])
  if (f.isOwner) closeSheet()
}

// MARK: Booking cards

/** A booking at a glance: day, time, name, service and price. Actions from ⋯. */
function bookingCard(b, { showShop, cancelTitle, onCancel, calendar = false }) {
  const price = bookingPrice(b)
  const actions = async () => {
    const choice = await showAlert(null, null, [calendar && { label: 'Aggiungi al calendario', action: () => addToCalendar(b) },
      { label: cancelTitle, value: 'cancel', destructive: true }, { label: 'Chiudi', cancel: true }])
    if (choice === 'cancel') onCancel(b)
  }
  return h('article', { class: 'card booking-card' },
    h('div', { class: 'split' }, h('span', { class: 'accent strong' }, longDay(b.starts_at)),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Azioni', onclick: actions }, icon('more'))),
    h('div', { class: 'big' }, `${time(b.starts_at)} – ${time(b.ends_at)}`),
    h('div', { class: 'strong' }, b.customer_name),
    h('div', { class: 'split' }, h('span', {}, b.service_name), price && h('span', { class: 'strong' }, price)),
    h('div', { class: 'secondary small' }, [`con ${b.staff?.name ?? staffName(b.staff_id)}`, showShop && b.shops?.name].filter(Boolean).join(' · ')))
}

/** Customer: future bookings in every shop as cards, cancel from the card. */
function mineView() {
  return page(header('Le mie prenotazioni', accountButton(false)), S.mine.length
    ? h('div', { class: 'card-grid' }, S.mine.map(b => bookingCard(b, { showShop: true, cancelTitle: 'Disdici', calendar: true, onCancel: cancelMine })))
    : h('p', { class: 'empty secondary' }, 'Nessuna prenotazione futura.'))
}

async function reloadMine() { S.mine = await myBookings(); render() }

async function cancelMine(b) {
  const yes = await showAlert('Disdire la prenotazione?', `${b.service_name}, ${shortDate(b.starts_at)}`,
    [{ label: 'Disdici', value: true, destructive: true }, { label: 'No', value: false, cancel: true }])
  if (yes && await cancel(b)) reloadMine()
}

// MARK: Owner agenda

/** Five days at a glance. Each appointment shows only that the slot is taken and the service; tap it for the
 *  customer's name, price and cancel. Wide screens: one column per day. Phones: a five-day strip with counts,
 *  then the days one below the other. Both are in the page; CSS shows one. */
function agendaView() {
  const { start, bookings } = S.agenda
  const days = Array.from({ length: SPAN }, (_, i) => addDays(start, i))
  const on = day => bookings.filter(b => sameDay(b.starts_at, day))
  const today = new Date()
  const title = (day, compact) => {
    const count = on(day).length
    return h('div', { class: 'day-title' },
      h('h3', { class: sameDay(day, today) ? 'accent' : null },
        compact ? day.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric' }) : longDay(day)),
      h('span', { class: 'caption secondary' }, count === 0 ? 'Nessun appuntamento' : plural(count)))
  }
  const slots = day => {
    const list = on(day)
    return [!list.length && h('p', { class: 'secondary small' }, 'Libero'), list.map(b =>
      h('button', { type: 'button', class: 'agenda-slot', title: 'Mostra cliente, prezzo e annullamento', onclick: () => openDetail(b) },
        h('span', { class: 'strong small mono' }, `${time(b.starts_at)} – ${time(b.ends_at)}`),
        h('span', { class: 'secondary small' }, b.service_name)))]
  }
  return page(
    header('Agenda', accountButton(true),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Nuovo appuntamento', onclick: newAppointment }, icon('plus'))),
    h('div', { class: 'card period' },
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Giorni precedenti', onclick: () => moveAgenda(addDays(start, -SPAN)) }, icon('left')),
      h('input', { type: 'date', 'aria-label': 'Dal', value: dayValue(start), onchange: e => e.target.value && moveAgenda(parseDay(e.target.value)) }),
      h('span', { class: 'secondary' }, `– ${days.at(-1).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Giorni successivi', onclick: () => moveAgenda(addDays(start, SPAN)) }, icon('right')),
      h('span', { class: 'spacer' }),
      !sameDay(start, today) && textButton('Oggi', () => moveAgenda(startOfDay(new Date())))),
    h('div', { class: 'agenda-columns' }, days.map(day => h('section', { class: 'card day' }, title(day, true), slots(day)))),
    h('div', { class: 'agenda-narrow' },
      h('div', { class: 'overview' }, days.map(day => {
        const count = on(day).length
        return h('button', { type: 'button', class: sameDay(day, today) ? 'overview-day today' : 'overview-day',
          'aria-label': `${longDay(day)}, ${plural(count)}`,
          onclick: () => document.getElementById(`day-${dayValue(day)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          h('span', { class: 'caption upper' }, day.toLocaleDateString('it-IT', { weekday: 'short' })),
          h('span', { class: 'num' }, day.getDate()),
          h('span', { class: count ? 'caption strong accent' : 'caption secondary' }, count || '–'))
      })),
      days.map(day => h('section', { class: 'card day', id: `day-${dayValue(day)}` }, title(day, false), slots(day)))))
}

function moveAgenda(start) { S.agenda.start = start; render(); reloadAgenda() }

async function reloadAgenda(quiet = false) {
  const start = S.agenda.start
  const list = await agendaBookings(start, SPAN, quiet)
  if (list && start === S.agenda.start) { S.agenda.bookings = list; render() }
}

const agendaVisible = () => S.phase === 'ready' && S.role === 'owner' && S.signedIn && !S.ownerSignInRequired && S.shop
  && S.tab.owner === 'agenda'

function newAppointment() {
  const f = newForm(true)
  openSheet(() => sheetPage('Nuovo appuntamento', closeButton(), bookingForm(f, renderSheet)), () => reloadAgenda())
  loadSlots(f, renderSheet)
}

/** One appointment in full (customer, service, price, staff), with cancel. */
function openDetail(b) {
  openSheet(() => sheetPage('Appuntamento', closeButton(), bookingCard(b, { showShop: false, cancelTitle: 'Annulla appuntamento',
    onCancel: async () => {
      if (await confirmBox("Annullare l'appuntamento?", `${b.customer_name}, ${shortDate(b.starts_at)}`, 'Annulla appuntamento')
        && await cancel(b)) { closeSheet(); reloadAgenda() }
    } })))
}

// MARK: Owner shop settings

let qrCache = { link: '', src: '' }

/** Owner: customer code and QR, opening hours, staff, services. Account actions are in the Account menu. */
function settingsView() {
  const shop = S.shop
  const link = shopLink(shop.code)
  if (qrCache.link !== link) qrCache = { link, src: qrDataURL(link) }
  const add = h('button', { type: 'button', class: 'link', disabled: !S.newStaff.trim(), onclick: () => {
    const name = S.newStaff.trim()
    S.newStaff = ''
    saveStaff({ id: crypto.randomUUID(), shop_id: shop.id, name })
  } }, 'Aggiungi')
  return page(header(shop.name, accountButton(true)),
    section('Codice per i clienti', h('div', { class: 'card qr printable' },
      h('img', { src: qrCache.src, alt: 'Codice QR del negozio', class: 'qr-image', width: '200', height: '200' }),
      h('div', { class: 'code-big' }, shop.code),
      h('p', { class: 'print-only' }, shop.name),
      h('div', { class: 'qr-actions' }, textButton('Condividi il QR', () => shareQR(shop)), textButton('Stampa', () => print()))),
      h('p', { class: 'footer' }, "Mettilo in negozio: i clienti lo inquadrano con la fotocamera del telefono e prenotano dal browser, senza installare nulla. Oppure scrivono il codice nella pagina.")),
    section('Negozio', h('div', { class: 'card rows' }, h('button', { type: 'button', class: 'row row-link', onclick: openHours },
      h('span', {}, 'Nome e orari di apertura'), icon('right')))),
    section('Operatori', h('div', { class: 'card rows' },
      S.staff.map(m => h('div', { class: 'row' }, h('span', {}, m.name),
        h('button', { type: 'button', class: 'link danger', 'aria-label': `Elimina ${m.name}`, onclick: () => removeStaff(m) }, 'Elimina'))),
      h('div', { class: 'row' }, h('input', { placeholder: 'Nuovo operatore', 'aria-label': 'Nuovo operatore', maxlength: '60', value: S.newStaff,
        oninput: e => { S.newStaff = e.target.value; add.disabled = !S.newStaff.trim() },
        onkeydown: e => { if (e.key === 'Enter' && !add.disabled) add.click() } }), add))),
    section('Servizi', h('div', { class: 'card rows' },
      S.services.map(s => h('div', { class: 'row' },
        h('button', { type: 'button', class: 'row-link grow', onclick: () => openService(s) },
          h('span', {}, s.name), h('span', { class: 'secondary' }, `${s.minutes} min · ${formatPrice(s.price_cents)}`)),
        h('button', { type: 'button', class: 'link danger', 'aria-label': `Elimina ${s.name}`, onclick: () => removeService(s) }, 'Elimina'))),
      h('button', { type: 'button', class: 'row row-link accent',
        onclick: () => openService({ id: crypto.randomUUID(), shop_id: shop.id, name: '', minutes: 30, price_cents: 1500 }) }, 'Aggiungi servizio'))))
}

/** The system share sheet with the QR image where the browser offers it (phones), a download elsewhere. */
async function shareQR(shop) {
  const bytes = Uint8Array.from(atob(qrCache.src.split(',')[1]), c => c.charCodeAt(0))
  const file = new File([bytes], `QR ${shop.name}.png`, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `QR ${shop.name}` }) } catch {} // closed the share sheet
    return
  }
  const link = h('a', { href: qrCache.src, download: file.name })
  document.body.append(link); link.click(); link.remove()
}

async function removeStaff(member) {
  const count = await upcomingBookings(member.id)
  if (count == null) return
  if (await confirmBox(`Eliminare ${member.name}?`, count === 0 ? 'Non ha appuntamenti in programma.'
    : `Ha ${plural(count)} in programma: verranno annullati e spariranno da "Le mie prenotazioni" dei clienti. Avvisali tu.`,
  count === 0 ? 'Elimina' : `Elimina e annulla ${plural(count)}`)) deleteRow('staff', member.id)
}

async function removeService(service) {
  if (await confirmBox(`Eliminare ${service.name}?`, 'Le prenotazioni già fatte restano valide.', 'Elimina')) deleteRow('services', service.id)
}

function openService(service) {
  const draft = { ...service }
  let price = (service.price_cents / 100).toFixed(2).replace('.', ',')
  const durations = [...new Set([...Array.from({ length: 240 / STEP }, (_, i) => (i + 1) * STEP), draft.minutes])].sort((a, b) => a - b)
  openSheet(() => {
    const save = h('button', { type: 'button', class: 'link strong', onclick: async () => {
      const c = cents(price)
      if (c == null || !draft.name.trim()) return
      if (await saveService({ ...draft, name: draft.name.trim(), price_cents: c })) { closeSheet(); render() }
    } }, 'Salva')
    const check = () => { save.disabled = !draft.name.trim() || cents(price) == null }
    check()
    return sheetPage(service.name || 'Nuovo servizio', [textButton('Annulla', closeSheet), save],
      h('div', { class: 'card rows' },
        h('label', { class: 'row' }, h('span', {}, 'Nome'), h('input', { class: 'end', placeholder: 'es. Taglio', maxlength: '80', value: draft.name,
          oninput: e => { draft.name = e.target.value; check() } })),
        h('label', { class: 'row' }, h('span', {}, 'Durata'), h('select', { value: String(draft.minutes), onchange: e => { draft.minutes = Number(e.target.value) } },
          durations.map(m => h('option', { value: String(m) }, `${m} min`)))),
        h('label', { class: 'row' }, h('span', {}, 'Prezzo (€)'), h('input', { class: 'end', inputmode: 'decimal', placeholder: 'es. 15,00', value: price,
          oninput: e => { price = e.target.value; check() } }))))
  })
}

function openHours() {
  const draft = { ...S.shop, week: S.shop.week.map(d => d && { ...d }) }
  const order = [1, 2, 3, 4, 5, 6, 0] // Monday first, as in Italy. Indexes follow Date.getDay().
  const names = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato']
  const times = Array.from({ length: (23 - 6) * 60 / STEP + 1 }, (_, i) => 6 * 60 + i * STEP)
  const valid = () => draft.name.trim() && draft.week.every(d => !d || d.close > d.open)
  const timeSelect = (value, set) => h('select', { value: String(value), onchange: e => { set(Number(e.target.value)); renderSheet() } },
    times.map(t => h('option', { value: String(t) }, hhmm(t))))
  openSheet(() => {
    const save = h('button', { type: 'button', class: 'link strong', disabled: !valid(), onclick: async () => {
      if (valid() && await saveShop({ ...draft, name: draft.name.trim() })) { closeSheet(); render() }
    } }, 'Salva')
    return sheetPage('Orari', [textButton('Annulla', closeSheet), save],
      section('Nome', h('div', { class: 'card' }, h('input', { 'aria-label': 'Nome del negozio', maxlength: '80', value: draft.name,
        oninput: e => { draft.name = e.target.value; save.disabled = !valid() } }))),
      order.map(i => {
        const d = draft.week[i]
        return section(null, h('div', { class: 'card rows' },
          h('label', { class: 'row' }, h('span', {}, names[i]), h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !!d,
            onchange: e => { draft.week[i] = e.target.checked ? { open: 9 * 60, close: 19 * 60 } : null; renderSheet() } })),
          d && h('label', { class: 'row' }, h('span', {}, 'Apertura'), timeSelect(d.open, v => { d.open = v })),
          d && h('label', { class: 'row' }, h('span', {}, 'Chiusura'), timeSelect(d.close, v => { d.close = v })),
          d && d.close <= d.open && h('p', { class: 'row danger' }, "La chiusura deve essere dopo l'apertura.")))
      }))
  })
}

// MARK: Demo

/** In-memory shop for demo mode: code BARBA2, 2 staff, 3 services, sample bookings in the next days. */
function demoData() {
  const shop = { id: 'demo-shop', code: 'BARBA2', name: 'Barberia Demo', week: defaultWeek() }
  const staff = ['Luca', 'Marco'].map(name => ({ id: `demo-${name}`, shop_id: shop.id, name }))
  const services = [['Barba', 15, 1000], ['Taglio', 30, 1500], ['Taglio e barba', 45, 2300]]
    .map(([name, minutes, price_cents]) => ({ id: `demo-${name}`, shop_id: shop.id, name, minutes, price_cents }))
  // (days from today, hour, minute, staff index, service index, customer)
  const samples = [[0, 18, 30, 0, 1, 'Cliente al banco'], [1, 9, 30, 1, 0, 'Giulia'], [1, 11, 0, 0, 1, 'Paolo'],
    [1, 16, 0, 0, 2, 'Marco R.'], [2, 10, 0, 1, 1, 'Sara'], [4, 15, 30, 0, 2, 'Luigi']]
  const today = startOfDay(new Date())
  const bookings = samples.map(([day, hour, minute, who, what, name]) => {
    const d = addDays(today, day), start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute)
    return { id: crypto.randomUUID(), shop_id: shop.id, staff_id: staff[who].id, service_name: services[what].name, customer_name: name,
      starts_at: start, ends_at: new Date(start.getTime() + services[what].minutes * 60000), staff: { name: staff[who].name }, shops: { name: shop.name } }
  })
  // Appointments made by the owner (samples, walk-ins), kept out of the customer's "Le mie prenotazioni".
  return { shop, staff, services, bookings, ownerBookings: new Set(bookings.map(b => b.id)) }
}

// MARK: Start

// New customer bookings show up by themselves while the agenda is on screen, and on return to the page.
// ponytail: polling every 2 minutes; Supabase Realtime or Web Push if owners need instant alerts.
setInterval(() => { if (agendaVisible() && document.visibilityState === 'visible') reloadAgenda(true) }, 120000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (agendaVisible()) reloadAgenda(true)
  if (S.phase === 'ready' && S.role === 'customer' && S.tab.customer === 'book' && S.form) refreshForm(S.form, render)
})

async function boot() {
  const params = new URLSearchParams(location.search)
  try {
    if (!demo && await api.finishGoogle() && S.role === 'owner') setOwnerSignInRequired(false)
  } catch (e) { handle(e) }
  // QR code scanned with the phone camera: ?shop=<CODE>
  const code = params.get('shop')
  if (code != null) {
    S.role = 'customer'
    ROLE.set('customer')
    const valid = normalizeCode(code)
    if (valid) SHOP_CODE.set(valid)
    else showAlert('Attenzione', 'Codice non valido.')
  }
  if (location.search) history.replaceState(null, '', location.pathname)
  load()
}

boot()
