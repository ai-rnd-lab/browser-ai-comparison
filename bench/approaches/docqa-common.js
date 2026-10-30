// 任務 B（依文件回答問題）共用：測試資料載入、提示詞、評分。
// 測試資料：site/data/docqa.json，全部為自行撰寫的虛構文件（見檔內 note）。
// 評分規則（寫在量測之前，不依結果調整）：
//   一般題：回答（去除大小寫、空白、逗號後）包含任一個可接受答案，且沒有回答「文件未提及」，即為答對。
//   無答案題：回答包含「文件未提及」的固定字串（英文 NOT IN DOCUMENT、中文 文件未提及），即為答對。
export const SYSTEM_PROMPT = {
  en: 'You answer questions using only the document provided by the user. Reply with a short answer of a few words. If the document does not contain the answer, reply exactly: NOT IN DOCUMENT',
  zh: '你只能根據使用者提供的文件回答問題。請用簡短的幾個字回答。如果文件沒有提到答案，請只回答：文件未提及',
};

export function userPrompt(item) {
  return item.lang === 'zh'
    ? `文件：\n<<<\n${item.text}\n>>>\n\n問題：${item.question}`
    : `Document:\n<<<\n${item.text}\n>>>\n\nQuestion: ${item.question}`;
}

// 回傳 { inputs, labels }：inputs 為題目物件，labels 為題目編號（runRound 以 labelOf 比對）。
// 題目依文件輪流排列（第 1 篇第 1 題、第 2 篇第 1 題……），讓每輪前幾次推論涵蓋不同文件。
export async function loadDocQA(lang = 'en') {
  const res = await fetch(new URL('../../data/docqa.json', import.meta.url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`測試資料載入失敗：${res.status}`);
  const data = await res.json();
  const docs = data.documents.filter((d) => d.lang === lang);
  if (!docs.length) throw new Error(`沒有 ${lang} 的測試文件`);
  const notFound = data.notFound[lang];
  const items = [];
  const maxQ = Math.max(...docs.map((d) => d.questions.length));
  for (let i = 0; i < maxQ; i++) {
    for (const d of docs) {
      const q = d.questions[i];
      if (!q) continue;
      items.push({ qid: q.id, docId: d.id, lang, text: d.text, question: q.q, accept: q.accept, unanswerable: !!q.unanswerable, notFound });
    }
  }
  return { inputs: items, labels: items.map((x) => x.qid) };
}

const norm = (s) => String(s).toLowerCase().replace(/[\s,，。、"'「」]/g, '').replace(/\.$/, '');

// 含數字的答案要求前後不緊鄰其他數字（避免 16 被當成 6、23180 被當成 2318）
function contains(a, x) {
  const n = norm(x);
  if (!/[0-9]/.test(n)) return a.includes(n);
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9])${esc}($|[^0-9])`).test(a);
}

export function grade(item, answer) {
  const a = norm(answer);
  const saidNotFound = a.includes(norm(item.notFound));
  if (item.unanswerable) return saidNotFound;
  if (saidNotFound) return false;
  return item.accept.some((x) => contains(a, x));
}

// 輸出統一格式，供 summarizeOutput 與 labelOf 使用
export function result(item, answer, extra = {}) {
  const correct = grade(item, answer);
  return { qid: item.qid, answer, correct, ...extra };
}
export const summarize = (out) => `${out.correct ? 'O' : 'X'} ${out.qid}: ${out.answer.replace(/\s+/g, ' ').trim()}`;
export const labelOf = (out) => (out.correct ? out.qid : `wrong:${out.qid}`);

// Cache Storage 實際存放量（與任務 A 相同的計算方式）
export async function cacheStorageBytes(prefix = '') {
  const files = {};
  let total = 0;
  let entries = 0;
  try {
    for (const name of await caches.keys()) {
      if (prefix && !name.startsWith(prefix)) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const r = await cache.match(req);
        if (!r) continue;
        const size = (await r.blob()).size;
        files[`${name}:${new URL(req.url).pathname.split('/').slice(-2).join('/')}`] = size;
        total += size;
        entries += 1;
      }
    }
  } catch (e) {
    return { total: null, entries: null, files, error: String((e && e.message) || e) };
  }
  return { total, entries, files };
}

export async function cacheEntryCount(prefix = '') {
  let n = 0;
  try {
    for (const name of await caches.keys()) {
      if (prefix && !name.startsWith(prefix)) continue;
      n += (await (await caches.open(name)).keys()).length;
    }
  } catch { return null; }
  return n;
}
