// 瀏覽器端 AI 環境偵測。所有檢查只在本機執行，不傳送任何資料，也不觸發模型下載。
const PAGE_VERSION = '0.1.0';
const TIMEOUT_MS = 10000;

const $ = (id) => document.getElementById(id);
let lastResult = null;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`逾時（${ms} ms）`)), ms)),
  ]);
}

async function safe(fn, ms = TIMEOUT_MS) {
  try {
    return await withTimeout(Promise.resolve().then(fn), ms);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// 不設整體時限，只讓各子項目自行計時；用於內部已逐項計時的檢查
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ---------- 環境 ----------
async function checkEnvironment() {
  const nav = navigator;
  const env = {
    userAgent: nav.userAgent,
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated === true,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null, // 只有 Chromium 提供，且為粗略值
    language: nav.language,
    screen: `${screen.width}x${screen.height} @${window.devicePixelRatio}x`,
  };
  if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
    const ua = await safe(() =>
      nav.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'model', 'fullVersionList'])
    );
    env.userAgentData = ua;
  }
  return env;
}

// ---------- WebGPU（主執行緒） ----------
async function checkWebGPU() {
  const r = { available: 'gpu' in navigator };
  if (!r.available) return r;
  const adapter = await safe(() => navigator.gpu.requestAdapter());
  if (!adapter || adapter.error) {
    r.adapter = false;
    if (adapter && adapter.error) r.error = adapter.error;
    return r;
  }
  r.adapter = true;
  const info = adapter.info || {};
  r.vendor = info.vendor || '';
  r.architecture = info.architecture || '';
  r.description = info.description || '';
  r.isFallbackAdapter = info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null;
  r.features = [...adapter.features].sort();
  r.shaderF16 = adapter.features.has('shader-f16');
  const L = adapter.limits;
  r.limits = {
    maxBufferSize: L.maxBufferSize,
    maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
  };
  // 實際建立裝置，確認 shader-f16 可以被要求
  const dev = await safe(() =>
    adapter.requestDevice({ requiredFeatures: r.shaderF16 ? ['shader-f16'] : [] })
  );
  r.deviceCreated = !!dev && !dev.error;
  if (dev && dev.error) r.deviceError = dev.error;
  if (r.deviceCreated) dev.destroy();
  return r;
}

// ---------- WebGPU（Web Worker） ----------
function checkWebGPUInWorker() {
  return safe(() => new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL('./gpu-worker.js', import.meta.url));
    } catch (e) {
      reject(e);
      return;
    }
    w.onmessage = (ev) => { resolve(ev.data); w.terminate(); };
    w.onerror = (ev) => { reject(new Error(ev.message || 'Worker 錯誤')); w.terminate(); };
    w.postMessage('run');
  }));
}

// ---------- WebAssembly ----------
function checkWasm() {
  const has = typeof WebAssembly === 'object';
  if (!has) return { available: false };
  // 位元組序列與 wasm-feature-detect 相同，已以 Node 驗證（含改壞的對照組）
  const simd = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  const threads = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11]);
  const sab = typeof SharedArrayBuffer !== 'undefined';
  return {
    available: true,
    simd: WebAssembly.validate(simd),
    threadsInstructions: WebAssembly.validate(threads),
    sharedArrayBuffer: sab,
    // 多執行緒實際可用的條件：指令支援、SharedArrayBuffer 存在、頁面處於跨來源隔離
    multiThreadUsable: WebAssembly.validate(threads) && sab && window.crossOriginIsolated === true,
  };
}

// ---------- WebNN ----------
async function checkWebNN() {
  const r = { available: 'ml' in navigator && !!navigator.ml };
  if (!r.available) return r;
  r.createContext = {};
  const variants = {
    default: undefined,
    'powerPreference:high-performance': { powerPreference: 'high-performance' },
    'powerPreference:low-power': { powerPreference: 'low-power' },
  };
  for (const [name, opt] of Object.entries(variants)) {
    const ctx = await safe(() => navigator.ml.createContext(opt));
    r.createContext[name] = ctx && !ctx.error ? 'ok' : (ctx && ctx.error) || 'failed';
  }
  return r;
}

// ---------- 內建 AI ----------
async function availabilityOf(name, opts) {
  const api = self[name];
  if (!api || typeof api.availability !== 'function') return 'API 不存在';
  const v = await safe(() => api.availability(opts), 5000);
  return typeof v === 'string' ? v : `錯誤：${(v && v.error) || String(v)}`;
}

async function checkBuiltInAI() {
  const names = ['Summarizer', 'LanguageModel', 'Translator', 'LanguageDetector', 'Writer', 'Rewriter', 'Proofreader'];
  const r = { present: {} };
  for (const n of names) r.present[n] = n in self;

  r.summarizer = {};
  for (const lang of ['en', 'ja', 'zh']) {
    r.summarizer[lang] = await availabilityOf('Summarizer', {
      type: 'key-points', format: 'plain-text', length: 'short',
      expectedInputLanguages: [lang], outputLanguage: lang,
    });
  }
  r.languageModel = {};
  for (const lang of ['en', 'ja', 'zh']) {
    r.languageModel[lang] = await availabilityOf('LanguageModel', {
      expectedInputs: [{ type: 'text', languages: [lang] }],
      expectedOutputs: [{ type: 'text', languages: [lang] }],
    });
  }
  r.translatorEnToZh = await availabilityOf('Translator', { sourceLanguage: 'en', targetLanguage: 'zh' });
  r.languageDetector = await availabilityOf('LanguageDetector', {});
  return r;
}

// ---------- 儲存空間 ----------
async function checkStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return { available: false };
  const est = await safe(() => navigator.storage.estimate());
  const persisted = navigator.storage.persisted ? await safe(() => navigator.storage.persisted()) : null;
  const toGB = (b) => (typeof b === 'number' ? Math.round((b / 1e9) * 100) / 100 : null);
  return {
    available: true,
    quotaGB: est && toGB(est.quota),
    usageGB: est && toGB(est.usage),
    persisted,
  };
}

// ---------- 顯示 ----------
// 這些項目「是」代表不理想，顏色判斷反過來
const INVERTED_KEYS = new Set(['isFallbackAdapter']);
// 這些項目只是描述，不標顏色
const NEUTRAL_KEYS = new Set(['persisted', 'mobile', 'workerGpu']);

function levelOf(key, value) {
  const leaf = key.split('.').pop();
  if (NEUTRAL_KEYS.has(leaf)) return '';
  if (typeof value === 'string' && value.startsWith('錯誤')) return 'bad';
  if (INVERTED_KEYS.has(leaf)) {
    if (value === true) return 'bad';
    if (value === false) return 'ok';
  }
  if (value === true || value === 'available' || value === 'ok') return 'ok';
  if (value === 'downloadable' || value === 'downloading') return 'warn';
  if (value === false || value === 'unavailable' || value === 'API 不存在' || value === 'failed') return 'bad';
  return '';
}

function fmt(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (!value.length) return '（無）';
    return value
      .map((x) => (x && typeof x === 'object' ? (x.brand ? `${x.brand} ${x.version}` : JSON.stringify(x)) : String(x)))
      .join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flatten(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !('error' in v && Object.keys(v).length === 1)) {
      rows.push(...flatten(v, key));
    } else {
      rows.push([key, v && typeof v === 'object' && 'error' in v ? `錯誤：${v.error}` : v]);
    }
  }
  return rows;
}

const SECTIONS = [
  ['environment', '環境'],
  ['webgpu', 'WebGPU（主執行緒）'],
  ['webgpuWorker', 'WebGPU（Web Worker）'],
  ['wasm', 'WebAssembly'],
  ['webnn', 'WebNN'],
  ['builtInAI', 'Chrome 內建 AI（availability，不觸發下載）'],
  ['storage', '網站儲存空間'],
];

function render(result) {
  const out = $('out');
  out.innerHTML = '';
  for (const [key, title] of SECTIONS) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = title;
    sec.append(h);
    const table = document.createElement('table');
    for (const [k, v] of flatten(result.checks[key])) {
      const tr = document.createElement('tr');
      const tk = document.createElement('td');
      tk.className = 'k';
      tk.innerHTML = `<code></code>`;
      tk.firstChild.textContent = k;
      const tv = document.createElement('td');
      tv.textContent = fmt(v);
      const lv = levelOf(k, v);
      if (lv) tv.className = lv;
      tr.append(tk, tv);
      table.append(tr);
    }
    sec.append(table);
    out.append(sec);
  }
}

async function run() {
  $('run').disabled = true;
  $('copy').disabled = true;
  $('download').disabled = true;
  $('status').textContent = '偵測中…';
  const started = performance.now();
  const checks = {
    environment: await safe(checkEnvironment),
    webgpu: await safe(checkWebGPU),
    webgpuWorker: await checkWebGPUInWorker(),
    wasm: await safe(checkWasm),
    webnn: await guarded(checkWebNN),
    builtInAI: await guarded(checkBuiltInAI),
    storage: await safe(checkStorage),
  };
  lastResult = {
    pageVersion: PAGE_VERSION,
    timestamp: new Date().toISOString(),
    url: location.origin + location.pathname,
    durationMs: Math.round(performance.now() - started),
    checks,
  };
  render(lastResult);
  $('status').textContent = `完成（${lastResult.durationMs} ms）`;
  $('run').disabled = false;
  $('copy').disabled = false;
  $('download').disabled = false;
}

$('run').addEventListener('click', run);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
    $('status').textContent = '已複製到剪貼簿';
  } catch {
    $('status').textContent = '無法複製，請改用下載';
  }
});
$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `detect-${lastResult.timestamp.replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

run();
