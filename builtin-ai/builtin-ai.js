// Chrome 內建 AI（Prompt API，LanguageModel）檢查與量測。版本 0.1.0。
// 流程：檢查可用性 → 建立工作階段並下載模型（冷啟動）→ 36 句準確率 → 暖啟動 5 輪 × 10 次推論。
const VERSION = '0.1.1';
const $ = (id) => document.getElementById(id);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const SCHEMA = { type: 'string', enum: ['POSITIVE', 'NEGATIVE'] };
const OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
  initialPrompts: [{ role: 'system', content: 'You are a sentiment classifier for English sentences. Answer with exactly one word: POSITIVE or NEGATIVE.' }],
};
const result = { schemaVersion: 1, pageVersion: VERSION, steps: {}, cold: null, accuracy: null, warm: [] };
let sentences = null;
let busy = false;

function status(msg, bad = false) { const el = $('status'); el.textContent = msg; el.className = bad ? 'bad' : ''; }
function refresh() { $('raw').textContent = JSON.stringify(result, null, 2); renderSummary(); }
function setBusy(b) { busy = b; for (const id of ['btnCheck', 'btnCold', 'btnAcc', 'btnWarm', 'btnDownload']) $(id).disabled = b || $(id).dataset.lock === '1'; }
function lock(id, on) { $(id).dataset.lock = on ? '1' : '0'; $(id).disabled = on || busy; }
lock('btnCold', true); lock('btnAcc', true); lock('btnWarm', true); lock('btnDownload', true);

async function environment() {
  const env = {
    userAgent: navigator.userAgent, isSecureContext: window.isSecureContext,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null, language: navigator.language,
    device: $('device').value.trim(), browser: $('browser').value.trim(), network: $('network').value.trim(), modelVersion: $('modelVersion').value.trim(),
  };
  try { const est = await navigator.storage.estimate(); env.storage = { usageBytes: est.usage, quotaBytes: est.quota }; } catch { /* 忽略 */ }
  try { if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); const i = a && (a.info || (a.requestAdapterInfo && await a.requestAdapterInfo())); env.webgpu = i ? { vendor: i.vendor, architecture: i.architecture } : { adapter: !!a }; } } catch { /* 忽略 */ }
  return env;
}

async function loadSentences() {
  if (sentences) return sentences;
  const res = await fetch('../data/sentiment-en.json');
  if (!res.ok) throw new Error('讀不到 ../data/sentiment-en.json');
  sentences = (await res.json()).items;
  return sentences;
}

function parseLabel(raw) { try { const v = JSON.parse(raw); return typeof v === 'string' ? v : String(v); } catch { return String(raw).trim().replace(/^"|"$/g, ''); } }

async function timedPrompt(session, text) {
  const t0 = performance.now();
  const out = await session.prompt(text, { responseConstraint: SCHEMA });
  return { ms: performance.now() - t0, label: parseLabel(out), raw: out };
}

// 1. 檢查可用性（不觸發下載）
$('btnCheck').onclick = async () => {
  setBusy(true);
  try {
    result.environment = await environment();
    const api = self.LanguageModel;
    const s = { apiExists: !!api };
    if (api) {
      s.availability = await api.availability({ expectedInputs: OPTIONS.expectedInputs, expectedOutputs: OPTIONS.expectedOutputs });
      try { s.params = await api.params?.(); } catch (e) { s.paramsError = String(e); }
    }
    result.steps.check = s;
    status(api ? `LanguageModel 可用性：${s.availability}` : '此瀏覽器沒有 LanguageModel API（可能需要較新的 Chrome 或啟用旗標）', !api);
    lock('btnCold', !api || s.availability === 'unavailable');
    if (api && s.availability === 'available') { lock('btnAcc', false); lock('btnWarm', false); }
  } catch (e) { status('檢查失敗：' + e.message, true); result.steps.checkError = String(e); }
  setBusy(false); lock('btnDownload', false); refresh();
};

// 2. 建立工作階段並下載模型（冷啟動）。必須由使用者點擊觸發。
$('btnCold').onclick = async () => {
  setBusy(true);
  const before = await self.LanguageModel.availability({ expectedInputs: OPTIONS.expectedInputs, expectedOutputs: OPTIONS.expectedOutputs });
  const progress = [];
  const t0 = performance.now();
  try {
    status('建立中（如需下載會顯示進度）…');
    const session = await self.LanguageModel.create({
      ...OPTIONS,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { progress.push({ tMs: Math.round(performance.now() - t0), loaded: e.loaded }); status(`下載進度 ${(e.loaded * 100).toFixed(1)}%（${Math.round((performance.now() - t0) / 1000)} 秒）`); }); },
    });
    const createMs = performance.now() - t0;
    const first = await timedPrompt(session, 'The food was wonderful and the staff were kind.');
    result.cold = { availabilityBefore: before, createMs, downloadEvents: progress.length, progressTail: progress.slice(-3), firstPromptMs: first.ms, firstLabel: first.label };
    session.destroy();
    result.steps.afterCold = await self.LanguageModel.availability({ expectedInputs: OPTIONS.expectedInputs, expectedOutputs: OPTIONS.expectedOutputs });
    status(`冷啟動完成：建立 ${(createMs / 1000).toFixed(1)} 秒（建立前狀態：${before}）`);
    lock('btnAcc', false); lock('btnWarm', false);
  } catch (e) { status('建立失敗：' + e.message, true); result.cold = { availabilityBefore: before, error: String(e), progressTail: progress.slice(-3) }; }
  setBusy(false); refresh();
};

// 3. 36 句準確率：每句使用複製出來的工作階段，避免前面的句子留在上下文影響結果
$('btnAcc').onclick = async () => {
  setBusy(true);
  try {
    const items = await loadSentences();
    const base = await self.LanguageModel.create(OPTIONS);
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      status(`準確率檢查 ${i + 1}/${items.length}`);
      const s = await base.clone();
      const r = await timedPrompt(s, items[i].text);
      s.destroy();
      rows.push({ i, expected: items[i].label, label: r.label, correct: r.label === items[i].label, ms: r.ms, words: items[i].words });
    }
    base.destroy();
    const correct = rows.filter((r) => r.correct).length;
    result.accuracy = { correct, total: rows.length, medianMs: median(rows.map((r) => r.ms)), rows };
    status(`準確率 ${correct}/${rows.length}`);
  } catch (e) { status('準確率檢查失敗：' + e.message, true); result.accuracy = { error: String(e) }; }
  setBusy(false); refresh();
};

// 4. 暖啟動：模型已在本機。5 輪，每輪新建工作階段（記錄建立時間），連續 10 次推論（第 1 次與第 2 至 10 次分開）。
// 任一輪失敗時記錄失敗階段與錯誤內容，等待 3 秒後繼續下一輪；連續失敗 3 輪就停止。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
$('btnWarm').onclick = async () => {
  setBusy(true);
  result.warm = []; result.warmFailures = [];
  try {
    const items = await loadSentences();
    let consecutive = 0;
    for (let round = 1; round <= 8 && result.warm.length < 5 && consecutive < 3; round++) {
      status(`暖啟動第 ${round} 次嘗試（已成功 ${result.warm.length}/5 輪）`);
      let stage = 'create', session = null;
      try {
        const t0 = performance.now();
        session = await self.LanguageModel.create(OPTIONS);
        const createMs = performance.now() - t0;
        const calls = [];
        for (let i = 0; i < 10; i++) {
          stage = `prompt ${i + 1}`;
          const it = items[i % items.length];
          const r = await timedPrompt(session, it.text);
          calls.push({ i, ms: r.ms, label: r.label, expected: it.label, correct: r.label === it.label });
        }
        result.warm.push({ attempt: round, createMs, firstMs: calls[0].ms, steadyMedianMs: median(calls.slice(1).map((c) => c.ms)), calls });
        consecutive = 0;
      } catch (e) {
        consecutive++;
        result.warmFailures.push({ attempt: round, stage, name: e && e.name, message: String((e && e.message) || e), availability: await self.LanguageModel.availability({ expectedInputs: OPTIONS.expectedInputs, expectedOutputs: OPTIONS.expectedOutputs }).catch((x) => 'error:' + x) });
        status(`第 ${round} 次嘗試失敗（階段：${stage}）：${e && e.message}`, true);
      } finally {
        try { session && session.destroy(); } catch { /* 忽略 */ }
        await sleep(3000);
      }
    }
    status(`暖啟動量測結束：成功 ${result.warm.length} 輪，失敗 ${result.warmFailures.length} 次`);
  } catch (e) { status('暖啟動量測失敗：' + e.message, true); result.warmError = String(e); }
  setBusy(false); refresh();
};

$('btnDownload').onclick = async () => {
  const envNow = await environment();
  const env = { ...(result.environment || {}), ...envNow };
  const name = `builtin-ai-${env.device || 'device'}-${env.browser || 'browser'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  result.environment = { ...(result.environment || {}), ...(await environment()) }; // 下載時重新讀取欄位
  result.exportedAt = new Date().toISOString();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  a.download = name; a.click();
};

function renderSummary() {
  const rows = [];
  const fmt = (n, d = 1) => (n == null ? '—' : Number(n).toFixed(d));
  const s = result.steps;
  if (s.check) rows.push(['可用性', s.check.apiExists ? s.check.availability : 'API 不存在']);
  if (result.cold) rows.push(['冷啟動建立 (ms)', result.cold.error ? '失敗：' + result.cold.error : `${fmt(result.cold.createMs, 0)}（建立前：${result.cold.availabilityBefore}，下載事件 ${result.cold.downloadEvents} 次）`], ['冷啟動後第 1 次推論 (ms)', fmt(result.cold.firstPromptMs)]);
  if (result.accuracy && !result.accuracy.error) rows.push(['36 句準確率', `${result.accuracy.correct}/${result.accuracy.total}`], ['單句推論中位數 (ms)', fmt(result.accuracy.medianMs)]);
  if (result.warmFailures && result.warmFailures.length) rows.push(['暖啟動失敗', result.warmFailures.map((f) => `第 ${f.attempt} 次（${f.stage}）：${f.message}`).join('；')]);
  if (result.warm.length) {
    rows.push(['暖啟動建立 (ms)', `${fmt(median(result.warm.map((w) => w.createMs)))}（${fmt(Math.min(...result.warm.map((w) => w.createMs)))} 至 ${fmt(Math.max(...result.warm.map((w) => w.createMs)))}）`]);
    rows.push(['第 1 次推論 (ms)', `${fmt(median(result.warm.map((w) => w.firstMs)))}（${fmt(Math.min(...result.warm.map((w) => w.firstMs)))} 至 ${fmt(Math.max(...result.warm.map((w) => w.firstMs)))}）`]);
    const steady = result.warm.flatMap((w) => w.calls.slice(1).map((c) => c.ms));
    rows.push(['穩態推論 (ms)', `${fmt(median(steady))}（${fmt(Math.min(...steady))} 至 ${fmt(Math.max(...steady))}）n=${steady.length}`]);
  }
  $('summary').innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
}
refresh();
