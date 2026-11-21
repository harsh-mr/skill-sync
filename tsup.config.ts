import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
    onSuccess: async () => {
      const srcUi = path.resolve('src/ui');
      const distUi = path.resolve('dist/ui');
      if (fs.existsSync(srcUi)) {
        fs.cpSync(srcUi, distUi, { recursive: true });
      }
    },
  },
  {
    entry: {
      'core/index': 'src/core/index.ts',
    },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
  },
]);
