// WebLLM 共用設定。函式庫固定 0.2.86（2026-10-11 發布）；模型為官方預編譯的 Qwen3-0.6B-q4f16_1-MLC。
export const LIBRARY_VERSION = '0.2.86';
export const LIBRARY_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${LIBRARY_VERSION}/lib/index.js`;
export const MODEL_ID = 'Qwen3-0.6B-q4f16_1-MLC';
export const CACHE_PREFIX = 'webllm';

// 冷啟動時讓模型、分詞器與 WebAssembly 檔略過 HTTP 快取。
// WebLLM 以 Cache API 的 cache.add() 下載並存放檔案，所以改寫 Cache.prototype.add，
// 讓下載改用 cache: 'no-store'；其餘行為不變（取得後存入同一個 Cache）。
export function forceNoStore(scope = self) {
  if (scope.__benchNoStore) return;
  scope.__benchNoStore = true;
  const origFetch = scope.fetch.bind(scope);
  scope.fetch = (input, init = {}) => origFetch(input, { ...init, cache: 'no-store' });
  const proto = scope.Cache && scope.Cache.prototype;
  if (proto) {
    proto.add = async function add(request) {
      const req = request instanceof Request ? request : new Request(request);
      const res = await origFetch(req, { cache: 'no-store' });
      if (!res.ok) throw new TypeError(`下載失敗：${res.status} ${req.url}`);
      return this.put(req, res);
    };
  }
}
