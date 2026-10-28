// 註冊 coi-serviceworker.js。第一次造訪時 Service Worker 尚未接管頁面，
// 註冊完成後重新載入一次；以 sessionStorage 防止無限重新載入。
// 在每個頁面的 <head> 以一般 <script>（非 module）最先載入。
(function () {
  if (window.crossOriginIsolated) return;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

  var KEY = 'coi-reloaded';
  var swUrl = new URL('coi-serviceworker.js', document.currentScript.src);
  var scope = new URL('./', swUrl).pathname;

  navigator.serviceWorker.register(swUrl.href, { scope: scope }).then(function (reg) {
    function reloadOnce() {
      if (sessionStorage.getItem(KEY)) return; // 已重新載入過仍未隔離，不再重試
      sessionStorage.setItem(KEY, '1');
      location.reload();
    }
    if (navigator.serviceWorker.controller) {
      reloadOnce();
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    }
  }).catch(function (e) {
    console.warn('coi-serviceworker 註冊失敗：', e);
  });
})();
