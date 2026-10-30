// 展示頁：情緒分類（WebGPU 不可用時改走 Wasm）與依文件回答問題（Chrome 內建 AI 或 WebLLM）。
// 推論一律在 Web Worker 執行（Chrome 內建 AI 只能由頁面呼叫，但推論在頁面以外執行，不會卡住畫面）。
// 沿用量測頁已驗證的模組：bench/approaches/transformers-worker.js、webllm-worker.js、docqa-common.js。
import { createWorkerProxy } from '../bench/bench.js';
import { SYSTEM_PROMPT, userPrompt } from '../bench/approaches/docqa-common.js';
import { LIBRARY_URL as WEBLLM_URL, MODEL_ID as WEBLLM_MODEL } from '../bench/approaches/webllm-core.js';

const $ = (id) => document.getElementById(id);
const force = new URL(location.href).searchParams.get('force');
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`);
const isZh = (s) => /[㐀-鿿]/.test(s);

const env = { webgpu: false, webgpuReason: '', builtin: 'unavailable', coi: window.crossOriginIsolated === true };

async function detect() {
  if (force === 'wasm') env.webgpuReason = '網址指定 force=wasm（示範用）';
  else if (!('gpu' in navigator)) env.webgpuReason = '此瀏覽器沒有 WebGPU';
  else {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) env.webgpu = true; else env.webgpuReason = '找不到可用的顯示卡介面卡';
    } catch (e) { env.webgpuReason = `偵測失敗：${(e && e.message) || e}`; }
  }
  if (self.LanguageModel) {
    try {
      env.builtin = await self.LanguageModel.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });
    } catch { env.builtin = 'unavailable'; }
  }
  const builtinText = { available: '可用（模型已在此瀏覽器）', downloadable: '需先下載模型（約數 GB，本頁不觸發下載）', downloading: '下載中', unavailable: '不可用' }[env.builtin] || env.builtin;
  $('env').innerHTML = `
    <div><b>WebGPU</b><span class="${env.webgpu ? 'ok' : 'warn'}">${env.webgpu ? '可用' : '不可用：' + env.webgpuReason}</span></div>
    <div><b>情緒分類的執行方式</b><span>${env.webgpu ? 'WebGPU（顯示卡）' : 'Wasm（處理器）' + (env.coi ? '，多執行緒' : '，單執行緒')}</span></div>
    <div><b>Chrome 內建 AI</b><span class="${env.builtin === 'available' ? 'ok' : 'muted'}">${builtinText}</span></div>`;
}

// ---------- 一、情緒分類 ----------
let sent = null;
async function ensureSentiment() {
  if (sent) return sent;
  const proxy = createWorkerProxy(new URL('../bench/approaches/transformers-worker.js', import.meta.url));
  await proxy.call('load', {});
  const device = env.webgpu ? 'webgpu' : 'wasm';
  const t0 = performance.now();
  const info = await proxy.call('prepare', { dtype: 'fp16', device });
  sent = { proxy, device, prepareMs: performance.now() - t0, info };
  return sent;
}

$('sentBtn').onclick = async () => {
  const text = $('sentText').value.trim();
  if (!text) return;
  $('sentBtn').disabled = true;
  try {
    const first = !sent;
    $('sentOut').textContent = first ? '準備模型中（第一次需下載）…' : '分類中…';
    const s = await ensureSentiment();
    const t0 = performance.now();
    const out = await s.proxy.call('classify', text);
    const ms = performance.now() - t0;
    const label = out.label === 'POSITIVE' ? '正面' : '負面';
    $('sentOut').innerHTML = `<b>${label}</b>（信心 ${(out.score * 100).toFixed(1)}%）　分類耗時 ${fmt(ms)}　執行方式：${s.device === 'webgpu' ? 'WebGPU' : 'Wasm'}` +
      (first ? `\n<span class="muted">本次先準備模型 ${fmt(s.prepareMs)}</span>` : '');
  } catch (e) {
    $('sentOut').innerHTML = `<span class="bad">失敗：${(e && e.message) || e}</span>`;
  } finally {
    $('sentBtn').disabled = false;
  }
};

// ---------- 二、依文件回答問題 ----------
const SAMPLE_DOC_ID = 'en-policy';
async function loadSampleDoc() {
  try {
    const res = await fetch('../data/docqa.json');
    const data = await res.json();
    $('qaDoc').value = data.documents.find((d) => d.id === SAMPLE_DOC_ID).text;
  } catch { $('qaDoc').value = ''; }
}

function fillEngines() {
  const sel = $('qaEngine');
  const opts = [];
  if (env.builtin === 'available') opts.push(['builtin', 'Chrome 內建 AI（Gemini Nano，只支援英文）']);
  if (env.webgpu) opts.push(['webllm', `WebLLM + Qwen3-0.6B（約 353 MB，支援中文）`]);
  if (!opts.length) {
    sel.innerHTML = '<option value="">此環境沒有可用的模型</option>';
    sel.disabled = true; $('qaBtn').disabled = true;
    $('qaNote').textContent = '依文件回答問題需要 Chrome 內建 AI，或支援 WebGPU 的瀏覽器（WebLLM）。此環境兩者皆不可用，因此本功能停用；情緒分類仍可使用。';
    return;
  }
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('qaNote').textContent = '每次提問都是獨立的新對話，不保留前一題的內容。';
}

let builtinBase = null;
let webllm = null;

async function askBuiltin(item, onText) {
  if (!builtinBase) {
    builtinBase = await self.LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT.en }],
    });
  }
  const s = await builtinBase.clone();
  try {
    let text = '';
    for await (const chunk of s.promptStreaming(userPrompt(item))) {
      if (text && chunk.startsWith(text)) text = chunk; else text += chunk;
      onText(text);
    }
    return text;
  } finally { s.destroy(); }
}

async function ensureWebLLM(onProgress) {
  if (webllm) return webllm;
  const lib = await import(WEBLLM_URL);
  const worker = new Worker(new URL('../bench/approaches/webllm-worker.js', import.meta.url), { type: 'module' });
  await new Promise((resolve, reject) => {
    worker.addEventListener('message', (ev) => { if (ev.data && ev.data.benchReady) resolve(); });
    worker.addEventListener('error', (e) => reject(new Error(e.message || 'Worker 載入失敗')), { once: true });
  });
  const engine = new lib.WebWorkerMLCEngine(worker, { initProgressCallback: (r) => onProgress(r.text) });
  await engine.reload(WEBLLM_MODEL);
  webllm = engine;
  return webllm;
}

async function askWebLLM(item, onText, onProgress) {
  const engine = await ensureWebLLM(onProgress);
  const stream = await engine.chat.completions.create({
    messages: [{ role: 'system', content: SYSTEM_PROMPT[item.lang] }, { role: 'user', content: userPrompt(item) }],
    stream: true, temperature: 0, max_tokens: 96, extra_body: { enable_thinking: false },
  });
  let text = '';
  for await (const chunk of stream) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
    if (d) { text += d; onText(text); }
  }
  return text;
}

const clean = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

$('qaBtn').onclick = async () => {
  const engineId = $('qaEngine').value;
  const doc = $('qaDoc').value.trim();
  const question = $('qaQuestion').value.trim();
  if (!engineId || !doc || !question) return;
  const lang = isZh(doc + question) ? 'zh' : 'en';
  if (engineId === 'builtin' && lang === 'zh') {
    $('qaOut').innerHTML = '<span class="warn">Chrome 內建 AI 不支援中文，請改用 WebLLM，或改用英文文件與問題。</span>';
    return;
  }
  if (engineId === 'webllm' && !webllm && !confirm('第一次使用 WebLLM 需要下載約 353 MB 的模型，下載後存放在此瀏覽器。要繼續嗎？')) return;
  $('qaBtn').disabled = true; $('qaEngine').disabled = true;
  const item = { lang, text: doc, question };
  const t0 = performance.now();
  let tFirst = null;
  const onText = (t) => { if (tFirst === null) tFirst = performance.now(); $('qaOut').textContent = clean(t) || '…'; };
  const onProgress = (msg) => { $('qaOut').textContent = `準備模型中：${msg}`; };
  try {
    $('qaOut').textContent = '處理中…';
    const answer = engineId === 'builtin' ? await askBuiltin(item, onText) : await askWebLLM(item, onText, onProgress);
    const total = performance.now() - t0;
    $('qaOut').innerHTML = `<b>${clean(answer).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</b>` +
      `\n<span class="muted">總耗時 ${fmt(total)}${tFirst !== null ? `，開始出字 ${fmt(tFirst - t0)}` : ''}（第一次使用時包含準備模型的時間）</span>`;
  } catch (e) {
    $('qaOut').innerHTML = `<span class="bad">失敗：${(e && e.message) || e}</span>`;
  } finally {
    $('qaBtn').disabled = false; $('qaEngine').disabled = false;
  }
};

await detect();
fillEngines();
await loadSampleDoc();
