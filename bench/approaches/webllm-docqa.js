// 任務 B（依文件回答問題）：WebLLM 0.2.86 + Qwen3-0.6B（q4f16_1），關閉思考模式。
// 主執行緒與 Worker 皆支援；Worker 使用官方的 WebWorkerMLCEngine（PoC 的預設做法）。
// 進階選項（JSON）：
//   lang        en（預設）或 zh；英文 12 題、中文 4 題，「每輪推論次數」請設為題數
//   maxTokens   回答的最多 token 數，預設 48
//   libraryUrl  覆寫函式庫網址（本機驗證用）
// 計時：M2／M3 為 reload(模型) 從呼叫到完成；M4／M5 為送出到第一段文字（TTFT）；
//       M6 為之後每段文字的速度（WebLLM 每段串流輸出約為一個 token）。
import { resourceBytes } from '../bench.js';
import { LIBRARY_URL, LIBRARY_VERSION, MODEL_ID, CACHE_PREFIX, forceNoStore } from './webllm-core.js';
import { SYSTEM_PROMPT, userPrompt, loadDocQA, result, summarize, labelOf, cacheStorageBytes, cacheEntryCount } from './docqa-common.js';

function normalize(ctx) {
  const o = ctx.options || {};
  const lang = o.lang || 'en';
  if (!['en', 'zh'].includes(lang)) throw new Error(`lang 不支援：${lang}（可用：en、zh）`);
  const maxTokens = o.maxTokens ?? 48;
  if (!(Number.isInteger(maxTokens) && maxTokens >= 8 && maxTokens <= 512)) throw new Error('maxTokens 必須是 8 到 512 的整數');
  return { lang, maxTokens, libraryUrl: o.libraryUrl || LIBRARY_URL };
}

export default {
  id: 'webllm-docqa',
  label: '任務 B：WebLLM + Qwen3-0.6B 依文件回答問題',
  task: 'docqa',
  kind: 'generate',
  modes: ['worker', 'main'],
  // 模型大小未有官方數字可比對，不設預期大小；冷暖啟動以 cacheEntriesBefore 判斷（冷啟動應為 0）。

  async getInputs(ctx) {
    return loadDocQA(normalize(ctx).lang);
  },

  // 函式庫載入、Worker 建立不計入 M2／M3
  async load(ctx) {
    const cfg = (ctx.shared.cfg = normalize(ctx));
    const cold = ctx.phase === 'cold';
    ctx.shared.cacheEntriesBefore = await cacheEntryCount(CACHE_PREFIX);
    const lib = await import(/* webpackIgnore: true */ cfg.libraryUrl);
    ctx.shared.lib = lib;
    if (ctx.mode === 'worker') {
      const url = new URL('./webllm-worker.js', import.meta.url);
      if (cold) url.searchParams.set('cold', '1');
      if (cfg.libraryUrl !== LIBRARY_URL) url.searchParams.set('lib', cfg.libraryUrl);
      const worker = new Worker(url, { type: 'module' });
      await new Promise((resolve, reject) => {
        const onMsg = (ev) => { if (ev.data && ev.data.benchReady) { worker.removeEventListener('message', onMsg); resolve(); } };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', (e) => reject(new Error(e.message || 'Worker 載入失敗')), { once: true });
      });
      ctx.shared.worker = worker;
      ctx.shared.engine = new lib.WebWorkerMLCEngine(worker, {});
    } else {
      if (cold) forceNoStore(self);
      ctx.shared.engine = new lib.MLCEngine({});
    }
  },

  async create(ctx) {
    const engine = ctx.shared.engine;
    await engine.reload(MODEL_ID);
    return { engine, worker: ctx.shared.worker || null, cfg: ctx.shared.cfg, cacheEntriesBefore: ctx.shared.cacheEntriesBefore };
  },

  async infer(handle, item, hooks) {
    const { engine, cfg } = handle;
    const stream = await engine.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT[item.lang] },
        { role: 'user', content: userPrompt(item) },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: cfg.maxTokens,
      extra_body: { enable_thinking: false },
    });
    let text = '';
    let usage = null;
    for await (const chunk of stream) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) { text += d; hooks.onToken(1); }
      if (chunk.usage) usage = chunk.usage;
    }
    // 少數情況下整段沒有可見文字（例如只輸出結束符號），仍記一次，避免框架判定為錯誤
    if (!text) hooks.onToken(1);
    return result(item, text, {
      promptTokens: usage ? usage.prompt_tokens : null,
      completionTokens: usage ? usage.completion_tokens : null,
    });
  },

  summarizeOutput: summarize,
  labelOf,

  async getTransferBytes(handle, sinceEpochMs) {
    const rt = resourceBytes(sinceEpochMs);
    const cs = await cacheStorageBytes(CACHE_PREFIX);
    return {
      ...rt,
      cacheStorageBytes: cs.total,
      cacheStorageEntries: cs.entries,
      cacheStorageFiles: cs.files,
      cacheEntriesBefore: handle.cacheEntriesBefore,
      config: { libraryVersion: LIBRARY_VERSION, model: MODEL_ID, lang: handle.cfg.lang, maxTokens: handle.cfg.maxTokens, temperature: 0, enableThinking: false },
    };
  },

  async dispose(handle) {
    try { await handle.engine.unload(); } finally { handle.worker?.terminate(); }
  },
};
