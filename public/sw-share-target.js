'use strict';

// Intercepts the Android Share Target POST before Workbox routes.
// Reads the CSV file from multipart/form-data, stores it in CacheStorage,
// then redirects the user to /import where the React app picks it up.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/import') return;

  event.respondWith(
    (async () => {
      try {
        const formData = await event.request.formData();
        const file = formData.get('csv');
        if (file instanceof File && file.size > 0) {
          const buffer = await file.arrayBuffer();
          const cache = await caches.open('share-target-v1');
          await cache.put(
            '/pending-csv',
            new Response(buffer, {
              headers: {
                'Content-Type': 'text/csv',
                'X-File-Name': encodeURIComponent(file.name),
              },
            }),
          );
        }
      } catch (err) {
        console.error('[SW] share-target error:', err);
      }
      return Response.redirect('/import?source=share', 303);
    })(),
  );
});
