import { serve } from '../worker-runtime.js';
import { prepareModel, classify } from './selftest-core.js';

serve({
  load: async () => true,
  prepare: (payload) => prepareModel(payload),
  classify: (input) => classify(input),
});
