import { SpecdepsError } from './errors.js';
import type { Graph, Manifest } from './types.js';

export function buildGraph(manifest: Manifest): Graph {
  const ids = manifest.targets.map((target) => target.id);
  const known = new Set(ids);
  const dependencies = new Map<string, string[]>();

  for (const target of manifest.targets) {
    const deps: string[] = [];
    for (const source of target.sources) {
      if (source.kind !== 'target') continue;
      if (source.target === target.id) {
        throw new SpecdepsError(`target "${target.id}" depends on itself`, 'self-dependency', {
          location: source.location,
        });
      }
      if (!known.has(source.target)) {
        throw new SpecdepsError(
          `target "${target.id}" depends on unknown target "${source.target}"`,
          'unknown-target',
          { location: source.location },
        );
      }
      if (!deps.includes(source.target)) deps.push(source.target);
    }
    dependencies.set(target.id, deps);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, dependencies.get(id)?.length ?? 0);
    dependents.set(id, []);
  }
  for (const [id, deps] of dependencies) {
    for (const dep of deps) dependents.get(dep)?.push(id);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    const children = [...(dependents.get(id) ?? [])].sort();
    for (const child of children) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id)).sort();
    const cycle = findCycle(remaining, dependencies);
    const location = cycleLocation(manifest, cycle);
    throw new SpecdepsError(`dependency cycle: ${cycle.join(' -> ')}`, 'cycle', { location });
  }

  return { order, dependencies };
}

function findCycle(nodes: readonly string[], dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const set = new Set(nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    visiting.add(id);
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      if (!set.has(dep) && !visiting.has(dep)) continue;
      if (visiting.has(dep)) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (!visited.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of nodes) {
    if (!visited.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  const first = nodes[0] ?? 'unknown';
  return [first, first];
}

function cycleLocation(manifest: Manifest, cycle: readonly string[]) {
  const from = cycle[0];
  const to = cycle[1];
  const target = manifest.targets.find((item) => item.id === from);
  const source = target?.sources.find((item) => item.kind === 'target' && item.target === to);
  return source?.location ?? target?.location ?? { file: manifest.file, line: 1, column: 1 };
}
