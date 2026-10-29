// LiteRT.js 最小檢查：Google 提供的 MediaPipe BERT 文字分類模型（MobileBERT，SST-2 訓練，.tflite），
// 與 DistilBERT 不是同一個模型，只用來確認「LiteRT.js 能否在瀏覽器跑 BERT 類文字分類」，不做同模型比較。
// 分詞詞表與標籤取自 .tflite 檔尾附帶的中繼資料壓縮檔（vocab.txt、labels.txt），分詞沿用 ort-core.js 的實作。
import { buildTokenizer, cacheStorageBytes } from './ort-core.js';

export { cacheStorageBytes };
export const LITERT_VERSION = '2.6.0';
export const LITERT_BASE = `https://cdn.jsdelivr.net/npm/@litertjs/core@${LITERT_VERSION}/`;
export const DEFAULT_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/text_classifier/bert_classifier/float32/latest/bert_classifier.tflite';
const CACHE_NAME = 'bench-litert-cache';
const SEQ_LEN = 128;

let lib = null;
let model = null;
let tokenizer = null;
let labels = ['NEGATIVE', 'POSITIVE'];
let inputPlan = null; // 每個模型輸入對應 ids / mask / segment

// 預設載入本站 vendor 目錄內的打包檔（原因見 vendor/litert/README.md）
export async function loadLibrary(url = new URL('../../vendor/litert/litert.bundle.js', import.meta.url).href) {
  if (!lib) lib = await import(/* webpackIgnore: true */ url);
  return lib;
}

async function getBytes(url, noStore) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url, noStore ? { cache: 'no-store', mode: 'cors' } : { mode: 'cors' });
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${url}`);
  await cache.put(url, res.clone());
  return new Uint8Array(await res.arrayBuffer());
}

// 讀取 .tflite 檔尾附帶的 zip（TFLite 中繼資料的關聯檔案）。回傳 { 檔名: Uint8Array }。
async function readTrailingZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return {};
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  // zip 偏移量相對於 zip 起點；zip 前面接的是 tflite 本體，所以要用 EOCD 位置反推起點
  const zipStart = eocd - cdSize - cdOffset;
  const out = {};
  let p = zipStart + cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lp = zipStart + localOff;
    const dataStart = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (method === 0) out[name] = raw;
    else if (method === 8) {
      const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = new Uint8Array(await new Response(ds).arrayBuffer());
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// options：accelerator（webgpu、wasm）、threads、noStoreFetch、modelUrl / libraryUrl / wasmDir（自架來源，驗證用）。
export async function prepare(options = {}) {
  const L = await loadLibrary(options.libraryUrl);
  const accelerator = options.accelerator || 'webgpu';
  const modelUrl = options.modelUrl || DEFAULT_MODEL_URL;
  let cacheEntriesBefore = null;
  try { cacheEntriesBefore = (await (await caches.open(CACHE_NAME)).keys()).length; } catch { /* 忽略 */ }

  const modelBytes = await getBytes(modelUrl, options.noStoreFetch === true);
  const files = await readTrailingZip(modelBytes);
  const vocabFile = Object.keys(files).find((k) => /vocab/i.test(k));
  if (!vocabFile) throw new Error('模型檔內沒有找到詞表（vocab.txt），無法分詞');
  const vocab = {};
  new TextDecoder().decode(files[vocabFile]).split('\n').forEach((w, i) => { if (w !== '') vocab[w] = i; });
  tokenizer = buildTokenizer({ model: { vocab, unk_token: '[UNK]' } });
  const labelFile = Object.keys(files).find((k) => /label/i.test(k));
  if (labelFile) {
    const l = new TextDecoder().decode(files[labelFile]).split('\n').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (l.length >= 2) labels = l;
  }

  await L.loadLiteRt(options.wasmDir || LITERT_BASE + 'wasm/', { threads: options.threads === true });
  model = await L.loadAndCompile(modelBytes, { accelerator });

  inputPlan = model.getInputDetails().map((d) => (/seg/i.test(d.name) ? 'segment' : /mask/i.test(d.name) ? 'mask' : 'ids'));
  return {
    accelerator, device: accelerator, libraryVersion: LITERT_VERSION, ortVersion: null, numThreads: options.threads === true ? 'threaded' : 1,
    cacheEntriesBefore, libraryBytes: modelBytes.byteLength, files: { model: modelBytes.byteLength, ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.byteLength])) },
    inputs: inputPlan, labels,
    inputDetails: model.getInputDetails().map((d) => ({ name: d.name, dtype: String(d.dtype), shape: Array.from(d.shape) })),
    outputDetails: model.getOutputDetails().map((d) => ({ name: d.name, dtype: String(d.dtype), shape: Array.from(d.shape) })),
  };
}

export async function classify(text) {
  if (!model) throw new Error('模型尚未建立');
  const ids = tokenizer.encode(text).slice(0, SEQ_LEN);
  const n = ids.length;
  const idsArr = new Int32Array(SEQ_LEN); idsArr.set(ids);
  const maskArr = new Int32Array(SEQ_LEN).fill(0); maskArr.fill(1, 0, n);
  const segArr = new Int32Array(SEQ_LEN);
  const data = { ids: idsArr, mask: maskArr, segment: segArr };
  const tensors = inputPlan.map((k) => new lib.Tensor(data[k], [1, SEQ_LEN]));
  let outs;
  try { outs = await model.run(tensors); } finally { tensors.forEach((t) => t.delete()); }
  const raw = Array.from(await outs[0].data());
  outs.forEach((t) => t.delete());
  let p = raw;
  const inUnit = raw.every((x) => x >= 0 && x <= 1) && Math.abs(raw.reduce((a, b) => a + b, 0) - 1) < 1e-3;
  if (!inUnit) { const m = Math.max(...raw); const e = raw.map((x) => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); p = e.map((x) => x / s); }
  const k = p.indexOf(Math.max(...p));
  return { label: labels[k] ?? String(k), score: p[k], raw, tokens: n, firstIds: ids.slice(0, 6) };
}

export async function dispose() {
  try { model?.delete?.(); } catch { /* 忽略 */ }
  model = null; tokenizer = null;
}
