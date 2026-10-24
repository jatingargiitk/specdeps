import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(packageRoot, 'dist', 'cli', 'main.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

test('cli init is explicit, json status is machine readable, and help exits cleanly', () => {
  const help = runCli(['--help'], packageRoot);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /specdeps init/);
  assert.match(help.stdout, /does not mean it is still consistent/);

  const version = runCli(['--version'], packageRoot);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.1\.0/);

  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'specdeps-cli-')));
  try {
    const first = runCli(['init', '--example'], dir);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(path.join(dir, 'specs', 'checkout.md'), 'utf8').includes('Client exception: refunds require manual approval above $500.'), true);
    const second = runCli(['init', '--example'], dir);
    assert.equal(second.status, 2);
    assert.match(second.stdout, /refusing to overwrite/);
    const status = runCli(['status', '--json'], dir);
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout) as { ok: boolean; targets: Array<{ id: string; state: string }> };
    assert.equal(parsed.ok, true);
    assert.ok(parsed.targets.some((target) => target.id === 'checkout-spec' && target.state === 'unbuilt'));
    const doctor = runCli(['doctor', '--json'], dir);
    const doctorParsed = JSON.parse(doctor.stdout) as { ok: boolean };
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.equal(doctorParsed.ok, true);
    const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'specdeps-cli-bare-')));
    try {
      assert.equal(runCli(['init'], bare).status, 0);
      assert.equal(runCli(['init'], bare).status, 2);
      assert.equal(readFileSync(path.join(bare, 'specdeps.yaml'), 'utf8').includes('targets: {}'), true);
      assert.equal(readdirSync(bare).includes('sources'), false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the implementation does not fetch remote documents', () => {
  const sourceRoot = path.join(packageRoot, 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, name.name);
      if (name.isDirectory()) walk(next);
      else if (name.name.endsWith('.ts')) files.push(next);
    }
  };
  walk(sourceRoot);
  const banned = [/fetch\s*\(/, /from 'node:http'/, /from 'node:https'/, /http\.get\s*\(/, /https\.get\s*\(/, /axios/];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
  }
});
