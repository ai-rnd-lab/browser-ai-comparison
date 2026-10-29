// 量測頁：設定、輪次排程、結果顯示與匯出。
// 每一輪量測在「全新載入的頁面」中執行；輪與輪之間以 sessionStorage 保存進度並重新載入頁面。
import {
  BENCH_VERSION, SCHEMA_VERSION, HEARTBEAT_INTERVAL_MS, runRound, aggregate, captureEnvironment,
  clearSiteData, initResourceBuffer, trackVisibility, storageEstimate, sleep,
} from './bench.js';
import { APPROACHES } from './approaches/index.js';

initResourceBuffer();

const STORAGE_KEY = 'bench-state-v1';
const $ = (id) => document.getElementById(id);

// ---------- 狀態 ----------
function loadState() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
function saveState(state) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function buildExport(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    benchVersion: BENCH_VERSION,
    exportedAt: new Date().toISOString(),
    url: location.origin + location.pathname,
    finished: !state.running,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    config: state.config,
    environment: state.environment,
    records: state.records,
    summary: aggregate(state.records),
  };
}
window.benchExport = () => { const s = loadState(); return s ? buildExport(s) : null; };

// ---------- 排程 ----------
async function buildPlan(config) {
  const plan = [];
  for (const id of config.approaches) {
    const approach = (await APPROACHES[id].load()).default;
    const modes = config.modes === 'both' ? ['worker', 'main'] : [config.modes];
    for (const mode of modes) {
      if (!approach.modes.includes(mode)) continue;
      for (const phase of ['cold', 'warm']) {
        const rounds = phase === 'cold' ? config.coldRounds : config.warmRounds;
        for (let round = 1; round <= rounds; round++) plan.push({ approach: id, mode, phase, round });
      }
    }
  }
  return plan;
}

async function executeStep(state, step) {
  const visibility = trackVisibility();
  const approach = (await APPROACHES[step.approach].load()).default;
  // 冷啟動：先清除網站資料，再載入函式庫與模型
  const clearReport = step.phase === 'cold' ? await clearSiteData() : null;
  const got = approach.getInputs ? await approach.getInputs() : approach.defaultInputs;
  const inputs = Array.isArray(got) ? got : got.inputs;
  const labels = Array.isArray(got) ? null : got.labels || null;
  const rec = await runRound(approach, {
    mode: step.mode, phase: step.phase, inferCalls: state.config.inferCalls,
    inputs, labels, heartbeat: state.config.heartbeat, options: state.config.options || {}, visibility,
  });
  rec.round = step.round;
  rec.clearReport = clearReport;
  rec.storage = await storageEstimate();
  return rec;
}

function failedRecord(step, reason, extra = {}) {
  return {
    approach: step.approach, mode: step.mode, phase: step.phase, round: step.round,
    valid: false, flags: [], error: reason, metrics: {}, calls: [], ...extra,
  };
}

async function continueRun(state) {
  // 上一輪未正常結束（分頁崩潰、被關閉或手動重新整理）：照實記錄後跳到下一輪，避免無限重試
  if (state.inProgress != null) {
    const step = state.plan[state.inProgress];
    if (state.timedOut === state.inProgress) {
      const sec = state.config.roundTimeoutSec || 300;
      state.records.push(failedRecord(step, `逾時（${sec} 秒內沒有完成，已自動重新載入）`, { timedOut: true, flags: ['timeout'] }));
      state.timedOut = null;
    } else {
      state.records.push(failedRecord(step, null, { crashed: true, flags: ['previous-attempt-did-not-finish'] }));
    }
    state.index = state.inProgress + 1;
    state.inProgress = null;
    saveState(state);
  }
  if (state.index >= state.plan.length) return finish(state);

  const step = state.plan[state.index];
  state.inProgress = state.index;
  saveState(state);
  renderProgress(state, step);

  // 看門狗：某一輪的 Promise 永遠不結束（例如函式庫內部死結）時，逾時就重新載入頁面並記錄為逾時。
  // 只能處理非同步卡住；若主執行緒被同步卡死，計時器不會觸發，需手動重新整理，重新載入後同樣記為未完成。
  const limitMs = (state.config.roundTimeoutSec || 300) * 1000;
  const watchdog = setTimeout(() => {
    try { state.timedOut = state.inProgress; saveState(state); } catch { /* 忽略 */ }
    location.reload();
  }, limitMs);
  let rec;
  try {
    rec = await executeStep(state, step);
  } catch (e) {
    rec = failedRecord(step, String((e && e.message) || e));
  } finally {
    clearTimeout(watchdog);
  }
  state.records.push(rec);
  state.index += 1;
  state.inProgress = null;
  saveState(state);
  // 顯示錯誤不可中斷量測；結果已存入 sessionStorage
  try { renderResults(state); } catch (e) { console.warn('顯示彙整表失敗：', e); }
  if (state.index >= state.plan.length) return finish(state);
  await sleep(500); // 讓上一輪的資源有時間釋放
  location.reload();
}

function finish(state) {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  saveState(state);
  renderResults(state);
  setIdleUI(true);
  $('progress').textContent = `完成：共 ${state.records.length} 輪，無效 ${state.records.filter((r) => !r.valid).length} 輪。`;
}

// ---------- 顯示 ----------
const f1 = (x) => (x === null || x === undefined ? '—' : x.toFixed(1));
function cell(s, scale = 1) {
  if (!s || !s.n) return '—';
  const m = (x) => f1(x / scale);
  return `${m(s.median)} (${m(s.min)}–${m(s.max)}) n=${s.n}`;
}

function renderProgress(state, step) {
  $('progress').textContent =
    `進度 ${state.index + 1} / ${state.plan.length}：${step.approach}／${step.mode === 'worker' ? 'Worker' : '主執行緒'}／` +
    `${step.phase === 'cold' ? '冷啟動' : '暖啟動'}／第 ${step.round} 輪`;
  setRunningUI();
}

function renderResults(state) {
  const summary = aggregate(state.records);
  const table = $('summary');
  const cols = [
    ['方案', (g) => g.approach], ['執行緒', (g) => (g.mode === 'worker' ? 'Worker' : '主')],
    ['階段', (g) => (g.phase === 'cold' ? '冷' : '暖')], ['有效/總輪', (g) => `${g.validRounds}/${g.rounds}`],
    ['M1 下載量 (MB)', (g) => cell(g.metrics.M1_transferBytes, 1e6)],
    ['M1 函式庫讀取 (MB)', (g) => cell(g.metrics.M1_libraryBytes, 1e6)],
    ['M1 快取存放 (MB)', (g) => cell(g.metrics.M1_cacheStorageBytes, 1e6)],
    ['M2/M3 準備 (ms)', (g) => cell(g.metrics.M2 || g.metrics.M3)],
    ['M4 首次推論 (ms)', (g) => cell(g.metrics.M4)], ['M5 穩態推論 (ms)', (g) => cell(g.metrics.M5)],
    ['M6 (tokens/s)', (g) => cell(g.metrics.M6)],
    ['答對/總數', (g) => (g.accuracy ? `${g.accuracy.correct}/${g.accuracy.total}` : '—')],
    ['M9 準備最長阻塞 (ms)', (g) => cell(g.metrics.M9_create_longestMs)],
    ['M9 準備總阻塞 (ms)', (g) => cell(g.metrics.M9_create_totalMs)],
    ['M9 推論最長阻塞 (ms)', (g) => cell(g.metrics.M9_infer_longestMs)],
    ['M9 推論總阻塞 (ms)', (g) => cell(g.metrics.M9_infer_totalMs)],
  ];
  table.innerHTML = '';
  const head = table.insertRow();
  for (const [name] of cols) { const th = document.createElement('th'); th.textContent = name; head.append(th); }
  for (const g of summary) {
    const tr = table.insertRow();
    for (const [, fn] of cols) tr.insertCell().textContent = fn(g);
    const bad = g.excluded.length || (g.coldCheck || []).some((c) => c === 'suspect-cached');
    if (bad) tr.className = 'warn';
  }
  const warnings = [];
  for (const g of summary) {
    if (g.excluded.length) warnings.push(`${g.approach}／${g.mode}／${g.phase}：${g.excluded.length} 輪無效（${g.excluded.map((e) => e.reason || '未知').join('；')}）`);
    if ((g.coldCheck || []).includes('suspect-cached')) warnings.push(`${g.approach}／${g.mode}：冷啟動傳輸量低於預期，HTTP 快取可能仍在，該輪冷啟動數據請存疑`);
    if ((g.warmCheck || []).includes('suspect-not-cached')) warnings.push(`${g.approach}／${g.mode}：暖啟動開始時快取是空的，該輪其實是冷啟動，數據請存疑`);
    if ((g.warmCheck || []).includes('suspect-downloaded')) warnings.push(`${g.approach}／${g.mode}：暖啟動仍有大量下載，快取可能未生效，數據請存疑`);
    if ((g.coldCheck || []).includes('unavailable')) warnings.push(`${g.approach}／${g.mode}：跨來源資源未提供傳輸量資訊，無法檢查冷啟動是否真的重新下載`);
  }
  $('msg').className = warnings.length ? 'warn' : '';
  $('msg').innerHTML = '';
  for (const w of warnings) { const d = document.createElement('div'); d.textContent = w; $('msg').append(d); }
  $('raw').textContent = JSON.stringify(buildExport(state), null, 2);
}

function setRunningUI() {
  $('start').disabled = true; $('stop').disabled = false; $('reset').disabled = true;
  $('download').disabled = false; $('copy').disabled = false;
  $('setup').style.opacity = '.5';
}
function setIdleUI(hasResult) {
  $('start').disabled = false; $('stop').disabled = true; $('reset').disabled = !hasResult;
  $('download').disabled = !hasResult; $('copy').disabled = !hasResult;
  $('setup').style.opacity = '1';
}

// ---------- 設定表單 ----------
function renderApproachList() {
  const box = $('approachList');
  for (const [id, a] of Object.entries(APPROACHES)) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = id; cb.checked = id !== 'selftest'; cb.className = 'approach-cb';
    label.append(cb, document.createTextNode(a.label));
    box.append(label);
  }
}

function readConfig() {
  const approaches = [...document.querySelectorAll('.approach-cb')].filter((c) => c.checked).map((c) => c.value);
  const device = $('device').value.trim();
  const browser = $('browser').value.trim();
  const code = /^[A-Za-z0-9_.-]{1,32}$/;
  if (!code.test(device) || !code.test(browser)) throw new Error('裝置代號與瀏覽器代號必填，只能用英數字、底線、句點與連字號。');
  if (!approaches.length) throw new Error('請至少選一個受測方案。');
  const num = (id, lo, hi) => Math.min(hi, Math.max(lo, parseInt($(id).value, 10) || lo));
  let options;
  try { options = JSON.parse($('options').value || '{}'); } catch { throw new Error('進階選項不是有效的 JSON。'); }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('進階選項必須是 JSON 物件，例如 {}。');
  return {
    device, browser, network: $('network').value.trim(), approaches,
    modes: $('modes').value, coldRounds: num('cold', 0, 20), warmRounds: num('warm', 0, 20),
    inferCalls: num('calls', 2, 50), roundTimeoutSec: num('timeout', 10, 3600),
    heartbeat: $('heartbeat').checked, httpCacheCleared: $('httpcache').checked,
    options,
  };
}

function download(state) {
  const data = buildExport(state);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `bench-${state.config.device}-${state.config.browser}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 啟動 ----------
async function main() {
  renderApproachList();
  const state = loadState();
  if (state) {
    const c = state.config;
    $('device').value = c.device; $('browser').value = c.browser; $('network').value = c.network || '';
    $('modes').value = c.modes; $('cold').value = c.coldRounds; $('warm').value = c.warmRounds;
    $('calls').value = c.inferCalls; $('timeout').value = c.roundTimeoutSec || 300; $('heartbeat').checked = c.heartbeat; $('httpcache').checked = c.httpCacheCleared;
    $('options').value = JSON.stringify(c.options || {});
    for (const cb of document.querySelectorAll('.approach-cb')) cb.checked = c.approaches.includes(cb.value);
  }

  $('start').addEventListener('click', async () => {
    try {
      const config = readConfig();
      const plan = await buildPlan(config);
      if (!plan.length) throw new Error('目前設定沒有任何要執行的輪次。');
      saveState({
        version: SCHEMA_VERSION, running: true, config, plan, index: 0, inProgress: null, records: [],
        environment: await captureEnvironment(), startedAt: new Date().toISOString(),
      });
      location.reload();
    } catch (e) {
      $('msg').className = 'bad';
      $('msg').textContent = String((e && e.message) || e);
    }
  });
  $('stop').addEventListener('click', () => {
    const s = loadState();
    if (!s) return;
    s.running = false; s.inProgress = null; s.stoppedByUser = true;
    saveState(s);
    location.reload();
  });
  $('reset').addEventListener('click', () => {
    sessionStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
  $('download').addEventListener('click', () => { const s = loadState(); if (s) download(s); });
  $('copy').addEventListener('click', async () => {
    const s = loadState();
    if (!s) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildExport(s), null, 2));
      $('progress').textContent = '已複製到剪貼簿';
    } catch { $('progress').textContent = '無法複製，請改用下載'; }
  });

  if (!state) { setIdleUI(false); return; }
  renderResults(state);
  if (state.running) {
    await continueRun(state);
  } else {
    setIdleUI(true);
    $('progress').textContent = state.stoppedByUser ? '已中止，以下為已完成的輪次。' : '已完成。';
  }
}

main();
