import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpecdepsError } from '../core/errors.js';
import type { InitFile } from '../core/engine.js';

export const PROTOTYPE_FILES = [
  'gitignore',
  'specdeps.yaml',
  'sources/payments.md',
  'sources/shipping.md',
  'sources/checkout-policy.md',
  'docs/payments-summary.md',
  'docs/shipping.md',
  'docs/unrelated.md',
  'specs/checkout.md',
  'prompts/summarize.md',
  'prompts/spec.md',
  'prompts/risk.md',
  'prompts/shipping.md',
  'scripts/generate.mjs',
] as const;

export function minimalManifestFile(): InitFile {
  return { path: 'specdeps.yaml', bytes: Buffer.from('version: 1\n\ntargets: {}\n', 'utf8') };
}

export function loadPrototypeFiles(): InitFile[] {
  const root = prototypeRoot();
  return PROTOTYPE_FILES.map((rel) => ({
    path: rel === 'gitignore' ? '.gitignore' : rel,
    bytes: readFileSync(path.join(root, rel)),
  }));
}

export function prototypeRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'examples', 'prototype', 'specdeps.yaml');
    if (existsSync(candidate)) return path.join(dir, 'examples', 'prototype');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SpecdepsError('could not find examples/prototype in the specdeps package', 'prototype-missing');
}
