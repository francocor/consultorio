import { buildBundle } from './build-bundle.js';

// `pnpm --filter @consultorio/api build`: the bundle in `dist/`, with the migrations beside it.
await buildBundle();
