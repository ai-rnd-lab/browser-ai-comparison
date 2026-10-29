// ONNX Runtime Web 直接呼叫（對照 Transformers.js 的函式庫層成本）：同一份 DistilBERT SST-2 ONNX 檔，
// 分詞（BERT uncased WordPiece）由本檔自行實作，不使用 Transformers.js。主執行緒與 Worker 共用。
import { resourceBytes } from '../bench.js';
import { EXPECTED_BYTES } from './transformers-core.js';

export { EXPECTED_BYTES };
// 與 Transformers.js 4.3.1 內建的 ONNX Runtime Web 同一個版本，才能只比較函式庫層的差異。
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const MODEL_ID = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
const CACHE_NAME = 'bench-ort-cache';

let ort = null;
let session = null;
let tokenizer = null;
let id2label = null;

export async function loadLibrary(url = ORT_BASE + 'ort.webgpu.min.mjs') {
  if (!ort) ort = await import(/* webpackIgnore: true */ url);
  return ort;
}

// 取得檔案：冷啟動略過 HTTP 快取並存入 Cache Storage，暖啟動優先讀 Cache Storage。回傳位元組。
async function getBytes(url, { noStore }) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), fromCache: true };
  const res = await fetch(url, noStore ? { cache: 'no-store' } : {});
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${url}`);
  await cache.put(url, res.clone());
  return { bytes: new Uint8Array(await res.arrayBuffer()), fromCache: false };
}

// ---- BERT uncased WordPiece 分詞 ----
const isPunct = (ch) => {
  const c = ch.codePointAt(0);
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  return /\p{P}/u.test(ch);
};
const isCjk = (c) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) ||
  (c >= 0x2a700 && c <= 0x2ebef) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

function buildTokenizer(json) {
  const vocab = json.model.vocab;
  const unk = vocab[json.model.unk_token || '[UNK]'];
  const cls = vocab['[CLS]'], sep = vocab['[SEP]'];
  const prefix = json.model.continuing_subword_prefix || '##';
  const maxChars = json.model.max_input_chars_per_word || 100;

  function normalize(text) {
    let out = '';
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 0 || c === 0xfffd) continue;
      if (/\p{Cc}/u.test(ch) && !/[\t\n\r]/.test(ch)) continue;
      if (/\s/.test(ch)) { out += ' '; continue; }
      out += isCjk(c) ? ` ${ch} ` : ch;
    }
    return out.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  }
  function pretokenize(text) {
    const words = [];
    let cur = '';
    for (const ch of text) {
      if (ch === ' ') { if (cur) words.push(cur); cur = ''; }
      else if (isPunct(ch)) { if (cur) words.push(cur); cur = ''; words.push(ch); }
      else cur += ch;
    }
    if (cur) words.push(cur);
    return words;
  }
  function wordpiece(word) {
    const chars = [...word];
    if (chars.length > maxChars) return [unk];
    const ids = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found = null;
      while (start < end) {
        let piece = chars.slice(start, end).join('');
        if (start > 0) piece = prefix + piece;
        if (piece in vocab) { found = vocab[piece]; break; }
        end--;
      }
      if (found === null) return [unk];
      ids.push(found);
      start = end;
    }
    return ids;
  }
  return {
    encode(text) {
      const ids = [cls];
      for (const w of pretokenize(normalize(text))) ids.push(...wordpiece(w));
      ids.push(sep);
      return ids.length > 512 ? [...ids.slice(0, 511), sep] : ids;
    },
  };
}

// 建立工作階段（計入準備時間）。
// options：dtype、device（webgpu、wasm）、numThreads（只影響 wasm）、noStoreFetch、
//         libraryUrl / wasmMjsUrl / wasmUrl / remoteHost（自架來源，驗證用）。
export async function prepare(options = {}) {
  const lib = await loadLibrary(options.libraryUrl);
  const dtype = options.dtype || 'fp16';
  const device = options.device || 'webgpu';
  const host = (options.remoteHost || 'https://huggingface.co/').replace(/\/?$/, '/');
  const base = `${host}${MODEL_ID}/resolve/main/`;
  const modelFile = dtype === 'fp32' ? 'model.onnx' : `model_${dtype}.onnx`;
  const noStore = options.noStoreFetch === true;

  let cacheEntriesBefore = null;
  try { cacheEntriesBefore = (await (await caches.open(CACHE_NAME)).keys()).length; } catch { /* 忽略 */ }

  const files = {};
  const take = async (url, name) => {
    const r = await getBytes(url, { noStore });
    files[name] = r.bytes.byteLength;
    return r.bytes;
  };
  const wasmMjsBytes = await take(options.wasmMjsUrl || ORT_BASE + 'ort-wasm-simd-threaded.asyncify.mjs', 'ort.mjs');
  const wasmBytes = await take(options.wasmUrl || ORT_BASE + 'ort-wasm-simd-threaded.asyncify.wasm', 'ort.wasm');
  const tokBytes = await take(base + 'tokenizer.json', 'tokenizer.json');
  const cfgBytes = await take(base + 'config.json', 'config.json');
  const modelBytes = await take(base + 'onnx/' + modelFile, modelFile);

  tokenizer = buildTokenizer(JSON.parse(new TextDecoder().decode(tokBytes)));
  id2label = JSON.parse(new TextDecoder().decode(cfgBytes)).id2label;

  lib.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([wasmMjsBytes], { type: 'text/javascript' })) };
  lib.env.wasm.wasmBinary = wasmBytes;
  if (typeof options.numThreads === 'number') lib.env.wasm.numThreads = options.numThreads;

  session = await lib.InferenceSession.create(modelBytes, { executionProviders: [device] });

  const libraryBytes = tokBytes.byteLength + cfgBytes.byteLength + modelBytes.byteLength;
  return {
    dtype, device, libraryVersion: ORT_VERSION, ortVersion: ORT_VERSION, numThreads: lib.env.wasm.numThreads ?? null,
    cacheEntriesBefore, libraryBytes, files,
  };
}

export async function classify(text) {
  if (!session) throw new Error('工作階段尚未建立');
  const ids = tokenizer.encode(text);
  const n = ids.length;
  const idsT = new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]);
  const maskT = new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
  const out = await session.run({ input_ids: idsT, attention_mask: maskT });
  const logits = Array.from(out.logits.data ?? await out.logits.getData());
  const m = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  const k = exps.indexOf(Math.max(...exps));
  return { label: id2label[k], score: exps[k] / sum };
}

export async function dispose() {
  try { await session?.release?.(); } catch { /* 忽略 */ }
  session = null;
  tokenizer = null;
}

export async function cacheStorageBytes() {
  const files = {};
  let total = 0;
  try {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        if (!res) continue;
        const size = (await res.blob()).size;
        files[`${name}:${new URL(req.url).pathname.split('/').slice(-2).join('/')}`] = size;
        total += size;
      }
    }
  } catch (e) {
    return { total: null, files, error: String((e && e.message) || e) };
  }
  return { total, files };
}
export { resourceBytes };
