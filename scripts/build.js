#!/usr/bin/env node
// Compiles src/cli/index.ts into a standalone dist/omoikane.js binary.
// Runtime dependencies (@anthropic-ai/sdk, better-sqlite3, js-yaml) remain
// external so they resolve from the installed package's node_modules.
import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@anthropic-ai/sdk', 'better-sqlite3', 'js-yaml'],
  outfile: 'dist/omoikane.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});

chmodSync('dist/omoikane.js', 0o755);
