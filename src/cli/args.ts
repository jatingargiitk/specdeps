import path from 'node:path';
import { SpecdepsError } from '../core/errors.js';

export type CliArgs = {
  root: string;
  manifest: string;
  json: boolean;
  strict: boolean;
  example: boolean;
  help: boolean;
  version: boolean;
  command: string;
  positionals: string[];
};

export function parseArgs(argv: readonly string[], cwd: string): CliArgs {
  let root = cwd;
  let manifest = 'specdeps.yaml';
  let json = false;
  let strict = false;
  let example = false;
  let help = false;
  let version = false;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--example') {
      example = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }
    if (arg === '--root' || arg === '--manifest') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new SpecdepsError(`${arg} requires a value`, 'usage');
      }
      index += 1;
      if (arg === '--root') root = path.resolve(cwd, value);
      else manifest = value;
      continue;
    }
    if (arg.startsWith('-')) throw new SpecdepsError(`unknown option ${arg}`, 'usage');
    rest.push(arg);
  }

  if (path.isAbsolute(manifest)) {
    const relative = path.relative(root, manifest);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SpecdepsError('--manifest must stay inside --root', 'usage');
    }
    manifest = relative.split(path.sep).join('/');
  }

  return {
    root,
    manifest,
    json,
    strict,
    example,
    help,
    version,
    command: rest[0] ?? '',
    positionals: rest.slice(1),
  };
}
