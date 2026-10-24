import { PROTOCOL_VERSION } from './constants.js';
import { decodeUtf8 } from './content.js';
import { runnerHash } from './fingerprint.js';
import { sha256 } from './hash.js';
import { reason, type FileRead, type GeneratorSource, type InputSnapshot, type InputSource, type Reason, type TargetDecl } from './types.js';

export type UpstreamSection =
  | { ok: true; section: string; bytes: Buffer }
  | { ok: false; message: string };

export type InputAssembly =
  | { ok: true; inputs: InputSnapshot; prompt: string; generatorSources: GeneratorSource[] }
  | { ok: false; reasons: Reason[] };

export function snapshotInputs(
  target: TargetDecl,
  read: (rel: string) => FileRead,
  upstream: (targetId: string) => UpstreamSection,
): InputAssembly {
  const promptFile = read(target.promptPath);
  if (!promptFile.ok) return { ok: false, reasons: [readReason(promptFile, target.promptPath)] };
  const promptText = decodeUtf8(promptFile.bytes);
  if (!promptText.ok) {
    return {
      ok: false,
      reasons: [reason('utf8', `prompt ${target.promptPath} is not valid UTF-8`, { path: target.promptPath })],
    };
  }

  const sources: InputSource[] = [];
  const generatorSources: GeneratorSource[] = [];
  const reasons: Reason[] = [];
  for (const source of target.sources) {
    if (source.kind === 'path') {
      const file = read(source.path);
      if (!file.ok) {
        reasons.push(readReason(file, source.path));
        continue;
      }
      const text = decodeUtf8(file.bytes);
      if (!text.ok) {
        reasons.push(reason('utf8', `source ${source.path} is not valid UTF-8`, { path: source.path }));
        continue;
      }
      sources.push({ kind: 'path', path: source.path, sha256: sha256(file.bytes) });
      generatorSources.push({ id: source.path, kind: 'path', content: text.text });
      continue;
    }
    const section = upstream(source.target);
    if (!section.ok) {
      reasons.push(reason('missing-section', section.message, { target: source.target }));
      continue;
    }
    const text = decodeUtf8(section.bytes);
    if (!text.ok) {
      reasons.push(
        reason('utf8', `upstream ${source.target} generated section is not valid UTF-8`, {
          target: source.target,
        }),
      );
      continue;
    }
    sources.push({
      kind: 'target',
      target: source.target,
      section: section.section,
      sha256: sha256(section.bytes),
    });
    generatorSources.push({ id: source.target, kind: 'target', content: text.text });
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    prompt: promptText.text,
    generatorSources,
    inputs: {
      protocolVersion: PROTOCOL_VERSION,
      generatorVersion: target.generatorVersion,
      promptPath: target.promptPath,
      promptSha256: sha256(promptFile.bytes),
      runnerHash: runnerHash(target.runner),
      sources,
    },
  };
}

export function diffInputReasons(previous: InputSnapshot, next: InputSnapshot): Reason[] {
  const reasons: Reason[] = [];
  if (previous.protocolVersion !== next.protocolVersion) {
    reasons.push(reason('protocol-changed', 'protocol version changed'));
  }
  if (previous.generatorVersion !== next.generatorVersion) {
    reasons.push(reason('generator-version-changed', 'generator version changed'));
  }
  if (previous.promptPath !== next.promptPath || previous.promptSha256 !== next.promptSha256) {
    reasons.push(reason('prompt-changed', `prompt ${next.promptPath} changed`, { path: next.promptPath }));
  }
  if (previous.runnerHash !== next.runnerHash) {
    reasons.push(reason('runner-changed', 'runner configuration changed'));
  }
  if (previous.sources.length !== next.sources.length) {
    reasons.push(reason('sources-changed', 'declared sources changed'));
    return reasons;
  }
  for (let index = 0; index < next.sources.length; index += 1) {
    const before = previous.sources[index];
    const after = next.sources[index];
    if (!before || !after) continue;
    if (before.kind !== after.kind) {
      reasons.push(reason('sources-changed', `source ${index + 1} changed kind`));
      continue;
    }
    if (before.kind === 'path' && after.kind === 'path') {
      if (before.path !== after.path) {
        reasons.push(
          reason('sources-changed', `source path changed from ${before.path} to ${after.path}`, {
            path: after.path,
          }),
        );
      } else if (before.sha256 !== after.sha256) {
        reasons.push(reason('source-changed', `source ${after.path} changed`, { path: after.path }));
      }
      continue;
    }
    if (before.kind === 'target' && after.kind === 'target') {
      if (before.target !== after.target || before.section !== after.section) {
        reasons.push(reason('sources-changed', `upstream source changed to ${after.target}`, { target: after.target }));
      } else if (before.sha256 !== after.sha256) {
        reasons.push(
          reason('upstream-changed', `upstream ${after.target} generated section changed`, {
            target: after.target,
          }),
        );
      }
    }
  }
  return reasons;
}

function readReason(file: Extract<FileRead, { ok: false }>, rel: string): Reason {
  if (file.code === 'escape') return reason('escape', file.message, { path: rel });
  if (file.code === 'missing') return reason('missing-file', file.message, { path: rel });
  return reason('invalid-file', file.message, { path: rel });
}
