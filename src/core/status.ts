import { decodeUtf8, interiorHasContent } from './content.js';
import { diffInputReasons, snapshotInputs, type UpstreamSection } from './inputs.js';
import { fingerprintOf } from './fingerprint.js';
import { parseGeneratedSections, sectionInterior } from './markers.js';
import {
  reason,
  type FileRead,
  type Graph,
  type Manifest,
  type Reason,
  type StateFile,
  type TargetDecl,
  type TargetStateName,
  type TargetStatus,
} from './types.js';

export function readDeclaredSection(manifest: Manifest, targetId: string, read: (rel: string) => FileRead): UpstreamSection {
  const target = manifest.targets.find((item) => item.id === targetId);
  if (!target) return { ok: false, message: `unknown target "${targetId}"` };
  const file = read(target.outputPath);
  if (!file.ok) return { ok: false, message: file.message };
  const interior = sectionInterior(file.bytes, target.section);
  if (interior === null) {
    const parsed = parseGeneratedSections(file.bytes);
    const detail = parsed.ok ? `missing generated section "${target.section}"` : (parsed.diagnostics[0]?.message ?? 'invalid markers');
    return { ok: false, message: `${target.outputPath}: ${detail}` };
  }
  return { ok: true, section: target.section, bytes: interior };
}

export function evaluateStatus(
  manifest: Manifest,
  graph: Graph,
  state: StateFile,
  read: (rel: string) => FileRead,
): Map<string, TargetStatus> {
  const byId = new Map(manifest.targets.map((target) => [target.id, target]));
  const statuses = new Map<string, TargetStatus>();
  for (const id of graph.order) {
    const target = byId.get(id);
    if (!target) continue;
    statuses.set(id, statusForTarget(target, graph, state, read, manifest, statuses));
  }
  return statuses;
}

function statusForTarget(
  target: TargetDecl,
  graph: Graph,
  state: StateFile,
  read: (rel: string) => FileRead,
  manifest: Manifest,
  statuses: ReadonlyMap<string, TargetStatus>,
): TargetStatus {
  const output = read(target.outputPath);
  if (!output.ok) {
    const code = output.code === 'escape' ? 'escape' : output.code === 'missing' ? 'missing-file' : 'invalid-file';
    return blocked(target, [reason(code, output.message, { path: target.outputPath })]);
  }
  const parsed = parseGeneratedSections(output.bytes);
  if (!parsed.ok) {
    return blocked(
      target,
      parsed.diagnostics.map((diagnostic) =>
        reason('marker', `${target.outputPath}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`, {
          path: target.outputPath,
        }),
      ),
    );
  }
  const section = parsed.sections.find((item) => item.id === target.section);
  if (!section) {
    return blocked(target, [
      reason('missing-section', `output ${target.outputPath} has no generated section "${target.section}"`, {
        path: target.outputPath,
      }),
    ]);
  }
  const interior = output.bytes.subarray(section.interiorStart, section.interiorEnd);
  const upstreamReasons = upstreamStateReasons(graph.dependencies.get(target.id) ?? [], statuses);
  const snap = snapshotInputs(target, read, (targetId) => readDeclaredSection(manifest, targetId, read));
  const record = state.targets[target.id];

  if (!snap.ok && !record) return blocked(target, snap.reasons);

  if (!record) {
    const reasons: Reason[] = [];
    if (interiorHasContent(interior)) {
      reasons.push(
        reason(
          'needs-adoption',
          `generated section has content but no ownership record; run specdeps adopt ${target.id}`,
        ),
      );
    } else {
      reasons.push(reason('never-built', 'never built'));
    }
    reasons.push(...upstreamReasons);
    const upstreamBlocked = upstreamReasons.some(
      (item) => item.code === 'upstream-conflict' || item.code === 'upstream-blocked',
    );
    return makeStatus(target, upstreamBlocked ? 'blocked' : 'unbuilt', reasons, null);
  }

  if (record.outputPath !== target.outputPath || record.section !== target.section) {
    return blocked(target, [reason('state-mismatch', 'state record does not match the manifest output')]);
  }
  const decoded = decodeUtf8(interior);
  if (!decoded.ok) {
    return blocked(target, [
      reason('utf8', `generated section "${target.section}" is not valid UTF-8`, { path: target.outputPath }),
    ]);
  }
  if (decoded.text !== record.appliedContent) {
    return makeStatus(
      target,
      'conflict',
      [reason('conflict', 'generated section differs from the last applied content')],
      record.fingerprint,
    );
  }

  const hardUpstream = upstreamReasons.filter(
    (item) => item.code === 'upstream-conflict' || item.code === 'upstream-blocked' || item.code === 'upstream-unbuilt',
  );
  if (hardUpstream.length > 0) return blocked(target, hardUpstream, record.fingerprint);

  if (!snap.ok) return blocked(target, snap.reasons, record.fingerprint);
  const fingerprint = fingerprintOf(snap.inputs);
  const inputReasons = diffInputReasons(record.inputs, snap.inputs);
  const staleUpstream = upstreamReasons.filter((item) => item.code === 'upstream-stale');
  const adopted =
    record.provenance === 'adopt'
      ? [reason('adopted', 'existing section was adopted and has not been generated by specdeps')]
      : [];
  if (staleUpstream.length > 0 || inputReasons.length > 0 || adopted.length > 0) {
    return makeStatus(target, 'stale', [...staleUpstream, ...inputReasons, ...adopted], fingerprint);
  }
  if (fingerprint !== record.fingerprint) {
    return makeStatus(target, 'stale', [reason('sources-changed', 'inputs changed')], fingerprint);
  }
  return makeStatus(
    target,
    'current',
    [reason('current', 'inputs match the last build and upstream targets are current')],
    fingerprint,
  );
}

function upstreamStateReasons(deps: readonly string[], statuses: ReadonlyMap<string, TargetStatus>): Reason[] {
  const reasons: Reason[] = [];
  for (const dep of deps) {
    const status = statuses.get(dep);
    if (!status || status.state === 'current') continue;
    const code =
      status.state === 'stale'
        ? 'upstream-stale'
        : status.state === 'conflict'
          ? 'upstream-conflict'
          : status.state === 'unbuilt'
            ? 'upstream-unbuilt'
            : 'upstream-blocked';
    reasons.push(reason(code, `upstream ${dep} is ${status.state}`, { target: dep }));
  }
  return reasons;
}

function blocked(target: TargetDecl, reasons: Reason[], fingerprint: string | null = null): TargetStatus {
  return makeStatus(target, 'blocked', reasons, fingerprint);
}

function makeStatus(
  target: TargetDecl,
  state: TargetStateName,
  reasons: Reason[],
  fingerprint: string | null,
): TargetStatus {
  return {
    id: target.id,
    state,
    reasons,
    outputPath: target.outputPath,
    section: target.section,
    fingerprint,
  };
}
