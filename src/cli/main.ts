#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './args.js';
import {
  HELP,
  renderAdopt,
  renderApply,
  renderBuild,
  renderDiff,
  renderDoctor,
  renderInit,
  renderPlan,
  renderStatus,
} from './render.js';
import { SpecdepsError, formatError } from '../core/errors.js';
import { Engine } from '../core/engine.js';
import { createProcessRunner } from '../exec/runner.js';
import { loadPrototypeFiles, minimalManifestFile } from '../init/prototype.js';
import { createRepoFs } from '../io/repo.js';

type Io = {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let json = false;
  try {
    const args = parseArgs(argv, io.cwd);
    json = args.json;
    if (args.version && args.command.length === 0) {
      io.stdout(`${readVersion()}\n`);
      return 0;
    }
    if (args.help || args.command === 'help' || args.command.length === 0) {
      io.stdout(HELP);
      return args.command.length === 0 && !args.help ? 2 : 0;
    }
    if (args.example && args.command !== 'init') throw new SpecdepsError('--example is only valid with init', 'usage');
    if (args.strict && args.command !== 'status') throw new SpecdepsError('--strict is only valid with status', 'usage');

    const repo = createRepoFs(args.root);
    const engine = new Engine(repo, args.manifest);
    const positional = requirePositionals(args.command, args.positionals);

    switch (args.command) {
      case 'init': {
        const files = args.example ? loadPrototypeFiles() : [minimalManifestFile()];
        const report = engine.init(files);
        emit(io, json, report, renderInit(report));
        return report.ok ? 0 : 2;
      }
      case 'status': {
        const report = engine.status();
        emit(io, json, { ok: true, ...report }, renderStatus(report));
        if (args.strict && report.targets.some((target) => target.state !== 'current')) return 1;
        if (report.targets.some((target) => target.state === 'conflict' || target.state === 'blocked')) return 1;
        return 0;
      }
      case 'plan': {
        const report = engine.plan(positional);
        emit(io, json, { ok: true, ...report }, renderPlan(report));
        return 0;
      }
      case 'build': {
        const report = await engine.build(positional, createProcessRunner(repo.root));
        emit(io, json, report, renderBuild(report));
        return report.ok ? 0 : 1;
      }
      case 'diff': {
        const report = engine.diff(requiredId(positional));
        emit(io, json, report, renderDiff(report));
        return report.ok ? 0 : 1;
      }
      case 'apply': {
        const report = engine.apply(requiredId(positional));
        emit(io, json, report, renderApply(report));
        return report.ok ? 0 : 1;
      }
      case 'adopt': {
        const report = engine.adopt(requiredId(positional));
        emit(io, json, report, renderAdopt(report.message));
        return report.ok ? 0 : 1;
      }
      case 'doctor': {
        const report = engine.doctor();
        emit(io, json, report, renderDoctor(report));
        return report.ok ? 0 : 1;
      }
      default:
        throw new SpecdepsError(`unknown command ${args.command}`, 'usage');
    }
  } catch (error) {
    if (error instanceof SpecdepsError) {
      const message = formatError(error);
      if (json) {
        const body: { ok: false; error: { code: string; message: string; location?: { file: string; line: number; column: number } } } = {
          ok: false,
          error: { code: error.code, message },
        };
        if (error.location) body.error.location = error.location;
        io.stdout(`${JSON.stringify(body, null, 2)}\n`);
      } else {
        io.stderr(`specdeps: ${message}\n`);
      }
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: { code: 'internal', message } }, null, 2)}\n`);
    else io.stderr(`specdeps: ${message}\n`);
    return 1;
  }
}

function emit(io: Io, json: boolean, report: unknown, text: string): void {
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : text);
}

function requirePositionals(command: string, positionals: readonly string[]): string | undefined {
  const single = new Set(['plan', 'build', 'diff', 'apply', 'adopt']);
  if (!single.has(command) && positionals.length > 0) {
    throw new SpecdepsError(`${command} does not take a target`, 'usage');
  }
  if ((command === 'plan' || command === 'build') && positionals.length > 1) {
    throw new SpecdepsError(`${command} accepts at most one target`, 'usage');
  }
  if ((command === 'diff' || command === 'apply' || command === 'adopt') && positionals.length !== 1) {
    throw new SpecdepsError(`${command} requires one argument`, 'usage');
  }
  return positionals[0];
}

function requiredId(value: string | undefined): string {
  if (value === undefined) throw new SpecdepsError('missing argument', 'usage');
  return value;
}

function readVersion(): string {
  const file = fileURLToPath(new URL('../../package.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
  return parsed.version ?? '0.0.0';
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const resolved = pathToFileURL(realpathSync(entry)).href;
    return resolved === import.meta.url || pathToFileURL(entry).href === import.meta.url;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`specdeps: ${message}\n`);
      process.exitCode = 1;
    });
}
