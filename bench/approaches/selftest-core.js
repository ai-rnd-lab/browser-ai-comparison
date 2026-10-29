// 框架自我檢查用的模擬方案核心，主執行緒與 Worker 共用。
// 目的：驗證冷／暖啟動流程、清除快取、M1 傳輸量、M9 阻塞偵測與 Worker 訊息開銷。
// 模擬的「模型」只是一筆 Cache Storage 紀錄；沒有真正的推論。
import { sleep } from '../bench.js';

const CACHE_NAME = 'selftest-cache';
const MODEL_KEY = 'https://selftest.invalid/model';

// 佔住執行緒 ms 毫秒，模擬同步運算（例如著色器編譯）
export function busy(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* 忙碌等待 */ }
}

export async function prepareModel({ blockMs = 100, downloadUrl = null } = {}) {
  const cache = await caches.open(CACHE_NAME);
  let downloaded = false;
  if (!(await cache.match(MODEL_KEY))) {
    // 模擬下載：實際取得一個檔案，讓 Resource Timing 有可量測的傳輸量。
    // 預設取同源檔案（會經過 Service Worker，傳輸量無法量測）；
    // 以進階選項 downloadUrl 指定跨來源網址，可驗證 M1 的正常路徑。
    const url = downloadUrl
      ? downloadUrl + (downloadUrl.includes('?') ? '&' : '?') + 'selftest=' + Math.random()
      : new URL('../bench.js?selftest=' + Math.random(), import.meta.url);
    await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
    await sleep(150);
    await cache.put(MODEL_KEY, new Response('ok'));
    downloaded = true;
  }
  busy(blockMs);
  return { downloaded };
}

export function classify(input) {
  busy(input.busyMs);
  return { label: input.busyMs % 2 ? 'POSITIVE' : 'NEGATIVE' };
}
