// Service worker for owners' notifications only: shows what the send-push Edge Function sends (Web Push) and opens
// the site when one is tapped. No caching, no offline copy: every page load still comes from the network.
self.addEventListener('push', event => {
  let n = {}
  try { n = event.data?.json() ?? {} } catch {}
  event.waitUntil(self.registration.showNotification(n.title || 'BarberBook', {
    body: n.body || '', icon: 'icon-512.png', lang: 'it',
    tag: n.kind === 'summary' ? 'summary' : undefined, // a newer summary replaces the previous one
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.length ? list[0].focus() : clients.openWindow('./')))
})
