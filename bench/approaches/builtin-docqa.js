// 任務 B（依文件回答問題）：Chrome 內建 AI（Prompt API，LanguageModel），模型由瀏覽器決定（Gemini Nano）。
// 只能在主執行緒呼叫；只支援英文（中文回報 unavailable，見研究日誌 F25）。
// 網頁版 Prompt API 無法設定 temperature 等取樣參數，使用瀏覽器預設值。
// 計時：M2／M3 為 LanguageModel.create()（含系統提示）；每題先 clone() 一個新工作階段再提問
//       （同一工作階段連續提問曾失敗，見 F40），clone 時間計入該題延遲。
// M4／M5 為送出到第一段串流文字；M6 的單位為「串流片段／秒」，片段不等於 token，不可與 WebLLM 直接比較。
// 冷啟動建議輪數為 0：內建模型是瀏覽器層級資源，清除網站資料無法重現模型下載（模型下載時間另見 F39）。
import { resourceBytes } from '../bench.js';
import { SYSTEM_PROMPT, userPrompt, loadDocQA, result, summarize, labelOf } from './docqa-common.js';

const LANG_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

export default {
  id: 'builtin-docqa',
  label: '任務 B：Chrome 內建 AI（Prompt API）依文件回答問題',
  task: 'docqa',
  kind: 'generate',
  modes: ['main'],

  async getInputs(ctx) {
    const lang = (ctx.options && ctx.options.lang) || 'en';
    if (lang !== 'en') throw new Error('Chrome 內建 AI 不支援中文（availability 回報 unavailable），只測英文');
    return loadDocQA('en');
  },

  async load(ctx) {
    if (!self.LanguageModel) throw new Error('此瀏覽器沒有 LanguageModel（Prompt API）');
    ctx.shared.availability = await self.LanguageModel.availability(LANG_OPTS);
    if (ctx.shared.availability !== 'available') throw new Error(`模型狀態為 ${ctx.shared.availability}，請先在內建 AI 檢查頁完成下載`);
  },

  async create(ctx) {
    const base = await self.LanguageModel.create({
      ...LANG_OPTS,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT.en }],
    });
    return { base, availability: ctx.shared.availability };
  },

  async infer(handle, item, hooks) {
    const s = await handle.base.clone();
    try {
      let text = '';
      for await (const chunk of s.promptStreaming(userPrompt(item))) {
        // 新版為逐段增量；若遇到舊版的累積全文，改為直接取代
        if (text && chunk.startsWith(text)) text = chunk; else text += chunk;
        hooks.onToken(1);
      }
      if (!text) hooks.onToken(1);
      return result(item, text, { inputUsage: s.inputUsage ?? null, inputQuota: s.inputQuota ?? null });
    } finally {
      s.destroy();
    }
  },

  summarizeOutput: summarize,
  labelOf,

  async getTransferBytes(handle, sinceEpochMs) {
    return {
      ...resourceBytes(sinceEpochMs),
      config: { api: 'LanguageModel', availability: handle.availability, inputQuota: handle.base.inputQuota ?? null, samplingParams: 'browser default' },
    };
  },

  async dispose(handle) { handle.base.destroy(); },
};
