import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type YAMLMap,
} from 'yaml';
import { MANIFEST_VERSION } from './constants.js';
import { SpecdepsError, type SourceLocation } from './errors.js';
import { validateCommand, validateRelativePath, validateSectionId } from './paths.js';
import type { Manifest, SourceDecl, TargetDecl } from './types.js';

const TARGET_FIELDS = ['sources', 'output', 'prompt', 'runner', 'generatorVersion'];
const OUTPUT_FIELDS = ['path', 'section'];
const RUNNER_FIELDS = ['command', 'args'];

type MapEntry = {
  key: string;
  keyLocation: SourceLocation;
  value: Node | null;
};

export function parseManifest(text: string, file: string): Manifest {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const pos = error?.linePos?.[0];
    throw new SpecdepsError(error?.message ?? 'invalid YAML', 'manifest-syntax', {
      location: {
        file,
        line: pos?.line ?? 1,
        column: pos?.col ?? 1,
      },
    });
  }
  if (!isMap(doc.contents)) {
    throw new SpecdepsError('manifest root must be a mapping', 'manifest-schema', {
      location: { file, line: 1, column: 1 },
    });
  }

  const root = mapEntries(doc.contents, file, lineCounter);
  requireKnown(root, ['version', 'targets'], 'manifest');
  const version = requireEntry(root, 'version', 'manifest');
  if (!isScalar(version.value) || version.value.value !== MANIFEST_VERSION) {
    throw new SpecdepsError('version must be 1', 'manifest-schema', { location: version.keyLocation });
  }
  const targetsEntry = requireEntry(root, 'targets', 'manifest');
  if (!isMap(targetsEntry.value)) {
    throw new SpecdepsError('targets must be a mapping', 'manifest-schema', {
      location: targetsEntry.keyLocation,
    });
  }

  const targets: TargetDecl[] = [];
  for (const entry of mapEntries(targetsEntry.value, file, lineCounter)) {
    validateSectionId(entry.key, entry.keyLocation, `target id "${entry.key}"`);
    if (!isMap(entry.value)) {
      throw new SpecdepsError(`target "${entry.key}" must be a mapping`, 'manifest-schema', {
        location: entry.keyLocation,
      });
    }
    targets.push(parseTarget(entry.key, entry.keyLocation, entry.value, file, lineCounter));
  }

  assertOwnership(targets);
  return { version: 1, file, targets };
}

function parseTarget(
  id: string,
  location: SourceLocation,
  map: YAMLMap,
  file: string,
  lineCounter: LineCounter,
): TargetDecl {
  const entries = mapEntries(map, file, lineCounter);
  requireKnown(entries, TARGET_FIELDS, `target "${id}"`);
  const sourcesEntry = requireEntry(entries, 'sources', `target "${id}"`);
  const outputEntry = requireEntry(entries, 'output', `target "${id}"`);
  const promptEntry = requireEntry(entries, 'prompt', `target "${id}"`);
  const runnerEntry = requireEntry(entries, 'runner', `target "${id}"`);
  const versionEntry = entries.find((entry) => entry.key === 'generatorVersion');

  if (!isSeq(sourcesEntry.value) || sourcesEntry.value.items.length === 0) {
    throw new SpecdepsError(`target "${id}" needs at least one source`, 'manifest-schema', {
      location: sourcesEntry.keyLocation,
    });
  }
  const sources: SourceDecl[] = [];
  for (const item of sourcesEntry.value.items) {
    sources.push(parseSource(id, item, file, lineCounter, sourcesEntry.keyLocation));
  }
  const seenSources = new Set<string>();
  for (const source of sources) {
    const key = source.kind === 'path' ? `path:${source.path}` : `target:${source.target}`;
    if (seenSources.has(key)) {
      throw new SpecdepsError(`target "${id}" repeats source ${key}`, 'manifest-schema', {
        location: source.location,
      });
    }
    seenSources.add(key);
  }

  if (!isMap(outputEntry.value)) {
    throw new SpecdepsError(`target "${id}" output must be a mapping`, 'manifest-schema', {
      location: outputEntry.keyLocation,
    });
  }
  const outputEntries = mapEntries(outputEntry.value, file, lineCounter);
  requireKnown(outputEntries, OUTPUT_FIELDS, `target "${id}" output`);
  const pathEntry = requireEntry(outputEntries, 'path', `target "${id}" output`);
  const sectionEntry = requireEntry(outputEntries, 'section', `target "${id}" output`);
  const outputPath = requiredString(pathEntry, `target "${id}" output path`);
  validateRelativePath(outputPath, pathEntry.keyLocation, `target "${id}" output path`);
  const section = requiredString(sectionEntry, `target "${id}" output section`);
  validateSectionId(section, sectionEntry.keyLocation, `target "${id}" section`);

  const promptPath = requiredString(promptEntry, `target "${id}" prompt`);
  validateRelativePath(promptPath, promptEntry.keyLocation, `target "${id}" prompt`);

  if (!isMap(runnerEntry.value)) {
    throw new SpecdepsError(`target "${id}" runner must be a mapping`, 'manifest-schema', {
      location: runnerEntry.keyLocation,
    });
  }
  const runnerEntries = mapEntries(runnerEntry.value, file, lineCounter);
  requireKnown(runnerEntries, RUNNER_FIELDS, `target "${id}" runner`);
  const commandEntry = requireEntry(runnerEntries, 'command', `target "${id}" runner`);
  const argsEntry = requireEntry(runnerEntries, 'args', `target "${id}" runner`);
  const command = requiredString(commandEntry, `target "${id}" runner command`);
  validateCommand(command, commandEntry.keyLocation);
  if (!isSeq(argsEntry.value)) {
    throw new SpecdepsError(`target "${id}" runner args must be a list`, 'manifest-schema', {
      location: argsEntry.keyLocation,
    });
  }
  const args: string[] = [];
  for (const argNode of argsEntry.value.items) {
    if (!isScalar(argNode) || typeof argNode.value !== 'string' || argNode.value.includes('\0')) {
      throw new SpecdepsError(`target "${id}" runner args must be strings`, 'manifest-schema', {
        location: nodeLocation(file, lineCounter, isNode(argNode) ? argNode : argsEntry.value),
      });
    }
    args.push(argNode.value);
  }

  let generatorVersion = '';
  if (versionEntry) {
    generatorVersion = requiredString(versionEntry, `target "${id}" generatorVersion`);
    if (generatorVersion.includes('\0')) {
      throw new SpecdepsError(`target "${id}" generatorVersion is invalid`, 'manifest-schema', {
        location: versionEntry.keyLocation,
      });
    }
  }

  return {
    id,
    location,
    sources,
    outputPath,
    outputLocation: sectionEntry.keyLocation,
    section,
    promptPath,
    promptLocation: promptEntry.keyLocation,
    runner: { command, args },
    runnerLocation: runnerEntry.keyLocation,
    generatorVersion,
  };
}

function parseSource(
  targetId: string,
  item: unknown,
  file: string,
  lineCounter: LineCounter,
  fallback: SourceLocation,
): SourceDecl {
  if (isAlias(item)) {
    throw new SpecdepsError(`target "${targetId}" sources cannot use aliases`, 'manifest-schema', {
      location: nodeLocation(file, lineCounter, item),
    });
  }
  if (!isMap(item)) {
    throw new SpecdepsError(`target "${targetId}" source must be a mapping`, 'manifest-schema', {
      location: nodeLocation(file, lineCounter, isNode(item) ? item : null) ?? fallback,
    });
  }
  const entries = mapEntries(item, file, lineCounter);
  const keys = entries.map((entry) => entry.key);
  if (keys.length !== 1 || (keys[0] !== 'path' && keys[0] !== 'target')) {
    throw new SpecdepsError(
      `target "${targetId}" source must set exactly one of path or target`,
      'manifest-schema',
      { location: entries[0]?.keyLocation ?? fallback },
    );
  }
  const entry = entries[0];
  if (!entry) {
    throw new SpecdepsError(`target "${targetId}" source is empty`, 'manifest-schema', {
      location: fallback,
    });
  }
  const value = requiredString(entry, `target "${targetId}" source ${entry.key}`);
  if (entry.key === 'path') {
    validateRelativePath(value, entry.keyLocation, `target "${targetId}" source path`);
    return { kind: 'path', path: value, location: entry.keyLocation };
  }
  validateSectionId(value, entry.keyLocation, `target "${targetId}" source target`);
  return { kind: 'target', target: value, location: entry.keyLocation };
}

function assertOwnership(targets: TargetDecl[]): void {
  const owners = new Map<string, TargetDecl>();
  const outputs = new Map<string, string[]>();
  for (const target of targets) {
    const key = `${target.outputPath}\0${target.section}`;
    const previous = owners.get(key);
    if (previous) {
      throw new SpecdepsError(
        `output ${target.outputPath} section "${target.section}" is already owned by target "${previous.id}"`,
        'output-collision',
        { location: target.outputLocation },
      );
    }
    owners.set(key, target);
    const list = outputs.get(target.outputPath) ?? [];
    list.push(target.id);
    outputs.set(target.outputPath, list);
  }

  for (const target of targets) {
    if (target.promptPath === target.outputPath) {
      throw new SpecdepsError(`target "${target.id}" uses its output as the prompt`, 'self-dependency', {
        location: target.promptLocation,
      });
    }
    for (const source of target.sources) {
      if (source.kind !== 'path') continue;
      if (source.path === target.outputPath) {
        throw new SpecdepsError(`target "${target.id}" uses its own output as a source`, 'self-dependency', {
          location: source.location,
        });
      }
      const managedBy = outputs.get(source.path);
      if (managedBy) {
        throw new SpecdepsError(
          `source ${source.path} is a managed output of ${managedBy.join(', ')}; depend on that target to receive only its generated section`,
          'self-dependency',
          { location: source.location },
        );
      }
    }
  }
}

function mapEntries(map: YAMLMap, file: string, lineCounter: LineCounter): MapEntry[] {
  const entries: MapEntry[] = [];
  for (const pair of map.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      throw new SpecdepsError('mapping keys must be strings', 'manifest-schema', {
        location: nodeLocation(file, lineCounter, isNode(pair.key) ? pair.key : null),
      });
    }
    const value = pair.value;
    entries.push({
      key: pair.key.value,
      keyLocation: nodeLocation(file, lineCounter, pair.key),
      value: isNode(value) ? value : null,
    });
  }
  return entries;
}

function requireKnown(entries: MapEntry[], allowed: readonly string[], what: string): void {
  for (const entry of entries) {
    if (!allowed.includes(entry.key)) {
      throw new SpecdepsError(`${what} has unknown field "${entry.key}"`, 'manifest-schema', {
        location: entry.keyLocation,
      });
    }
  }
}

function requireEntry(entries: MapEntry[], key: string, what: string): MapEntry {
  const found = entries.find((entry) => entry.key === key);
  if (!found) {
    const location = entries[0]?.keyLocation ?? { file: 'specdeps.yaml', line: 1, column: 1 };
    throw new SpecdepsError(`${what} is missing "${key}"`, 'manifest-schema', { location });
  }
  return found;
}

function requiredString(entry: MapEntry, what: string): string {
  if (!isScalar(entry.value) || typeof entry.value.value !== 'string' || entry.value.value.length === 0) {
    throw new SpecdepsError(`${what} must be a non-empty string`, 'manifest-schema', {
      location: entry.keyLocation,
    });
  }
  return entry.value.value;
}

function nodeLocation(
  file: string,
  lineCounter: LineCounter,
  node: { range?: [number, number, number] | null } | null,
): SourceLocation {
  const offset = node?.range?.[0] ?? 0;
  const pos = lineCounter.linePos(offset);
  return {
    file,
    line: pos.line > 0 ? pos.line : 1,
    column: pos.col > 0 ? pos.col : 1,
  };
}
