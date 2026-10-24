import { spawn } from 'node:child_process';
import type { GeneratorRequest, GeneratorResponse, GeneratorRunner, TargetDecl } from '../core/types.js';

const TIMEOUT_MS = 30_000;
const MAX_STDOUT = 1_048_576;
const MAX_STDERR = 65_536;

export function createProcessRunner(root: string): GeneratorRunner {
  return (target, request) => execute(root, target, request);
}

async function execute(root: string, target: TargetDecl, request: GeneratorRequest): Promise<GeneratorResponse> {
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  const result = await collect({
    command: target.runner.command,
    args: target.runner.args,
    cwd: root,
    input: payload,
  });
  if (result.spawnError) return { ok: false, message: result.stderr || 'generator failed to start' };
  if (result.timedOut) return { ok: false, message: clip(`generator timed out after ${TIMEOUT_MS}ms`, result.stderr) };
  if (result.tooLarge) return { ok: false, message: 'generator output exceeded 1 MiB' };
  if (result.code !== 0) {
    return { ok: false, message: clip(`generator exited ${result.code}`, result.stderr) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return { ok: false, message: 'generator stdout is not JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || !('content' in parsed) || typeof parsed.content !== 'string') {
    return { ok: false, message: 'generator JSON must contain string content' };
  }
  return { ok: true, content: parsed.content };
}

function clip(message: string, stderr: string): string {
  const extra = stderr.trim();
  if (extra.length === 0) return message;
  const clipped = extra.length > 500 ? `${extra.slice(0, 500)}…` : extra;
  return `${message}: ${clipped}`;
}

function collect(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  input: Buffer;
}): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; tooLarge: boolean; spawnError: boolean }> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let timedOut = false;
    let tooLarge = false;
    let settled = false;
    const finish = (value: {
      code: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      tooLarge: boolean;
      spawnError: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_STDOUT) {
        tooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > MAX_STDERR) {
        child.kill('SIGKILL');
        return;
      }
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      finish({
        code: 1,
        stdout: '',
        stderr: missing ? `generator command not found: ${options.command}` : error.message,
        timedOut: false,
        tooLarge: false,
        spawnError: true,
      });
    });
    child.on('close', (code) => {
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        tooLarge,
        spawnError: false,
      });
    });
    child.stdin.on('error', () => {
      // The process may exit before stdin finishes. close/error handles the result.
    });
    child.stdin.end(options.input);
  });
}
