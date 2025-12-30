// NCOP PWA Service Worker
// Version: 1.0.0

const CACHE_NAME = 'ncop-cache-v1';
const RUNTIME_CACHE = 'ncop-runtime-v1';

// Assets to cache on install
const PRECACHE_URLS = [
  '/',
  '/offline/',
  '/manifest.json',
];

// Cache strategies
const CACHE_STRATEGIES = {
  NetworkFirst: 'network-first',
  CacheFirst: 'cache-first',
  StaleWhileRevalidate: 'stale-while-revalidate',
};

// Current strategy (can be configured from Django settings)
let currentStrategy = CACHE_STRATEGIES.NetworkFirst;

// Install event - cache initial assets
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] Caching app shell');
        return cache.addAll(PRECACHE_URLS.map(url => new Request(url, { cache: 'reload' })));
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
              console.log('[ServiceWorker] Removing old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Skip API calls from caching (they should be fresh)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Apply caching strategy
  if (currentStrategy === CACHE_STRATEGIES.NetworkFirst) {
    event.respondWith(networkFirst(request));
  } else if (currentStrategy === CACHE_STRATEGIES.CacheFirst) {
    event.respondWith(cacheFirst(request));
  } else if (currentStrategy === CACHE_STRATEGIES.StaleWhileRevalidate) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Network First Strategy
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  
  try {
    const response = await fetch(request);
    
    // Cache successful responses
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    console.log('[ServiceWorker] Network failed, serving from cache:', request.url);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline page if available
    if (request.mode === 'navigate') {
      const offlineResponse = await cache.match('/offline/');
      if (offlineResponse) {
        return offlineResponse;
      }
    }
    
    // Return a basic offline response
    return new Response('Offline - No cached version available', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({
        'Content-Type': 'text/plain',
      }),
    });
  }
}

// Cache First Strategy
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    // Update cache in background
    fetch(request).then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response);
      }
    }).catch(() => {
      // Ignore network errors in cache-first mode
    });
    
    return cachedResponse;
  }
  
  try {
    const response = await fetch(request);
    
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    console.log('[ServiceWorker] Fetch failed:', request.url);
    
    if (request.mode === 'navigate') {
      const offlineResponse = await cache.match('/offline/');
      if (offlineResponse) {
        return offlineResponse;
      }
    }
    
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

// Stale While Revalidate Strategy
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await cache.match(request);
  
  const fetchPromise = fetch(request).then((response) => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => {
    // Return cached response on network error
    return cachedResponse;
  });
  
  return cachedResponse || fetchPromise;
}

// Handle messages from the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'UPDATE_STRATEGY') {
    currentStrategy = event.data.strategy || CACHE_STRATEGIES.NetworkFirst;
    console.log('[ServiceWorker] Cache strategy updated to:', currentStrategy);
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      })
    );
  }
});

// Background sync for offline actions
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  console.log('[ServiceWorker] Syncing data...');
  // Implement your sync logic here
  // This could include sending queued requests when back online
}

// Push notification support
self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  const data = event.data.json();
  const title = data.title || 'NCOP Notification';
  const options = {
    body: data.body || 'New update available',
    icon: '/static/pwa/icons/icon-192x192.png',
    badge: '/static/pwa/icons/badge-72x72.png',
    vibrate: [200, 100, 200],
    data: data.data || {},
    actions: data.actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus on existing window if available
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        // Open new window if no existing window
        if (clients.openWindow) {
          return clients.openWindow(event.notification.data.url || '/');
        }
      })
  );
});

console.log('[ServiceWorker] Loaded successfully');