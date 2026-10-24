import { SHA256_HEX, STATE_VERSION } from './constants.js';
import { isRecord, SpecdepsError } from './errors.js';
import { sha256 } from './hash.js';
import type { InputSnapshot, InputSource, StateFile, TargetRecord } from './types.js';

export function emptyState(): StateFile {
  return { version: STATE_VERSION, targets: {} };
}

export function serializeState(state: StateFile): Buffer {
  const targets: Record<string, TargetRecord> = {};
  for (const id of Object.keys(state.targets).sort()) {
    const record = state.targets[id];
    if (record) targets[id] = record;
  }
  return Buffer.from(`${JSON.stringify({ version: STATE_VERSION, targets }, null, 2)}\n`, 'utf8');
}

export function parseState(bytes: Buffer): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new SpecdepsError('state file is not valid JSON', 'state-invalid', { exitCode: 1 });
  }
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.targets)) {
    throw new SpecdepsError('state file version is unsupported', 'state-invalid', { exitCode: 1 });
  }
  const targets: Record<string, TargetRecord> = {};
  for (const [id, value] of Object.entries(parsed.targets)) {
    targets[id] = parseRecord(id, value);
  }
  return { version: STATE_VERSION, targets };
}

function parseRecord(id: string, value: unknown): TargetRecord {
  if (!isRecord(value)) throw invalid(id);
  const fingerprint = requiredHash(value.fingerprint, id, 'fingerprint');
  const outputPath = requiredString(value.outputPath, id, 'outputPath');
  const section = requiredString(value.section, id, 'section');
  const appliedContent = requiredStringAllowEmpty(value.appliedContent, id, 'appliedContent');
  const appliedContentSha256 = requiredHash(value.appliedContentSha256, id, 'appliedContentSha256');
  if (sha256(appliedContent) !== appliedContentSha256) {
    throw new SpecdepsError(`state integrity failed for target "${id}"`, 'state-invalid', { exitCode: 1 });
  }
  const provenance = value.provenance;
  if (provenance !== 'build' && provenance !== 'adopt') throw invalid(id);
  const proposalId = value.proposalId;
  if (proposalId !== null && (typeof proposalId !== 'string' || !SHA256_HEX.test(proposalId))) throw invalid(id);
  return {
    fingerprint,
    outputPath,
    section,
    appliedContent,
    appliedContentSha256,
    inputs: parseInputSnapshot(value.inputs, id),
    provenance,
    proposalId,
  };
}

export function parseInputSnapshot(value: unknown, id = 'proposal'): InputSnapshot {
  if (!isRecord(value) || !Array.isArray(value.sources)) throw invalid(id);
  if (value.protocolVersion !== 1) throw invalid(id);
  if (typeof value.generatorVersion !== 'string') throw invalid(id);
  if (typeof value.promptPath !== 'string' || typeof value.promptSha256 !== 'string') throw invalid(id);
  if (!SHA256_HEX.test(value.promptSha256) && value.promptSha256 !== '') throw invalid(id);
  if (typeof value.runnerHash !== 'string' || !SHA256_HEX.test(value.runnerHash)) throw invalid(id);
  const sources: InputSource[] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || typeof source.sha256 !== 'string' || !SHA256_HEX.test(source.sha256)) throw invalid(id);
    if (source.kind === 'path' && typeof source.path === 'string') {
      sources.push({ kind: 'path', path: source.path, sha256: source.sha256 });
      continue;
    }
    if (
      source.kind === 'target' &&
      typeof source.target === 'string' &&
      typeof source.section === 'string'
    ) {
      sources.push({
        kind: 'target',
        target: source.target,
        section: source.section,
        sha256: source.sha256,
      });
      continue;
    }
    throw invalid(id);
  }
  return {
    protocolVersion: 1,
    generatorVersion: value.generatorVersion,
    promptPath: value.promptPath,
    promptSha256: value.promptSha256,
    runnerHash: value.runnerHash,
    sources,
  };
}

function requiredString(value: unknown, id: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpecdepsError(`state target "${id}" has an invalid ${field}`, 'state-invalid', { exitCode: 1 });
  }
  return value;
}

function requiredStringAllowEmpty(value: unknown, id: string, field: string): string {
  if (typeof value !== 'string') {
    throw new SpecdepsError(`state target "${id}" has an invalid ${field}`, 'state-invalid', { exitCode: 1 });
  }
  return value;
}

function requiredHash(value: unknown, id: string, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new SpecdepsError(`state target "${id}" has an invalid ${field}`, 'state-invalid', { exitCode: 1 });
  }
  return value;
}

function invalid(id: string): SpecdepsError {
  return new SpecdepsError(`state target "${id}" is invalid`, 'state-invalid', { exitCode: 1 });
}
