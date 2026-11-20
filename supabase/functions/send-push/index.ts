// Sends the due notifications of public.notifications to owners' browsers (Web Push). Called every minute by pg_cron
// when something is due (migration 20261120120000). Deployed with verify_jwt off: it takes no input.
// Secrets (Supabase → Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. iOS and Android devices are skipped: no sender yet.
import webpush from 'npm:web-push@3.6.7'

const url = Deno.env.get('SUPABASE_URL')!
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!)

const rest = (path: string, init: RequestInit = {}) => fetch(`${url}/rest/v1/${path}`, {
  ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
})

type Due = { id: number; kind: string; title: string; body: string; devices: { token: string; platform: string }[] }

Deno.serve(async () => {
  const claimed = await rest('rpc/claim_due_notifications', { method: 'POST', body: '{}' })
  if (!claimed.ok) return new Response(await claimed.text(), { status: 502 })
  const due: Due[] = await claimed.json()
  for (const n of due) {
    let error: string | null = null
    for (const device of n.devices.filter(d => d.platform === 'web')) {
      try {
        // 12 hours: a phone offline for longer gets nothing rather than stale news.
        await webpush.sendNotification(JSON.parse(device.token), JSON.stringify({ title: n.title, body: n.body, kind: n.kind }), { TTL: 43200 })
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) { // the browser dropped the subscription
          await rest(`devices?token=eq.${encodeURIComponent(device.token)}`, { method: 'DELETE' })
        } else error = `web push ${status ?? (e as Error).message}`
      }
    }
    // Sent, or nobody to send to. On error it stays due: claim_due_notifications retries it up to 5 times.
    await rest(`notifications?id=eq.${n.id}`, { method: 'PATCH',
      body: JSON.stringify(error ? { last_error: error } : { sent_at: new Date().toISOString(), last_error: null }) })
  }
  return Response.json({ processed: due.length })
})
