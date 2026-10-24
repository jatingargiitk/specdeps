import { SpecdepsError } from './errors.js';
import { reason, type Graph, type Reason, type TargetStatus } from './types.js';

export type PlannedAction = 'build' | 'skip' | 'conflict' | 'blocked';

export type PlannedTarget = {
  action: PlannedAction;
  reasons: Reason[];
};

export function selectTargets(
  graph: Graph,
  statuses: ReadonlyMap<string, TargetStatus>,
  onlyId: string | undefined,
): Set<string> {
  if (onlyId !== undefined && !statuses.has(onlyId)) {
    throw new SpecdepsError(`unknown target "${onlyId}"`, 'unknown-target');
  }
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const status = statuses.get(id);
    if (!status) throw new SpecdepsError(`unknown target "${id}"`, 'unknown-target');
    if (status.state === 'current') return;
    for (const dep of graph.dependencies.get(id) ?? []) {
      const depStatus = statuses.get(dep);
      if (depStatus && depStatus.state !== 'current') visit(dep);
    }
    selected.add(id);
  };
  if (onlyId !== undefined) visit(onlyId);
  else {
    for (const id of graph.order) visit(id);
  }
  return selected;
}

export function classifyTargets(
  graph: Graph,
  statuses: ReadonlyMap<string, TargetStatus>,
  selected: ReadonlySet<string>,
): Map<string, PlannedTarget> {
  const outcome = new Map<string, PlannedTarget>();
  for (const id of graph.order) {
    const status = statuses.get(id);
    if (!status) continue;
    if (!selected.has(id) || status.state === 'current') {
      outcome.set(id, { action: 'skip', reasons: status.reasons });
      continue;
    }
    if (status.state === 'conflict') {
      outcome.set(id, { action: 'conflict', reasons: status.reasons });
      continue;
    }
    if (status.reasons.some((item) => item.code === 'needs-adoption')) {
      outcome.set(id, { action: 'blocked', reasons: status.reasons });
      continue;
    }
    if (status.state === 'blocked' && status.reasons.some((item) => !item.code.startsWith('upstream-'))) {
      outcome.set(id, { action: 'blocked', reasons: status.reasons });
      continue;
    }
    const blocking = (graph.dependencies.get(id) ?? []).filter((dep) => {
      const depOutcome = outcome.get(dep);
      return !depOutcome || depOutcome.action === 'conflict' || depOutcome.action === 'blocked';
    });
    if (blocking.length > 0) {
      outcome.set(id, {
        action: 'blocked',
        reasons: blocking.map((dep) => {
          const depOutcome = outcome.get(dep);
          const label = depOutcome?.action ?? 'unavailable';
          return reason('upstream-blocked', `upstream ${dep} is ${label}`, { target: dep });
        }),
      });
      continue;
    }
    outcome.set(id, { action: 'build', reasons: status.reasons });
  }
  return outcome;
}
