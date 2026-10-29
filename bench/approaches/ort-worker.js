import { serve } from '../worker-runtime.js';
import { loadLibrary, prepare, classify, dispose, cacheStorageBytes } from './ort-core.js';

serve({
  load: async (payload) => { await loadLibrary(payload && payload.libraryUrl); return true; },
  prepare: (options) => prepare(options),
  classify: (text) => classify(text),
  cacheBytes: () => cacheStorageBytes(),
  dispose: () => dispose(),
});
