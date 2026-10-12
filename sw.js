// Offline support. Bump CACHE_VERSION on every deploy so phones pick up the new build.
const CACHE_VERSION = "tst-beta-2026-10-12-4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./beta-config.js",
  "./beta-cloud.js",
  "./beta-cloud.css",
  "./vendor/supabase.js",
  "./vendor/qrcode.js",
  "./welcome.html",
  "./privacy.html",
  "./reset.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Only handle our own static files; Supabase API calls go straight to the network.
  if (url.origin !== self.location.origin) return;

  const isPage = request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  event.respondWith(isPage ? networkFirst(request) : staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(request)) || (await cache.match("./index.html")) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || refresh;
}
