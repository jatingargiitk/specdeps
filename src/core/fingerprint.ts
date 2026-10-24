import { canonicalJson, sha256 } from './hash.js';
import type { InputSnapshot } from './types.js';

export function runnerHash(runner: { command: string; args: readonly string[] }): string {
  return sha256(canonicalJson({ args: [...runner.args], command: runner.command }));
}

export function fingerprintOf(input: InputSnapshot): string {
  return sha256(
    canonicalJson({
      protocolVersion: input.protocolVersion,
      generatorVersion: input.generatorVersion,
      promptPath: input.promptPath,
      promptSha256: input.promptSha256,
      runnerHash: input.runnerHash,
      sources: input.sources,
    }),
  );
}
