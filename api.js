// Minimal Supabase client on fetch, no SDK: sessions (anonymous customers, Google owners), token refresh, REST calls.
// Port of BarberBook/Supabase.swift. Auth goes to /auth/v1, data to /rest/v1 (PostgREST). The server filters every
// row by the Row Level Security policies in supabase/schema.sql, so this client holds no authority of its own.
import { SUPABASE_URL as BASE, SUPABASE_KEY as KEY, TURNSTILE_SITE_KEY } from './config.js'

export const SESSION_EXPIRED = 'session_expired'

/** Server error. `code` is the Postgres SQLSTATE for data calls (e.g. 23P01 overlap, 42501 not allowed). */
export class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

// The sessions (tokens and user id only, no personal data) in this browser's localStorage, one per role: the customer
// is an anonymous account, the owner a Google account, and one never acts as the other. Read on every call, so two
// open tabs share one session instead of each refreshing its own.
const PKCE = 'barberbook.pkce'
const storage = {
  get(key, area = localStorage) { try { return JSON.parse(area.getItem(key)) } catch { return null } },
  set(key, value, area = localStorage) { try { value == null ? area.removeItem(key) : area.setItem(key, JSON.stringify(value)) } catch {} },
}
const sessionKey = role => `barberbook.session.${role}`
// Until 2026-11-20 one session served both roles: it goes to the role of its account.
const legacy = storage.get('barberbook.session')
if (legacy) {
  storage.set(sessionKey(legacy.user?.is_anonymous === false ? 'owner' : 'customer'), legacy)
  storage.set('barberbook.session', null)
}

let role = 'customer'
/** 'customer' or 'owner': which session the next calls use. */
export function useRole(r) { role = r === 'owner' ? 'owner' : 'customer' }

const session = (r = role) => storage.get(sessionKey(r))
function save(data, r = role) {
  storage.set(sessionKey(r), data && { access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: data.expires_at, user: { id: data.user.id, is_anonymous: data.user.is_anonymous } })
  return session(r)
}

export const user = () => session()?.user ?? null

// MARK: Google (OAuth with PKCE, the page of Supabase and Google in this same tab)

/** Where Supabase sends the browser back after Google. Must be listed in Authentication → URL Configuration. */
const callback = () => location.origin + location.pathname

const base64URL = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Owners only. Leaves the page for Google; finishGoogle() completes it on return. A plain sign-in, never linked to the
 * customer's anonymous account: the owner account and the customer account stay two different users.
 */
export async function startGoogle() {
  // PKCE: the code that comes back is useless without `verifier`, which never leaves this browser tab.
  const verifier = base64URL(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const url = new URL('auth/v1/authorize', BASE + '/')
  for (const [k, v] of [['provider', 'google'], ['redirect_to', callback()], ['code_challenge', challenge], ['code_challenge_method', 's256']])
    url.searchParams.append(k, v)
  storage.set(PKCE, { verifier }, sessionStorage)
  location.assign(url.href)
}

/**
 * On page load. Returns true after a successful Google sign-in, false when this load is not a return from Google.
 * Success: ?code=…  Failure: ?error_code=… or #error_code=…
 */
export async function finishGoogle() {
  const pending = storage.get(PKCE, sessionStorage)
  const params = new URLSearchParams(location.search + '&' + location.hash.slice(1))
  if (!pending || !(params.has('code') || params.has('error_code') || params.has('error'))) return false
  storage.set(PKCE, null, sessionStorage)
  history.replaceState(null, '', location.pathname)
  const code = params.get('code')
  if (!code) {
    const error = params.get('error_code') ?? params.get('error')
    if (error === 'access_denied') return false // closed or cancelled on Google's page
    throw new Failure(400, error, params.get('error_description') ?? 'Accesso non riuscito.')
  }
  save(await send('POST', 'auth/v1/token', { query: [['grant_type', 'pkce']],
    body: { auth_code: code, code_verifier: pending.verifier }, authorized: false }), 'owner')
  return true
}

/** Local only: the refresh token is forgotten and expires on the server by itself. */
export function signOut() { save(null) }

/**
 * Deletes the account of the current role and, through `on delete cascade`, what it owns (delete_me in the
 * 20261120120000 migration). Customer: the account and its bookings. Owner: also the shop (`withShop`); the server
 * refuses to delete an account with a shop without it.
 */
export async function deleteAccount(withShop = false) {
  await send('POST', 'rest/v1/rpc/delete_me', { body: { p_with_shop: withShop } })
  save(null)
}

// MARK: Token

const renewing = {}

/** A valid access token. Customers get an anonymous session when there is none; owners must sign in with Google. */
async function accessToken() {
  const r = role, current = session(r)
  if (current && current.expires_at > Date.now() / 1000 + 60) return current.access_token
  renewing[r] ??= renew(r).finally(() => { delete renewing[r] })
  return (await renewing[r]).access_token
}

async function renew(r) {
  const old = session(r)
  if (old) {
    try {
      return save(await send('POST', 'auth/v1/token', { query: [['grant_type', 'refresh_token']],
        body: { refresh_token: old.refresh_token }, authorized: false }), r)
    } catch (e) {
      if (!(e instanceof Failure && e.status >= 400 && e.status < 500)) throw e
      save(null, r) // revoked, or the account was deleted (e.g. idle anonymous cleanup)
    }
  }
  if (r === 'owner') throw new Failure(401, SESSION_EXPIRED, 'Sessione scaduta. Accedi di nuovo.')
  const captcha = await captchaToken()
  return save(await send('POST', 'auth/v1/signup', { authorized: false, // anonymous
    body: captcha ? { gotrue_meta_security: { captcha_token: captcha } } : {} }), r)
}

/**
 * Cloudflare Turnstile before a new anonymous account, only when TURNSTILE_SITE_KEY is set (and the secret is in
 * Supabase → Authentication → Bot and Abuse Protection). Usually invisible; sometimes it asks for one tap.
 */
let turnstile = null
async function captchaToken() {
  if (!TURNSTILE_SITE_KEY) return null
  turnstile ??= new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement('script'), {
    src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', onload: () => resolve(window.turnstile),
    onerror: () => { turnstile = null; reject(new Failure(0, 'offline', 'Nessuna connessione a Internet.')) } })))
  const ts = await turnstile
  return new Promise((resolve, reject) => {
    const box = Object.assign(document.createElement('div'), { className: 'captcha' })
    document.body.append(box)
    const done = () => box.remove()
    ts.render(box, { sitekey: TURNSTILE_SITE_KEY, language: 'it',
      callback: token => { done(); resolve(token) },
      'error-callback': () => { done(); reject(new Failure(0, 'captcha', 'Verifica anti-abuso non riuscita. Riprova.')) } })
  })
}

// MARK: Data (PostgREST)

export const select = (table, query) => send('GET', `rest/v1/${table}`, { query })

export async function insert(table, row) {
  const saved = (await send('POST', `rest/v1/${table}`, { body: row, headers: { Prefer: 'return=representation' } }))?.[0]
  if (!saved) throw new Failure(403, '42501', 'Operazione non permessa con questo account.')
  return saved
}

/** Insert or update by primary key. */
export const upsert = (table, row) => send('POST', `rest/v1/${table}`, { body: row, headers: { Prefer: 'resolution=merge-duplicates' } })
export const update = (table, id, row) => send('PATCH', `rest/v1/${table}`, { query: [['id', `eq.${id}`]], body: row })
export const remove = (table, id) => send('DELETE', `rest/v1/${table}`, { query: [['id', `eq.${id}`]] })
/** Delete every row matching PostgREST filters, e.g. [['customer_id', 'eq.…']]. */
export const removeWhere = (table, query) => send('DELETE', `rest/v1/${table}`, { query })
export const rpc = (fn, params) => send('POST', `rest/v1/rpc/${fn}`, { body: params })

// MARK: HTTP

async function send(method, path, { query = [], body, headers = {}, authorized = true } = {}) {
  const url = new URL(path, BASE + '/')
  // URLSearchParams encodes "+" as %2B, which PostgREST would otherwise read as a space (e.g. in "+01:00").
  query.forEach(([k, v]) => url.searchParams.append(k, v))
  const all = { apikey: KEY, 'Content-Type': 'application/json', ...headers }
  if (authorized) all.Authorization = `Bearer ${await accessToken()}`
  let response
  try {
    response = await fetch(url, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new Failure(0, 'offline', 'Nessuna connessione a Internet.')
  }
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) {
    // PostgREST: {code, message}. Auth: {code: <HTTP status number>, error_code, msg} or {error, error_description}.
    const j = json ?? {}
    throw new Failure(response.status, typeof j.code === 'string' ? j.code : j.error_code ?? j.error,
      j.message ?? j.msg ?? j.error_description ?? `Errore del server (${response.status}).`)
  }
  return json
}
