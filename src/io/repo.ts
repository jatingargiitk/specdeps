import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SpecdepsError } from '../core/errors.js';
import { validateRelativePath } from '../core/paths.js';
import type { RepoFs } from '../core/engine.js';
import type { FileList, FileRead } from '../core/types.js';

const HERE: { file: string; line: number; column: number } = { file: 'path', line: 1, column: 1 };

export function createRepoFs(root: string): RepoFs {
  const abs = path.resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new SpecdepsError(`repository root is not a directory: ${root}`, 'invalid-root');
  }
  return new NodeRepo(realpathSync(abs));
}

class NodeRepo implements RepoFs {
  constructor(readonly root: string) {}

  read(rel: string): FileRead {
    let abs: string;
    try {
      abs = this.resolve(rel);
    } catch (error) {
      if (error instanceof SpecdepsError) return { ok: false, code: 'escape', message: error.message };
      throw error;
    }
    if (!existsSync(abs)) return { ok: false, code: 'missing', message: `missing file ${rel}` };
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      return { ok: false, code: 'escape', message: `symlink escapes repository root: ${rel}` };
    }
    if (!stat.isFile()) return { ok: false, code: 'invalid', message: `${rel} is not a file` };
    return { ok: true, bytes: readFileSync(abs) };
  }

  write(rel: string, data: Buffer): void {
    const abs = this.resolve(rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.specdeps-tmp`;
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, abs);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file may not exist if writeFileSync failed first.
      }
      throw new SpecdepsError(
        `cannot write ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        'write-failed',
        { exitCode: 1 },
      );
    }
  }

  list(rel: string): FileList {
    let abs: string;
    try {
      abs = this.resolve(rel);
    } catch (error) {
      if (error instanceof SpecdepsError) return { ok: false, code: 'escape', message: error.message };
      throw error;
    }
    if (!existsSync(abs)) return { ok: false, code: 'missing', message: `missing ${rel}` };
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return { ok: false, code: 'escape', message: `symlink escapes repository root: ${rel}` };
    if (!stat.isDirectory()) return { ok: false, code: 'invalid', message: `${rel} is not a directory` };
    return { ok: true, names: readdirSync(abs).sort() };
  }

  private resolve(rel: string): string {
    try {
      validateRelativePath(rel, HERE, 'path');
    } catch (error) {
      if (error instanceof SpecdepsError) {
        throw new SpecdepsError(error.message, 'escape');
      }
      throw error;
    }
    const parts = rel.split('/');
    let current = this.root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined || part.length === 0 || part === '.' || part === '..') {
        throw new SpecdepsError(`path escapes repository root: ${rel}`, 'escape');
      }
      current = path.join(current, part);
      if (!existsSync(current)) {
        for (let rest = index + 1; rest < parts.length; rest += 1) {
          const next = parts[rest];
          if (next === undefined || next.length === 0 || next === '.' || next === '..') {
            throw new SpecdepsError(`path escapes repository root: ${rel}`, 'escape');
          }
          current = path.join(current, next);
        }
        return assertInside(this.root, current, rel);
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(current);
        } catch (error) {
          throw new SpecdepsError(
            `cannot resolve symlink ${rel}: ${error instanceof Error ? error.message : String(error)}`,
            'escape',
          );
        }
        assertInside(this.root, target, rel);
        current = target;
      }
    }
    return assertInside(this.root, current, rel);
  }
}

function assertInside(root: string, abs: string, rel: string): string {
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SpecdepsError(`symlink escapes repository root: ${rel}`, 'escape');
  }
  return abs;
}
