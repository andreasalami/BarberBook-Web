// Minimal Supabase client on fetch, no SDK: sessions (anonymous or Google), token refresh, REST calls.
// Port of BarberBook/Supabase.swift. Auth goes to /auth/v1, data to /rest/v1 (PostgREST). The server filters every
// row by the Row Level Security policies in supabase/schema.sql, so this client holds no authority of its own.
import { SUPABASE_URL as BASE, SUPABASE_KEY as KEY } from './config.js'

export const SESSION_EXPIRED = 'session_expired'

/** Server error. `code` is the Postgres SQLSTATE for data calls (e.g. 23P01 overlap, 42501 not allowed). */
export class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

// The session (tokens and user id only, no personal data) in this browser's localStorage. Read on every call, so
// two open tabs share one session instead of each refreshing its own.
const SESSION = 'barberbook.session', PKCE = 'barberbook.pkce'
const storage = {
  get(key, area = localStorage) { try { return JSON.parse(area.getItem(key)) } catch { return null } },
  set(key, value, area = localStorage) { try { value == null ? area.removeItem(key) : area.setItem(key, JSON.stringify(value)) } catch {} },
}
const session = () => storage.get(SESSION)
function save(data) {
  storage.set(SESSION, data && { access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: data.expires_at, user: { id: data.user.id, is_anonymous: data.user.is_anonymous } })
  return session()
}

export const user = () => session()?.user ?? null

// MARK: Google (OAuth with PKCE, the page of Supabase and Google in this same tab)

/** Where Supabase sends the browser back after Google. Must be listed in Authentication → URL Configuration. */
const callback = () => location.origin + location.pathname

const base64URL = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Leaves the page for Google. An anonymous user (a customer who already booked) is upgraded in place: the Google
 * identity is linked to the same user, so their bookings stay theirs. finishGoogle() completes it on return.
 */
export async function startGoogle(linking = session()?.user.is_anonymous !== false) {
  // PKCE: the code that comes back is useless without `verifier`, which never leaves this browser tab.
  const verifier = base64URL(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const query = [['provider', 'google'], ['redirect_to', callback()], ['code_challenge', challenge], ['code_challenge_method', 's256']]
  let start
  if (linking) { // the server needs to know who is linking, so it answers with the URL instead of redirecting
    query.push(['skip_http_redirect', 'true'])
    start = (await send('GET', 'auth/v1/user/identities/authorize', { query }))?.url
    if (!start) throw new Failure(502, null, 'Risposta inattesa dal server.')
  } else {
    const url = new URL('auth/v1/authorize', BASE + '/')
    query.forEach(([k, v]) => url.searchParams.append(k, v))
    start = url.href
  }
  storage.set(PKCE, { verifier, linking }, sessionStorage)
  location.assign(start)
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
    // That Google account already has a user: sign in to it instead (anonymous bookings stay with the anonymous user).
    if (error === 'identity_already_exists' && pending.linking) { await startGoogle(false); return false }
    if (error === 'access_denied') return false // closed or cancelled on Google's page
    throw new Failure(400, error, params.get('error_description') ?? 'Accesso non riuscito.')
  }
  save(await send('POST', 'auth/v1/token', { query: [['grant_type', 'pkce']],
    body: { auth_code: code, code_verifier: pending.verifier }, authorized: false }))
  return true
}

/** Local only: the refresh token is forgotten and expires on the server by itself. */
export function signOut() { save(null) }

/** Deletes the account and, through `on delete cascade`, everything it owns (see delete_me in schema.sql). */
export async function deleteAccount() {
  await send('POST', 'rest/v1/rpc/delete_me', { body: {} })
  save(null)
}

// MARK: Token

let renewing = null

/** A valid access token. Creates an anonymous session when there is none, refreshes it when it is about to expire. */
async function accessToken() {
  const current = session()
  if (current && current.expires_at > Date.now() / 1000 + 60) return current.access_token
  renewing ??= renew().finally(() => { renewing = null })
  return (await renewing).access_token
}

async function renew() {
  const old = session()
  if (old) {
    try {
      return save(await send('POST', 'auth/v1/token', { query: [['grant_type', 'refresh_token']],
        body: { refresh_token: old.refresh_token }, authorized: false }))
    } catch (e) {
      if (!(e instanceof Failure && e.status >= 400 && e.status < 500)) throw e
      save(null) // revoked, or the account was deleted (e.g. idle anonymous cleanup)
      if (old.user.is_anonymous !== true) throw new Failure(401, SESSION_EXPIRED, 'Sessione scaduta. Accedi di nuovo.')
    }
  }
  return save(await send('POST', 'auth/v1/signup', { body: {}, authorized: false })) // anonymous
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
