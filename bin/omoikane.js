#!/usr/bin/env -S node --import tsx/esm
// DEV ONLY — runs TypeScript source directly via tsx.
// Only works when invoked from the project root (where node_modules/tsx lives).
// For production use, run `pnpm build` and use dist/omoikane.js instead.
import '../src/cli/index.ts';
