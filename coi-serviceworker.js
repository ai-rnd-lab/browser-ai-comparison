// 讓靜態網站進入跨來源隔離（Cross-Origin Isolation），使 Wasm 多執行緒可用。
// GitHub Pages 無法自訂 HTTP 標頭，因此由 Service Worker 在同源回應上補加 COOP 與 COEP。
// 只處理同源的 GET 請求；跨來源請求（CDN、模型檔）不攔截，由瀏覽器照常處理。
// COEP 使用 require-corp：Safari 不支援 credentialless。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  // 避免 only-if-cached 搭配非同源模式時拋錯
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })
  );
});
