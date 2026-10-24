import type { SourceLocation } from './errors.js';

export type FileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: 'missing' | 'escape' | 'invalid'; message: string };

export type FileList =
  | { ok: true; names: string[] }
  | { ok: false; code: 'missing' | 'escape' | 'invalid'; message: string };

export type Reason = {
  code: string;
  message: string;
  path?: string;
  target?: string;
};

export function reason(
  code: string,
  message: string,
  extra?: { path?: string; target?: string },
): Reason {
  const value: Reason = { code, message };
  if (extra?.path !== undefined) value.path = extra.path;
  if (extra?.target !== undefined) value.target = extra.target;
  return value;
}

export type PathSource = {
  kind: 'path';
  path: string;
  location: SourceLocation;
};

export type TargetSource = {
  kind: 'target';
  target: string;
  location: SourceLocation;
};

export type SourceDecl = PathSource | TargetSource;

export type TargetDecl = {
  id: string;
  location: SourceLocation;
  sources: SourceDecl[];
  outputPath: string;
  outputLocation: SourceLocation;
  section: string;
  promptPath: string;
  promptLocation: SourceLocation;
  runner: { command: string; args: string[] };
  runnerLocation: SourceLocation;
  generatorVersion: string;
};

export type Manifest = {
  version: 1;
  file: string;
  targets: TargetDecl[];
};

export type InputSource =
  | { kind: 'path'; path: string; sha256: string }
  | { kind: 'target'; target: string; section: string; sha256: string };

export type InputSnapshot = {
  protocolVersion: number;
  generatorVersion: string;
  promptPath: string;
  promptSha256: string;
  runnerHash: string;
  sources: InputSource[];
};

export type TargetRecord = {
  fingerprint: string;
  outputPath: string;
  section: string;
  appliedContent: string;
  appliedContentSha256: string;
  inputs: InputSnapshot;
  provenance: 'build' | 'adopt';
  proposalId: string | null;
};

export type StateFile = {
  version: 1;
  targets: Record<string, TargetRecord>;
};

export type TargetStateName = 'current' | 'stale' | 'unbuilt' | 'conflict' | 'blocked';

export type TargetStatus = {
  id: string;
  state: TargetStateName;
  reasons: Reason[];
  outputPath: string;
  section: string;
  fingerprint: string | null;
};

export type GeneratorSource = {
  id: string;
  kind: 'path' | 'target';
  content: string;
};

export type GeneratorRequest = {
  protocolVersion: number;
  target: string;
  section: string;
  prompt: string;
  sources: GeneratorSource[];
};

export type GeneratorResponse =
  | { ok: true; content: string }
  | { ok: false; message: string };

export type GeneratorRunner = (
  target: TargetDecl,
  request: GeneratorRequest,
) => Promise<GeneratorResponse>;

export type ProposalTarget = {
  id: string;
  section: string;
  outputPath: string;
  fingerprint: string;
  reasons: Reason[];
  content: string;
  inputs: InputSnapshot;
};

export type Proposal = {
  version: 1;
  protocolVersion: number;
  id: string;
  targets: ProposalTarget[];
  preconditions: {
    files: Record<string, string>;
  };
};

export type Graph = {
  order: readonly string[];
  dependencies: ReadonlyMap<string, readonly string[]>;
};
