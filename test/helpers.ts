import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPrototypeFiles } from '../src/init/prototype.js';
import { createProcessRunner } from '../src/exec/runner.js';
import type { GeneratorRequest, GeneratorRunner, TargetDecl } from '../src/core/types.js';

export const EXCEPTION = 'Client exception: refunds require manual approval above $500.';

export function makeProject(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'specdeps-')));
  for (const file of loadPrototypeFiles()) {
    const dest = path.join(dir, file.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.bytes);
  }
  return dir;
}

export function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function trackingRunner(root: string): { calls: GeneratorRequest[]; runner: GeneratorRunner } {
  const inner = createProcessRunner(root);
  const calls: GeneratorRequest[] = [];
  const runner: GeneratorRunner = async (target: TargetDecl, request: GeneratorRequest) => {
    calls.push(structuredClone(request));
    return inner(target, request);
  };
  return { calls, runner };
}
