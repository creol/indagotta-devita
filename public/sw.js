/**
 * A deliberately minimal service worker.
 * ---------------------------------------------------------------------------
 * It exists so the app is installable as a PWA and so the shell still opens
 * without a network connection. It does NOT try to be clever about caching.
 *
 * Two rules:
 *   1. /api/* is never cached -- song recognition always needs the network.
 *   2. Everything else is served from the cache first, and refreshed in the
 *      background for next time ("stale-while-revalidate").
 */

const CACHE_NAME = 'singalong-v1'

// The bare minimum needed to render something when offline.
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // addAll fails as a unit, so a single 404 would break installation.
      // Adding entries individually keeps the worker resilient.
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Rule 1: never cache API calls or anything cross-origin.
  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Rule 2: stale-while-revalidate for the app itself.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(
          () =>
            // Offline with nothing cached: respondWith() must still get a
            // Response, otherwise the browser reports a network error.
            cached ||
            new Response('You are offline.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            }),
        )

      return cached || network
    }),
  )
})
