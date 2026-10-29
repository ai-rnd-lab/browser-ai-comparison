// 量測框架核心（瀏覽器端 AI 方案比較）。
// 計時一律使用 performance.now()；各指標的起訖點見 README「指標操作型定義」。
// 本檔也會被 Web Worker 匯入，因此頂層不可存取 document 或 window。

export const BENCH_VERSION = '0.2.1';
export const SCHEMA_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 16;

export const now = () => performance.now();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 統計 ----------
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 報告中位數與範圍；n 為有效樣本數
export function summarize(values) {
  const v = values.filter(isNum).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null };
  return { n: v.length, median: quantile(v, 0.5), min: v[0], max: v[v.length - 1] };
}

// ---------- 主執行緒阻塞（M9） ----------
// 以每 16 ms 排程一次的計時器當心跳，記錄「實際觸發時間 − 預定觸發時間」。
// 主執行緒被佔住時，心跳會晚到；延遲越大代表阻塞越久。
// 不使用只有 Chromium 支援的 Long Tasks API。
// 解析度限制：長度為 B 的阻塞，實際被量到的延遲落在 B − 16 到 B ms（取決於阻塞開始時
// 距上一次心跳多久）。因此短於一個心跳間隔的阻塞可能完全量不到，長阻塞則最多低估 16 ms。
export class Heartbeat {
  constructor(intervalMs = HEARTBEAT_INTERVAL_MS) {
    this.interval = intervalMs;
    this.delays = [];
    this._timer = null;
    this._expected = 0;
    this._t0 = 0;
    this._hidden = false;
  }

  start() {
    this.delays = [];
    this._hidden = document.visibilityState !== 'visible';
    this._t0 = now();
    this._expected = this._t0 + this.interval;
    const tick = () => {
      const t = now();
      this.delays.push(Math.max(0, t - this._expected));
      if (document.visibilityState !== 'visible') this._hidden = true;
      // 下一次以「實際觸發時間」為基準，避免一次長阻塞被重複計入後續心跳
      this._expected = t + this.interval;
      this._timer = setTimeout(tick, this.interval);
    };
    this._timer = setTimeout(tick, this.interval);
  }

  stop() {
    clearTimeout(this._timer);
    const t1 = now();
    // 停止時若最後一次心跳已逾期但尚未觸發，代表阻塞剛結束，補記這段延遲
    const pending = t1 - this._expected;
    if (pending > 0) this.delays.push(pending);
    const d = this.delays;
    return {
      durationMs: t1 - this._t0,
      ticks: d.length,
      longestBlockMs: d.length ? Math.max(...d) : 0,
      totalBlockMs: d.reduce((a, b) => a + b, 0),
      over50msCount: d.filter((x) => x > 50).length,
      hiddenSeen: this._hidden,
    };
  }
}

// 閒置時的心跳延遲，用來估計計時器本身的抖動（雜訊底線）
export async function calibrateHeartbeat(durationMs = 1000) {
  const hb = new Heartbeat();
  hb.start();
  await sleep(durationMs);
  const summary = hb.stop();
  const sorted = hb.delays.slice().sort((a, b) => a - b);
  return {
    durationMs: summary.durationMs,
    ticks: summary.ticks,
    medianDelayMs: quantile(sorted, 0.5),
    p95DelayMs: quantile(sorted, 0.95),
    maxDelayMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

// ---------- 模型下載量（M1） ----------
export function initResourceBuffer(size = 5000) {
  try { performance.setResourceTimingBufferSize(size); } catch { /* 忽略 */ }
}

// 以「絕對時間（epoch 毫秒）」比對起點，因為主執行緒與 Worker 的 performance.now() 原點不同。
// 兩種情況下 transferSize 無法反映實際網路傳輸，分別計數，供 coldCheck 判斷是否可信：
//   opaqueCount    跨來源資源未提供 Timing-Allow-Origin，大小欄位全為 0
//   swHandledCount 同源請求由 Service Worker（跨來源隔離用）代為取得，頁面看不到實際網路傳輸
export function resourceBytes(sinceEpochMs) {
  const origin = performance.timeOrigin;
  let transferBytes = 0;
  let encodedBodyBytes = 0;
  let count = 0;
  let opaqueCount = 0;
  let swHandledCount = 0;
  for (const e of performance.getEntriesByType('resource')) {
    if (origin + e.startTime < sinceEpochMs) continue;
    count += 1;
    if (e.transferSize > 0) transferBytes += e.transferSize;
    if (e.transferSize === 0 && e.encodedBodySize === 0 && e.decodedBodySize === 0) opaqueCount += 1;
    if (e.transferSize === 0 && e.encodedBodySize > 0 && e.workerStart > 0) swHandledCount += 1;
    encodedBodyBytes += e.encodedBodySize || 0;
  }
  return { count, transferBytes, encodedBodyBytes, opaqueCount, swHandledCount };
}

// 準備階段是否符合冷／暖啟動的前提。
// 冷啟動：Resource Timing 的傳輸量達預期模型大小的 80% 才視為真的重新下載。
//   傳輸量看不到時（跨來源未提供 Timing-Allow-Origin，或經 Service Worker），改看方案自行回報的
//   cacheEntriesBefore（準備前的快取筆數）與 libraryBytes（函式庫讀到的模型位元組數）：
//   快取為空且讀到足量位元組，回報 ok-library；否則回報 unavailable，不下結論。
// 暖啟動：方案若回報 cacheEntriesBefore 為 0，代表快取是空的，回報 suspect-not-cached。
export function prepCheck(phase, bytes, expectedModelBytes) {
  if (!expectedModelBytes) return 'no-expectation';
  if (phase === 'warm') {
    if (bytes.cacheEntriesBefore === 0) return 'suspect-not-cached';
    return bytes.transferBytes >= expectedModelBytes * 0.2 ? 'suspect-downloaded' : 'ok';
  }
  if (bytes.transferBytes >= expectedModelBytes * 0.8) return 'ok';
  if (bytes.cacheEntriesBefore === 0 && bytes.libraryBytes >= expectedModelBytes * 0.8) return 'ok-library';
  return bytes.opaqueCount > 0 || bytes.swHandledCount > 0 ? 'unavailable' : 'suspect-cached';
}

// ---------- 清除網站資料（冷啟動前） ----------
// 清除 Cache Storage、IndexedDB 與 OPFS。不清除 sessionStorage（量測狀態）與 Service Worker（跨來源隔離）。
// HTTP 快取無法由網頁清除，需另以新設定檔或瀏覽器功能處理，並由 coldCheck 事後檢查。
export async function clearSiteData() {
  const report = { caches: [], indexedDB: [], opfs: [], errors: [] };
  try {
    for (const key of await caches.keys()) {
      await caches.delete(key);
      report.caches.push(key);
    }
  } catch (e) { report.errors.push('caches：' + String((e && e.message) || e)); }

  try {
    if (typeof indexedDB.databases === 'function') {
      for (const db of await indexedDB.databases()) {
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(db.name);
          const timer = setTimeout(() => { report.errors.push('indexedDB 逾時：' + db.name); resolve(); }, 3000);
          req.onsuccess = () => { clearTimeout(timer); report.indexedDB.push(db.name); resolve(); };
          req.onerror = () => { clearTimeout(timer); report.errors.push('indexedDB：' + db.name); resolve(); };
          req.onblocked = () => report.errors.push('indexedDB 被占用：' + db.name);
        });
      }
    } else {
      report.errors.push('indexedDB.databases() 不支援，請手動清除');
    }
  } catch (e) { report.errors.push('indexedDB：' + String((e && e.message) || e)); }

  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true });
        report.opfs.push(name);
      }
    }
  } catch (e) { report.errors.push('opfs：' + String((e && e.message) || e)); }
  return report;
}

export async function storageEstimate() {
  try {
    const est = await navigator.storage.estimate();
    return { usageBytes: est.usage ?? null, quotaBytes: est.quota ?? null };
  } catch { return null; }
}

// ---------- 測試資料 ----------
// 載入公開組的情緒分類句子（site/data/sentiment-en.json）。
// 回傳 { items, inputs, labels }：三者順序一致，inputs 為純文字，labels 為撰寫者的標註，供 runRound 循環使用。
// 推論輸出與 label 的比對由各方案自行處理（輸出格式不同），框架只保存輸出摘要。
export async function loadSentences(url = new URL('../data/sentiment-en.json', import.meta.url)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`測試資料載入失敗：${res.status}`);
  const data = await res.json();
  if (data.schemaVersion !== 1 || !Array.isArray(data.items) || !data.items.length) {
    throw new Error('測試資料格式不符');
  }
  // 依長度組別輪流取句（短、中、長、短、中、長…），讓每輪前 N 次推論都涵蓋三種長度
  const groups = ['short', 'medium', 'long'].map((g) => data.items.filter((it) => it.length === g));
  const items = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) {
    for (const g of groups) if (i < g.length) items.push(g[i]);
  }
  if (items.length !== data.items.length) throw new Error('測試資料含未知的長度組別');
  return { items, inputs: items.map((it) => it.text), labels: items.map((it) => it.label) };
}

// ---------- 分頁可見性 ----------
// 背景分頁的計時器會被瀏覽器降頻，量測期間分頁若曾進入背景，該輪標記為無效
export function trackVisibility() {
  const state = { hidden: document.visibilityState !== 'visible' };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') state.hidden = true;
  });
  return state;
}

// ---------- 環境 ----------
export async function captureEnvironment() {
  const nav = navigator;
  const env = {
    userAgent: nav.userAgent,
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated === true,
    serviceWorkerControlled: !!(nav.serviceWorker && nav.serviceWorker.controller),
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    language: nav.language,
    screen: `${screen.width}x${screen.height} @${window.devicePixelRatio}x`,
  };
  const conn = nav.connection;
  if (conn) env.connection = { effectiveType: conn.effectiveType ?? null, downlinkMbps: conn.downlink ?? null, rttMs: conn.rtt ?? null };
  if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
    try {
      env.userAgentData = await nav.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'fullVersionList']);
    } catch { /* 忽略 */ }
  }
  try {
    if ('gpu' in nav) {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        env.webgpu = {
          vendor: info.vendor || '', architecture: info.architecture || '',
          shaderF16: adapter.features.has('shader-f16'),
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        };
      } else {
        env.webgpu = { adapter: false };
      }
    } else {
      env.webgpu = { available: false };
    }
  } catch (e) { env.webgpu = { error: String((e && e.message) || e) }; }
  env.storage = await storageEstimate();
  return env;
}

// ---------- Worker 代理 ----------
// 延遲從主執行緒送出訊息起算，包含訊息傳遞開銷（與日誌「執行緒配置」一致）
export function createWorkerProxy(url, options = { type: 'module' }) {
  const worker = new Worker(url, options);
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result); else p.reject(new Error(error));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'Worker 錯誤'));
    pending.clear();
  };
  return {
    worker,
    call(type, payload, transfer = []) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload }, transfer);
      });
    },
    terminate() { worker.terminate(); },
  };
}

// ---------- 單輪量測 ----------
// 一輪 = 一次乾淨的頁面載入：準備模型（M2 或 M3）→ 連續推論 inferCalls 次。
// 第 1 次為 M4，第 2 次起為 M5；生成任務的 M4／M5 為第一個 token 的時間（TTFT），M6 為之後的生成速度。
//
// 受測方案（approach）介面：
//   id, label, task, kind('classify'|'generate'), modes(['main','worker']), expectedModelBytes
//   load(ctx)                  載入函式庫、建立 Worker；不計入 M2／M3
//   create(ctx) -> handle      計時範圍：呼叫到 Promise resolve（M2／M3）
//   infer(handle, input, hooks) -> output；生成任務每產生 token 呼叫 hooks.onToken(n = 1)
//   getTransferBytes?(handle, sinceEpochMs)  Worker 模式須由 Worker 回報自己的資源傳輸量
//   dispose?(handle)
//   getInputs? / defaultInputs
export async function runRound(approach, { mode, phase, inferCalls = 10, inputs, labels = null, heartbeat = false, options = {}, visibility }) {
  const rec = {
    approach: approach.id, kind: approach.kind, mode, phase,
    startedAt: new Date().toISOString(),
    valid: false, flags: [], error: null, metrics: {}, calls: [],
  };
  const ctx = { mode, phase, options, shared: {} };
  let handle = null;
  try {
    await approach.load?.(ctx);
    if (heartbeat) rec.idleJitter = await calibrateHeartbeat(1000);
    const hb = heartbeat ? new Heartbeat() : null;

    // M2（冷啟動）／M3（暖啟動）
    const createStart = now();
    const sinceEpoch = performance.timeOrigin + createStart;
    hb?.start();
    try {
      handle = await approach.create(ctx);
    } finally {
      rec.createBlock = hb ? hb.stop() : null;
    }
    rec.metrics[phase === 'cold' ? 'M2' : 'M3'] = now() - createStart;

    // M1：準備階段內的資源傳輸量
    rec.bytes = approach.getTransferBytes ? await approach.getTransferBytes(handle, sinceEpoch) : resourceBytes(sinceEpoch);
    const expectedBytes = approach.expectedBytesFor ? approach.expectedBytesFor(options) : approach.expectedModelBytes;
    rec.expectedModelBytes = expectedBytes ?? null;
    rec.prepCheck = prepCheck(phase, rec.bytes, expectedBytes);
    if (phase === 'cold') rec.coldCheck = rec.prepCheck;

    // M4、M5、M6
    for (let i = 0; i < inferCalls; i++) {
      const input = inputs[i % inputs.length];
      const stamps = [];
      const hooks = { onToken: (n = 1) => { const t = now(); for (let k = 0; k < n; k++) stamps.push(t); } };
      const call = { i: i + 1, latencyMs: null, totalMs: null, tokens: null, tokensPerSec: null, block: null, output: null, expected: null, correct: null };
      hb?.start();
      const t0 = now();
      let out;
      try {
        out = await approach.infer(handle, input, hooks);
      } finally {
        call.block = hb ? hb.stop() : null;
      }
      call.totalMs = now() - t0;
      if (approach.kind === 'generate') {
        if (!stamps.length) throw new Error('生成任務未呼叫 hooks.onToken');
        call.latencyMs = stamps[0] - t0;
        call.tokens = stamps.length;
        const span = stamps[stamps.length - 1] - stamps[0];
        call.tokensPerSec = stamps.length > 1 && span > 0 ? (stamps.length - 1) / (span / 1000) : null;
      } else {
        call.latencyMs = call.totalMs;
      }
      call.output = (approach.summarizeOutput ? approach.summarizeOutput(out) : JSON.stringify(out)).slice(0, 300);
      if (labels) {
        call.expected = labels[i % labels.length];
        const got = approach.labelOf ? approach.labelOf(out) : out && out.label;
        call.correct = got === call.expected;
      }
      rec.calls.push(call);
    }
    rec.metrics.M4 = rec.calls[0]?.latencyMs ?? null;
  } catch (e) {
    rec.error = String((e && e.message) || e);
  } finally {
    try { if (handle) await approach.dispose?.(handle); } catch { rec.flags.push('dispose-error'); }
  }
  if (visibility?.hidden) rec.flags.push('hidden-during-run');
  if (rec.createBlock?.hiddenSeen || rec.calls.some((c) => c.block?.hiddenSeen)) rec.flags.push('hidden-during-run');
  rec.valid = !rec.error && !rec.flags.includes('hidden-during-run');
  return rec;
}

// ---------- 彙整 ----------
export function aggregate(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.approach}|${r.mode}|${r.phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, recs] of groups) {
    const [approach, mode, phase] = key.split('|');
    const ok = recs.filter((r) => r.valid);
    const pick = (fn) => ok.flatMap(fn).filter(isNum);
    const steady = (r) => r.calls.slice(1);
    const prepKey = phase === 'cold' ? 'M2' : 'M3';
    out.push({
      approach, mode, phase,
      rounds: recs.length,
      validRounds: ok.length,
      excluded: recs.filter((r) => !r.valid).map((r) => ({ round: r.round ?? null, reason: r.error || (r.crashed ? 'crashed' : r.flags.join(',')) })),
      coldCheck: phase === 'cold' ? recs.map((r) => r.coldCheck ?? null) : undefined,
      warmCheck: phase === 'warm' ? recs.map((r) => r.prepCheck ?? null) : undefined,
      accuracy: (() => {
        const calls = ok.flatMap((r) => r.calls).filter((c) => c.correct !== null);
        return calls.length ? { correct: calls.filter((c) => c.correct).length, total: calls.length } : null;
      })(),
      metrics: {
        M1_transferBytes: summarize(pick((r) => [r.bytes?.transferBytes])),
        M1_libraryBytes: summarize(pick((r) => [r.bytes?.libraryBytes])),
        M1_cacheStorageBytes: summarize(pick((r) => [r.bytes?.cacheStorageBytes])),
        [prepKey]: summarize(pick((r) => [r.metrics[prepKey]])),
        M4: summarize(pick((r) => [r.metrics.M4])),
        M5: summarize(pick((r) => steady(r).map((c) => c.latencyMs))),
        M6: summarize(pick((r) => steady(r).map((c) => c.tokensPerSec))),
        M9_create_longestMs: summarize(pick((r) => [r.createBlock?.longestBlockMs])),
        M9_create_totalMs: summarize(pick((r) => [r.createBlock?.totalBlockMs])),
        M9_infer_longestMs: summarize(pick((r) => r.calls.map((c) => c.block?.longestBlockMs))),
        M9_infer_totalMs: summarize(pick((r) => r.calls.map((c) => c.block?.totalBlockMs))),
      },
    });
  }
  return out;
}
