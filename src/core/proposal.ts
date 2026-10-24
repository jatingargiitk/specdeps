import { MAX_SECTION_BYTES, PROPOSAL_VERSION, PROTOCOL_VERSION, SHA256_HEX } from './constants.js';
import { normalizeGeneratedContent } from './content.js';
import { SpecdepsError, isRecord } from './errors.js';
import { canonicalJson, sha256 } from './hash.js';
import { validateRelativePath, validateSectionId } from './paths.js';
import { parseInputSnapshot } from './state.js';
import type { InputSnapshot, Proposal, ProposalTarget, Reason } from './types.js';

export type ProposalBody = {
  version: 1;
  protocolVersion: number;
  targets: ProposalTarget[];
  preconditions: { files: Record<string, string> };
};

export function sealProposal(body: ProposalBody): Proposal {
  return { ...body, id: sha256(canonicalJson(body)) };
}

export function parseProposal(bytes: Buffer): Proposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new SpecdepsError('proposal is not valid JSON', 'proposal-invalid', { exitCode: 1 });
  }
  if (!isRecord(parsed)) throw new SpecdepsError('proposal is invalid', 'proposal-invalid', { exitCode: 1 });
  const id = parsed.id;
  if (typeof id !== 'string' || !SHA256_HEX.test(id)) {
    throw new SpecdepsError('proposal id is invalid', 'proposal-invalid', { exitCode: 1 });
  }
  const body = parseBody(parsed);
  const expected = sha256(canonicalJson(body));
  if (expected !== id) {
    throw new SpecdepsError('proposal id does not match its contents', 'proposal-invalid', { exitCode: 1 });
  }
  return { ...body, id };
}

function parseBody(parsed: Record<string, unknown>): ProposalBody {
  if (parsed.version !== PROPOSAL_VERSION || parsed.protocolVersion !== PROTOCOL_VERSION) {
    throw new SpecdepsError('proposal version is unsupported', 'proposal-invalid', { exitCode: 1 });
  }
  if (!Array.isArray(parsed.targets) || !isRecord(parsed.preconditions) || !isRecord(parsed.preconditions.files)) {
    throw new SpecdepsError('proposal is missing targets or preconditions', 'proposal-invalid', { exitCode: 1 });
  }
  const here = { file: 'proposal', line: 1, column: 1 };
  const targets: ProposalTarget[] = [];
  for (const entry of parsed.targets) {
    if (!isRecord(entry)) throw new SpecdepsError('proposal target is invalid', 'proposal-invalid', { exitCode: 1 });
    const id = requiredString(entry.id, 'target id');
    validateSectionId(id, here, 'proposal target id');
    const section = requiredString(entry.section, 'section');
    validateSectionId(section, here, 'proposal section');
    const outputPath = requiredString(entry.outputPath, 'output path');
    validateRelativePath(outputPath, here, 'proposal output path');
    const fingerprint = requiredHash(entry.fingerprint, 'fingerprint');
    const content = requiredStringAllowEmpty(entry.content, 'content');
    const normalized = normalizeGeneratedContent(content);
    if (!normalized.ok || normalized.content !== content) {
      throw new SpecdepsError(`proposal target "${id}" has invalid generated content`, 'proposal-invalid', {
        exitCode: 1,
      });
    }
    if (Buffer.byteLength(content) > MAX_SECTION_BYTES) {
      throw new SpecdepsError(`proposal target "${id}" exceeds the section size limit`, 'proposal-invalid', {
        exitCode: 1,
      });
    }
    if (!Array.isArray(entry.reasons)) {
      throw new SpecdepsError(`proposal target "${id}" is missing reasons`, 'proposal-invalid', { exitCode: 1 });
    }
    const reasons = entry.reasons.map((item) => parseReason(item));
    const inputs = parseProposalInputs(entry.inputs);
    targets.push({ id, section, outputPath, fingerprint, reasons, content, inputs });
  }
  const files: Record<string, string> = {};
  for (const [file, hash] of Object.entries(parsed.preconditions.files)) {
    validateRelativePath(file, here, 'proposal precondition path');
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      throw new SpecdepsError(`proposal precondition for ${file} is invalid`, 'proposal-invalid', { exitCode: 1 });
    }
    files[file] = hash;
  }
  return {
    version: 1,
    protocolVersion: PROTOCOL_VERSION,
    targets,
    preconditions: { files },
  };
}

function parseProposalInputs(value: unknown): InputSnapshot {
  try {
    return parseInputSnapshot(value);
  } catch (error) {
    if (error instanceof SpecdepsError) {
      throw new SpecdepsError('proposal inputs are invalid', 'proposal-invalid', { exitCode: 1 });
    }
    throw error;
  }
}

function parseReason(value: unknown): Reason {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new SpecdepsError('proposal reason is invalid', 'proposal-invalid', { exitCode: 1 });
  }
  const reason: Reason = { code: value.code, message: value.message };
  if (value.path !== undefined) {
    if (typeof value.path !== 'string') throw new SpecdepsError('proposal reason path is invalid', 'proposal-invalid', { exitCode: 1 });
    reason.path = value.path;
  }
  if (value.target !== undefined) {
    if (typeof value.target !== 'string') {
      throw new SpecdepsError('proposal reason target is invalid', 'proposal-invalid', { exitCode: 1 });
    }
    reason.target = value.target;
  }
  return reason;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpecdepsError(`proposal ${field} is invalid`, 'proposal-invalid', { exitCode: 1 });
  }
  return value;
}

function requiredStringAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SpecdepsError(`proposal ${field} is invalid`, 'proposal-invalid', { exitCode: 1 });
  }
  return value;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new SpecdepsError(`proposal ${field} is invalid`, 'proposal-invalid', { exitCode: 1 });
  }
  return value;
}
