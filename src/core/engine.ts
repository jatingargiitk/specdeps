import { MAX_SECTION_BYTES, PROTOCOL_VERSION, PROPOSALS_DIR, SHA256_HEX, STATE_REL, proposalRel } from './constants.js';
import { classifyTargets, selectTargets, type PlannedAction } from './classify.js';
import { normalizeGeneratedContent, interiorHasContent, decodeUtf8 } from './content.js';
import { unifiedDiff } from './diff.js';
import { SpecdepsError, formatError, type SourceLocation } from './errors.js';
import { fingerprintOf, runnerHash } from './fingerprint.js';
import { buildGraph } from './graph.js';
import { canonicalJson, sha256 } from './hash.js';
import { snapshotInputs, type UpstreamSection } from './inputs.js';
import { parseManifest } from './manifest.js';
import { parseGeneratedSections, replaceSection } from './markers.js';
import { validateRelativePath } from './paths.js';
import { parseProposal, sealProposal, type ProposalBody } from './proposal.js';
import { emptyState, parseState, serializeState } from './state.js';
import { evaluateStatus, readDeclaredSection } from './status.js';
import type {
  FileList,
  FileRead,
  GeneratorRunner,
  Graph,
  Manifest,
  Proposal,
  ProposalTarget,
  Reason,
  TargetDecl,
  TargetRecord,
  TargetStateName,
  TargetStatus,
} from './types.js';

export type RepoFs = {
  readonly root: string;
  read(rel: string): FileRead;
  write(rel: string, data: Buffer): void;
  list(rel: string): FileList;
};

export type InitFile = { path: string; bytes: Buffer };

export type InitReport = { ok: boolean; message: string; written: string[] };

export type StatusReport = { targets: TargetStatus[] };

export type PlanReport = {
  targets: Array<{ id: string; action: PlannedAction; state: TargetStateName; reasons: Reason[] }>;
};

export type BuildTargetResult = {
  id: string;
  outcome: 'built' | 'blocked' | 'conflict' | 'failed';
  reasons: Reason[];
};

export type BuildReport = {
  ok: boolean;
  proposalId: string | null;
  results: BuildTargetResult[];
  message: string;
};

export type DiffReport = {
  ok: boolean;
  id: string;
  message: string;
  targets: Array<{ id: string; outputPath: string; section: string; reasons: Reason[] }>;
  files: Array<{ path: string; patch: string; targets: string[] }>;
};

export type ApplyReport = { ok: boolean; proposalId: string; message: string; applied: string[] };

export type AdoptReport = { ok: boolean; message: string };

export type Diagnostic = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  location?: SourceLocation;
};

export type DoctorReport = { ok: boolean; errors: Diagnostic[]; warnings: Diagnostic[] };

type Project = { manifest: Manifest; graph: Graph };

const MINIMAL_LOCATION: SourceLocation = { file: 'init', line: 1, column: 1 };

export class Engine {
  constructor(
    private readonly repo: RepoFs,
    private readonly manifestRel = 'specdeps.yaml',
  ) {}

  status(): StatusReport {
    const project = this.loadProject();
    const statuses = evaluateStatus(project.manifest, project.graph, this.loadState(), (rel) => this.repo.read(rel));
    return { targets: [...statuses.values()] };
  }

  plan(onlyId?: string): PlanReport {
    const project = this.loadProject();
    const statuses = evaluateStatus(project.manifest, project.graph, this.loadState(), (rel) => this.repo.read(rel));
    const selected = selectTargets(project.graph, statuses, onlyId);
    const classified = classifyTargets(project.graph, statuses, selected);
    return {
      targets: project.graph.order.flatMap((id) => {
        const status = statuses.get(id);
        const plan = classified.get(id);
        if (!status || !plan) return [];
        return [{ id, action: plan.action, state: status.state, reasons: plan.reasons }];
      }),
    };
  }

  async build(onlyId: string | undefined, runner: GeneratorRunner): Promise<BuildReport> {
    const project = this.loadProject();
    const state = this.loadState();
    const read = (rel: string): FileRead => this.repo.read(rel);
    const statuses = evaluateStatus(project.manifest, project.graph, state, read);
    const selected = selectTargets(project.graph, statuses, onlyId);
    const classified = classifyTargets(project.graph, statuses, selected);
    const runtime = new Map<string, string>();
    for (const [id, item] of classified) runtime.set(id, item.action);
    const proposed = new Map<string, string>();
    const built: ProposalTarget[] = [];
    const results: BuildTargetResult[] = [];

    for (const id of project.graph.order) {
      const action = runtime.get(id);
      const plan = classified.get(id);
      if (!plan || action === 'skip' || action === undefined) continue;
      if (action === 'conflict') {
        results.push({ id, outcome: 'conflict', reasons: plan.reasons });
        continue;
      }
      if (action === 'blocked') {
        results.push({ id, outcome: 'blocked', reasons: plan.reasons });
        continue;
      }
      if (action !== 'build') continue;
      const target = project.manifest.targets.find((item) => item.id === id);
      if (!target) continue;
      const blocker = (project.graph.dependencies.get(id) ?? []).find((dep) => {
        const depAction = runtime.get(dep);
        return depAction === 'failed' || depAction === 'blocked' || depAction === 'conflict' || depAction === 'build';
      });
      if (blocker) {
        runtime.set(id, 'blocked');
        results.push({
          id,
          outcome: 'blocked',
          reasons: [
            {
              code: 'upstream-failed',
              message: `upstream ${blocker} prevented this build`,
              target: blocker,
            },
          ],
        });
        continue;
      }

      const upstream = (targetId: string): UpstreamSection => {
        const text = proposed.get(targetId);
        const declared = project.manifest.targets.find((item) => item.id === targetId);
        if (text !== undefined && declared) {
          return { ok: true, section: declared.section, bytes: Buffer.from(text, 'utf8') };
        }
        return readDeclaredSection(project.manifest, targetId, read);
      };
      const snap = snapshotInputs(target, read, upstream);
      if (!snap.ok) {
        runtime.set(id, 'failed');
        results.push({ id, outcome: 'failed', reasons: snap.reasons });
        continue;
      }

      let response;
      try {
        response = await runner(target, {
          protocolVersion: PROTOCOL_VERSION,
          target: target.id,
          section: target.section,
          prompt: snap.prompt,
          sources: snap.generatorSources,
        });
      } catch (error) {
        response = { ok: false as const, message: error instanceof Error ? error.message : String(error) };
      }
      if (!response.ok) {
        runtime.set(id, 'failed');
        results.push({
          id,
          outcome: 'failed',
          reasons: [{ code: 'generator-failed', message: response.message }],
        });
        continue;
      }
      const normalized = normalizeGeneratedContent(response.content);
      if (!normalized.ok || Buffer.byteLength(normalized.content) > MAX_SECTION_BYTES) {
        runtime.set(id, 'failed');
        results.push({
          id,
          outcome: 'failed',
          reasons: [
            {
              code: 'generator-rejected',
              message: normalized.ok ? 'generator content exceeds 1000000 bytes' : normalized.message,
            },
          ],
        });
        continue;
      }
      proposed.set(id, normalized.content);
      runtime.set(id, 'succeeded');
      built.push({
        id,
        section: target.section,
        outputPath: target.outputPath,
        fingerprint: fingerprintOf(snap.inputs),
        reasons: plan.reasons,
        content: normalized.content,
        inputs: snap.inputs,
      });
      results.push({ id, outcome: 'built', reasons: plan.reasons });
    }

    if (built.length === 0) {
      const message = results.length === 0 ? 'nothing to build' : 'no proposal written';
      return { ok: results.every((item) => item.outcome === 'built'), proposalId: null, results, message };
    }

    const body: ProposalBody = {
      version: 1,
      protocolVersion: PROTOCOL_VERSION,
      targets: [...built].sort((left, right) => left.id.localeCompare(right.id)),
      preconditions: { files: this.preconditionHashes(project.manifest, built) },
    };
    const proposal = sealProposal(body);
    this.repo.write(proposalRel(proposal.id), Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, 'utf8'));
    return {
      ok: results.every((item) => item.outcome === 'built'),
      proposalId: proposal.id,
      results,
      message: `wrote proposal ${proposal.id}`,
    };
  }

  diff(proposalId: string): DiffReport {
    const proposal = this.loadProposal(proposalId);
    if (!proposal.ok) return { ok: false, id: proposalId, message: proposal.message, targets: [], files: [] };
    const files = this.preview(proposal.proposal);
    return {
      ok: true,
      id: proposal.proposal.id,
      message: `proposal ${proposal.proposal.id}`,
      targets: proposal.proposal.targets.map((target) => ({
        id: target.id,
        outputPath: target.outputPath,
        section: target.section,
        reasons: target.reasons,
      })),
      files: [...files.entries()].map(([filePath, change]) => ({
        path: filePath,
        targets: proposal.proposal.targets.filter((target) => target.outputPath === filePath).map((target) => target.id),
        patch: unifiedDiff(filePath, change.before.toString('utf8'), change.after.toString('utf8')) || '(no textual change)\n',
      })),
    };
  }

  apply(proposalId: string): ApplyReport {
    const loaded = this.loadProposal(proposalId);
    if (!loaded.ok) return { ok: false, proposalId, message: loaded.message, applied: [] };
    const proposal = loaded.proposal;
    const project = this.loadProject();
    for (const proposed of proposal.targets) {
      const target = project.manifest.targets.find((item) => item.id === proposed.id);
      if (!target || !sameShape(target, proposed)) {
        return {
          ok: false,
          proposalId,
          message: `proposal ${proposalId} is stale: manifest target "${proposed.id}" no longer matches`,
          applied: [],
        };
      }
    }
    for (const [rel, expected] of Object.entries(proposal.preconditions.files)) {
      const current = this.repo.read(rel);
      if (!current.ok || sha256(current.bytes) !== expected) {
        return {
          ok: false,
          proposalId,
          message: `proposal ${proposalId} is stale: ${rel} changed after the proposal was created`,
          applied: [],
        };
      }
    }
    for (const proposed of proposal.targets) {
      const target = project.manifest.targets.find((item) => item.id === proposed.id);
      if (!target) continue;
      const snap = snapshotInputs(target, (rel) => this.repo.read(rel), (targetId) =>
        predictedSection(project.manifest, proposal, targetId, (rel) => this.repo.read(rel)),
      );
      if (!snap.ok || canonicalJson(snap.inputs) !== canonicalJson(proposed.inputs)) {
        return {
          ok: false,
          proposalId,
          message: `proposal ${proposalId} is stale: inputs for ${proposed.id} no longer match`,
          applied: [],
        };
      }
    }

    const preview = this.preview(proposal);
    for (const [rel, change] of preview) this.repo.write(rel, change.after);
    const state = this.loadState();
    for (const proposed of proposal.targets) {
      state.targets[proposed.id] = recordFromProposal(proposed, proposal.id);
    }
    this.saveState(state);
    return {
      ok: true,
      proposalId,
      message: `applied ${proposal.targets.map((target) => target.id).join(', ')}`,
      applied: proposal.targets.map((target) => target.id),
    };
  }

  adopt(targetId: string): AdoptReport {
    const project = this.loadProject();
    const target = project.manifest.targets.find((item) => item.id === targetId);
    if (!target) return { ok: false, message: `unknown target "${targetId}"` };
    const output = this.repo.read(target.outputPath);
    if (!output.ok) return { ok: false, message: output.message };
    const interior = sectionBytes(output.bytes, target.section);
    if (!interior.ok) return { ok: false, message: interior.message };
    if (!interiorHasContent(interior.bytes)) {
      return { ok: false, message: `section "${target.section}" is empty; build it instead of adopting` };
    }
    const text = decodeUtf8(interior.bytes);
    if (!text.ok) return { ok: false, message: `${target.outputPath} generated section is not valid UTF-8` };
    const state = this.loadState();
    const existing = state.targets[targetId];
    if (existing && existing.appliedContent === text.text) {
      return { ok: false, message: `target "${targetId}" already has an ownership record` };
    }
    const snap = snapshotInputs(target, (rel) => this.repo.read(rel), (id) =>
      readDeclaredSection(project.manifest, id, (rel) => this.repo.read(rel)),
    );
    if (!snap.ok) return { ok: false, message: snap.reasons.map((item) => item.message).join('; ') };
    state.targets[targetId] = {
      fingerprint: fingerprintOf(snap.inputs),
      outputPath: target.outputPath,
      section: target.section,
      appliedContent: text.text,
      appliedContentSha256: sha256(text.text),
      inputs: snap.inputs,
      provenance: 'adopt',
      proposalId: null,
    };
    this.saveState(state);
    return {
      ok: true,
      message: `adopted ${targetId}; the section is a conflict baseline and is not marked current`,
    };
  }

  init(files: InitFile[]): InitReport {
    for (const file of files) validateRelativePath(file.path, MINIMAL_LOCATION, 'init path');
    const existing: string[] = [];
    for (const file of files) {
      const current = this.repo.read(file.path);
      if (current.ok) existing.push(file.path);
      else if (current.code !== 'missing') return { ok: false, message: current.message, written: [] };
    }
    if (existing.length > 0) {
      return { ok: false, message: `refusing to overwrite ${existing.join(', ')}`, written: [] };
    }
    const written: string[] = [];
    for (const file of files) {
      this.repo.write(file.path, file.bytes);
      written.push(file.path);
    }
    return {
      ok: true,
      message: `wrote ${written.length} file${written.length === 1 ? '' : 's'}`,
      written,
    };
  }

  doctor(): DoctorReport {
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    let project: Project;
    try {
      project = this.loadProject();
    } catch (error) {
      if (error instanceof SpecdepsError) {
        errors.push(diagnosticFromError(error));
        return { ok: false, errors, warnings };
      }
      throw error;
    }
    let state;
    try {
      state = this.loadState();
    } catch (error) {
      if (error instanceof SpecdepsError) {
        errors.push(diagnosticFromError(error));
        return { ok: false, errors, warnings };
      }
      throw error;
    }
    const statuses = evaluateStatus(project.manifest, project.graph, state, (rel) => this.repo.read(rel));
    for (const status of statuses.values()) {
      const severity = doctorSeverity(status);
      if (severity === null) continue;
      const bucket = severity === 'error' ? errors : warnings;
      for (const item of status.reasons) {
        bucket.push({ severity, code: item.code, message: `${status.id}: ${item.message}` });
      }
    }
    for (const target of project.manifest.targets) {
      const paths = [target.promptPath, target.outputPath];
      for (const source of target.sources) {
        if (source.kind === 'path') paths.push(source.path);
      }
      for (const rel of paths) {
        const file = this.repo.read(rel);
        if (!file.ok) errors.push({ severity: 'error', code: file.code, message: file.message });
      }
    }
    this.diagnoseExtraSections(project.manifest, errors);
    for (const id of Object.keys(state.targets)) {
      if (!project.manifest.targets.some((target) => target.id === id)) {
        errors.push({ severity: 'error', code: 'state-invalid', message: `state has unknown target "${id}"` });
      }
    }
    this.diagnoseProposals(errors);
    return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
  }

  private loadProject(): Project {
    const file = this.repo.read(this.manifestRel);
    if (!file.ok) {
      throw new SpecdepsError(file.code === 'missing' ? `missing ${this.manifestRel}` : file.message, file.code === 'missing' ? 'manifest-missing' : file.code);
    }
    const text = decodeUtf8(file.bytes);
    if (!text.ok) throw new SpecdepsError(`${this.manifestRel} is not valid UTF-8`, 'utf8');
    const manifest = parseManifest(text.text, this.manifestRel);
    return { manifest, graph: buildGraph(manifest) };
  }

  private loadState() {
    const file = this.repo.read(STATE_REL);
    if (!file.ok) {
      if (file.code === 'missing') return emptyState();
      throw new SpecdepsError(file.message, file.code, { exitCode: 1 });
    }
    return parseState(file.bytes);
  }

  private saveState(state: ReturnType<typeof emptyState>): void {
    this.repo.write(STATE_REL, serializeState(state));
  }

  private loadProposal(proposalId: string): { ok: true; proposal: Proposal } | { ok: false; message: string } {
    if (!SHA256_HEX.test(proposalId)) return { ok: false, message: `unknown proposal "${proposalId}"` };
    const file = this.repo.read(proposalRel(proposalId));
    if (!file.ok) return { ok: false, message: file.code === 'missing' ? `unknown proposal "${proposalId}"` : file.message };
    try {
      return { ok: true, proposal: parseProposal(file.bytes) };
    } catch (error) {
      if (error instanceof SpecdepsError) return { ok: false, message: formatError(error) };
      throw error;
    }
  }

  private preconditionHashes(manifest: Manifest, built: readonly ProposalTarget[]): Record<string, string> {
    const files = new Map<string, string>();
    const note = (rel: string): void => {
      if (files.has(rel)) return;
      const current = this.repo.read(rel);
      if (!current.ok) throw new SpecdepsError(current.message, current.code, { exitCode: 1 });
      files.set(rel, sha256(current.bytes));
    };
    for (const proposed of built) {
      note(proposed.outputPath);
      const target = manifest.targets.find((item) => item.id === proposed.id);
      if (!target) continue;
      note(target.promptPath);
      for (const source of target.sources) {
        if (source.kind === 'path') note(source.path);
        else {
          const upstream = manifest.targets.find((item) => item.id === source.target);
          if (upstream) note(upstream.outputPath);
        }
      }
    }
    return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private preview(proposal: Proposal): Map<string, { before: Buffer; after: Buffer }> {
    const grouped = new Map<string, ProposalTarget[]>();
    for (const target of proposal.targets) {
      const list = grouped.get(target.outputPath) ?? [];
      list.push(target);
      grouped.set(target.outputPath, list);
    }
    const changes = new Map<string, { before: Buffer; after: Buffer }>();
    for (const [rel, edits] of grouped) {
      const current = this.repo.read(rel);
      if (!current.ok) throw new SpecdepsError(current.message, current.code, { exitCode: 1 });
      const parsed = parseGeneratedSections(current.bytes);
      if (!parsed.ok) {
        const first = parsed.diagnostics[0];
        throw new SpecdepsError(first?.message ?? `invalid markers in ${rel}`, 'markers', { exitCode: 1 });
      }
      const ordered = [...edits].sort((left, right) => {
        const leftPos = parsed.sections.find((section) => section.id === left.section)?.interiorStart ?? 0;
        const rightPos = parsed.sections.find((section) => section.id === right.section)?.interiorStart ?? 0;
        return leftPos - rightPos;
      });
      let next = current.bytes;
      for (const edit of ordered) next = replaceSection(next, edit.section, Buffer.from(edit.content, 'utf8'));
      changes.set(rel, { before: current.bytes, after: next });
    }
    return changes;
  }

  private diagnoseExtraSections(manifest: Manifest, errors: Diagnostic[]): void {
    const owned = new Map<string, Set<string>>();
    for (const target of manifest.targets) {
      const sections = owned.get(target.outputPath) ?? new Set<string>();
      sections.add(target.section);
      owned.set(target.outputPath, sections);
    }
    for (const [rel, sections] of owned) {
      const file = this.repo.read(rel);
      if (!file.ok) continue;
      const parsed = parseGeneratedSections(file.bytes);
      if (!parsed.ok) continue;
      for (const section of parsed.sections) {
        if (!sections.has(section.id)) {
          errors.push({
            severity: 'error',
            code: 'unowned-section',
            message: `generated section "${section.id}" in ${rel} is not owned by a target`,
          });
        }
      }
    }
  }

  private diagnoseProposals(errors: Diagnostic[]): void {
    const listed = this.repo.list(PROPOSALS_DIR);
    if (!listed.ok) {
      if (listed.code !== 'missing') errors.push({ severity: 'error', code: listed.code, message: listed.message });
      return;
    }
    for (const name of listed.names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const loaded = this.loadProposal(id);
      if (!loaded.ok) errors.push({ severity: 'error', code: 'proposal-invalid', message: `${name}: ${loaded.message}` });
    }
  }
}

function sameShape(target: TargetDecl, proposed: ProposalTarget): boolean {
  if (target.outputPath !== proposed.outputPath || target.section !== proposed.section) return false;
  if (target.promptPath !== proposed.inputs.promptPath) return false;
  if (target.generatorVersion !== proposed.inputs.generatorVersion) return false;
  if (runnerHash(target.runner) !== proposed.inputs.runnerHash) return false;
  if (target.sources.length !== proposed.inputs.sources.length) return false;
  for (let index = 0; index < target.sources.length; index += 1) {
    const declared = target.sources[index];
    const recorded = proposed.inputs.sources[index];
    if (!declared || !recorded || declared.kind !== recorded.kind) return false;
    if (declared.kind === 'path' && recorded.kind === 'path' && declared.path !== recorded.path) return false;
    if (declared.kind === 'target' && recorded.kind === 'target' && declared.target !== recorded.target) return false;
  }
  return true;
}

function predictedSection(
  manifest: Manifest,
  proposal: Proposal,
  targetId: string,
  read: (rel: string) => FileRead,
): UpstreamSection {
  const proposed = proposal.targets.find((item) => item.id === targetId);
  const declared = manifest.targets.find((item) => item.id === targetId);
  if (proposed && declared) return { ok: true, section: declared.section, bytes: Buffer.from(proposed.content, 'utf8') };
  return readDeclaredSection(manifest, targetId, read);
}

function recordFromProposal(proposed: ProposalTarget, proposalId: string): TargetRecord {
  return {
    fingerprint: proposed.fingerprint,
    outputPath: proposed.outputPath,
    section: proposed.section,
    appliedContent: proposed.content,
    appliedContentSha256: sha256(proposed.content),
    inputs: proposed.inputs,
    provenance: 'build',
    proposalId,
  };
}

function sectionBytes(file: Buffer, sectionId: string): { ok: true; bytes: Buffer } | { ok: false; message: string } {
  const parsed = parseGeneratedSections(file);
  if (!parsed.ok) return { ok: false, message: parsed.diagnostics[0]?.message ?? 'invalid ownership markers' };
  const section = parsed.sections.find((item) => item.id === sectionId);
  if (!section) return { ok: false, message: `missing generated section "${sectionId}"` };
  return { ok: true, bytes: Buffer.from(file.subarray(section.interiorStart, section.interiorEnd)) };
}

function doctorSeverity(status: TargetStatus): 'error' | 'warning' | null {
  if (status.state === 'conflict' || status.state === 'blocked') return 'error';
  if (status.reasons.some((item) => item.code === 'needs-adoption')) return 'error';
  if (status.state === 'unbuilt' || status.state === 'stale') return 'warning';
  return null;
}

function diagnosticFromError(error: SpecdepsError): Diagnostic {
  const diagnostic: Diagnostic = { severity: 'error', code: error.code, message: formatError(error) };
  if (error.location) diagnostic.location = error.location;
  return diagnostic;
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.severity}:${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
