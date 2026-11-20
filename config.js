// Supabase project the web app talks to. Same project as the iPhone app, so both see the same shops.
// The publishable key is made to ship inside apps and web pages: it only names the project, access is decided by
// the Row Level Security policies in supabase/schema.sql. Never put the service_role / sb_secret_ key here.
export const SUPABASE_URL = 'https://mhhajacrybeuqilyqjhe.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_cBO7CrIDzOwU73x24i3wMA_cPRk0hYv'
// Web Push for owners: the public half of the VAPID key pair; the private half is a secret of the send-push function.
export const VAPID_PUBLIC_KEY = 'BAFpMalxY-IWAr6CBk-udO74M2uAslES2BTNCd9vS9gfrcOOTNreoOuFtXiAPwdl3ACRRJdYW3aHtelQ3aOjg8E'
// Cloudflare Turnstile before new anonymous customer accounts. Empty = off (see captchaToken in api.js).
export const TURNSTILE_SITE_KEY = ''
