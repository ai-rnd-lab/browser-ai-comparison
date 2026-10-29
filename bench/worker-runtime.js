// Worker 端的訊息處理。每個受測方案的 Worker 以 serve(handlers) 啟動。
// 內建 __resourceBytes__：回報 Worker 自己的資源傳輸量（Worker 的資源紀錄不會出現在主執行緒）。
import { resourceBytes } from './bench.js';

export function serve(handlers) {
  self.onmessage = async (ev) => {
    const { id, type, payload } = ev.data;
    try {
      let result;
      if (type === '__resourceBytes__') {
        result = resourceBytes(payload.sinceEpochMs);
      } else if (handlers[type]) {
        result = await handlers[type](payload);
      } else {
        throw new Error('未知的訊息類型：' + type);
      }
      self.postMessage({ id, ok: true, result });
    } catch (e) {
      self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
    }
  };
}
