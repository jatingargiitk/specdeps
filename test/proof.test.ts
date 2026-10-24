import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { outsidePieces, sectionInterior } from '../src/core/markers.js';
import { createEngine } from '../src/index.js';
import type { GeneratorRunner } from '../src/core/types.js';
import { EXCEPTION, makeProject, removeProject, trackingRunner } from './helpers.js';

const HUMAN = [
  EXCEPTION,
  'Human note: settlement policy commentary stays outside the generated section.',
  'Owner note: do not rewrite this paragraph — it is a decision.  \n',
];

function owned(file: string): Buffer {
  const pieces = outsidePieces(readFileSync(file));
  assert.ok(pieces, `markers failed for ${file}`);
  return Buffer.concat(pieces ?? []);
}

function targetOf(dir: string, id: string) {
  const status = createEngine(dir).status().targets.find((target) => target.id === id);
  assert.ok(status, id);
  return status;
}

test('proof: a source change stales dependents, rebuilds only them, and keeps the human decision', async () => {
  const dir = makeProject();
  try {
    const checkout = path.join(dir, 'specs', 'checkout.md');
    const summary = path.join(dir, 'docs', 'payments-summary.md');
    const unrelated = path.join(dir, 'docs', 'unrelated.md');
    const originalCheckout = readFileSync(checkout);
    const originalSummaryOwned = owned(summary);
    const originalCheckoutOwned = owned(checkout);
    const originalUnrelated = readFileSync(unrelated);
    const originalRisk = sectionInterior(originalCheckout, 'risk');
    assert.ok(originalCheckout.includes(Buffer.from(EXCEPTION)));
    assert.ok(originalCheckout.includes(Buffer.from('decision.  \n')));

    for (const id of ['payment-summary', 'checkout-spec', 'checkout-risk', 'shipping-note']) {
      assert.equal(targetOf(dir, id).state, 'unbuilt');
    }

    const engine = createEngine(dir);
    const tracked = trackingRunner(dir);
    const first = await engine.build(undefined, tracked.runner);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.proposalId);
    assert.deepEqual(
      tracked.calls.map((call) => call.target),
      ['checkout-risk', 'payment-summary', 'checkout-spec', 'shipping-note'],
    );
    assert.ok(readFileSync(checkout).equals(originalCheckout));
    assert.ok(readFileSync(unrelated).equals(originalUnrelated));

    const proposal = JSON.parse(readFileSync(path.join(dir, '.specdeps', 'proposals', `${first.proposalId}.json`), 'utf8')) as {
      targets: Array<{ id: string; content: string }>;
    };
    const summaryProposal = proposal.targets.find((target) => target.id === 'payment-summary');
    const checkoutCall = tracked.calls.find((call) => call.target === 'checkout-spec');
    const upstream = checkoutCall?.sources.find((source) => source.kind === 'target');
    assert.equal(upstream?.content, summaryProposal?.content);
    assert.equal(readFileSync(summary, 'utf8').includes('Cards and ACH are accepted.'), false);
    assert.equal(upstream?.content.includes('Cards and ACH are accepted.'), true);
    const requestText = JSON.stringify(tracked.calls);
    for (const human of HUMAN) assert.equal(requestText.includes(human), false, human);

    const applied = engine.apply(first.proposalId);
    assert.equal(applied.ok, true, applied.message);
    assert.ok(owned(checkout).equals(originalCheckoutOwned));
    assert.ok(owned(summary).equals(originalSummaryOwned));
    assert.ok(readFileSync(checkout).includes(Buffer.from(EXCEPTION)));
    assert.ok(readFileSync(checkout).includes(Buffer.from('decision.  \n')));
    assert.equal(engine.apply(first.proposalId).ok, false);

    tracked.calls.length = 0;
    const again = await engine.build(undefined, tracked.runner);
    assert.equal(again.ok, true);
    assert.equal(again.proposalId, null);
    assert.equal(again.message, 'nothing to build');
    assert.equal(tracked.calls.length, 0);
    for (const id of ['payment-summary', 'checkout-spec', 'checkout-risk', 'shipping-note']) {
      assert.equal(targetOf(dir, id).state, 'current');
    }

    const payments = path.join(dir, 'sources', 'payments.md');
    writeFileSync(payments, `${readFileSync(payments, 'utf8').trimEnd()}\n- Wallets are accepted.\n`);
    assert.equal(targetOf(dir, 'payment-summary').state, 'stale');
    assert.ok(targetOf(dir, 'payment-summary').reasons.some((reason) => reason.code === 'source-changed'));
    assert.equal(targetOf(dir, 'checkout-spec').state, 'stale');
    assert.ok(targetOf(dir, 'checkout-spec').reasons.some((reason) => reason.code === 'upstream-stale'));
    assert.equal(targetOf(dir, 'shipping-note').state, 'current');
    assert.equal(targetOf(dir, 'checkout-risk').state, 'current');
    assert.ok(readFileSync(unrelated).equals(originalUnrelated));

    const riskBefore = sectionInterior(readFileSync(checkout), 'risk');
    tracked.calls.length = 0;
    const rebuild = await engine.build(undefined, tracked.runner);
    assert.equal(rebuild.ok, true, JSON.stringify(rebuild));
    assert.deepEqual(
      tracked.calls.map((call) => call.target),
      ['payment-summary', 'checkout-spec'],
    );
    const checkoutBeforeApply = readFileSync(checkout);
    assert.equal(engine.apply(rebuild.proposalId ?? '').ok, true);
    assert.ok(owned(checkout).equals(originalCheckoutOwned));
    assert.ok(owned(summary).equals(originalSummaryOwned));
    assert.ok(readFileSync(summary, 'utf8').includes('- Wallets are accepted.'));
    assert.ok(readFileSync(checkout, 'utf8').includes('- Wallets are accepted.'));
    assert.ok(readFileSync(checkout).includes(Buffer.from(`${EXCEPTION}\n`)));
    assert.ok(riskBefore && sectionInterior(readFileSync(checkout), 'risk')?.equals(riskBefore));
    assert.ok(originalRisk);
    assert.ok(readFileSync(unrelated).equals(originalUnrelated));
    assert.equal(checkoutBeforeApply.includes(Buffer.from('- Wallets are accepted.')), false);

    const state = readFileSync(path.join(dir, '.specdeps', 'state.json'), 'utf8');
    assert.equal(state.includes('scripts/generate.mjs'), false);
    assert.equal(state.includes('Do not invent policy'), false);
    assert.equal(state.includes(EXCEPTION), false);
    const statusJson = JSON.stringify(engine.status());
    assert.equal(statusJson.includes('Do not invent policy'), false);
    assert.equal(statusJson.includes(EXCEPTION), false);
  } finally {
    removeProject(dir);
  }
});

test('proof: a manual edit inside a generated section conflicts and is not overwritten', async () => {
  const dir = makeProject();
  try {
    const engine = createEngine(dir);
    const tracked = trackingRunner(dir);
    const built = await engine.build(undefined, tracked.runner);
    assert.equal(engine.apply(built.proposalId ?? '').ok, true);
    const summary = path.join(dir, 'docs', 'payments-summary.md');
    const before = readFileSync(summary);
    const needle = Buffer.from('- Cards and ACH are accepted.');
    const at = before.indexOf(needle);
    const edited = Buffer.concat([
      before.subarray(0, at),
      Buffer.from('- Cards and ACH are accepteX.'),
      before.subarray(at + needle.length),
    ]);
    writeFileSync(summary, edited);
    assert.equal(targetOf(dir, 'payment-summary').state, 'conflict');
    assert.equal(targetOf(dir, 'checkout-spec').state, 'blocked');
    assert.equal(targetOf(dir, 'shipping-note').state, 'current');
    const proposals = readdirSync(path.join(dir, '.specdeps', 'proposals')).length;
    tracked.calls.length = 0;
    const report = await engine.build(undefined, tracked.runner);
    assert.equal(report.ok, false);
    assert.equal(report.proposalId, null);
    assert.equal(tracked.calls.length, 0);
    assert.ok(readFileSync(summary).equals(edited));
    assert.equal(readdirSync(path.join(dir, '.specdeps', 'proposals')).length, proposals);
  } finally {
    removeProject(dir);
  }
});

test('proof: a file changed after generation cannot be overwritten by an old proposal', async () => {
  const dir = makeProject();
  try {
    const engine = createEngine(dir);
    const built = await engine.build(undefined, trackingRunner(dir).runner);
    assert.equal(engine.apply(built.proposalId ?? '').ok, true);
    const payments = path.join(dir, 'sources', 'payments.md');
    writeFileSync(payments, `${readFileSync(payments, 'utf8').trimEnd()}\n- Wallets are accepted.\n`);
    const rebuild = await engine.build(undefined, trackingRunner(dir).runner);
    assert.ok(rebuild.proposalId);
    const checkout = path.join(dir, 'specs', 'checkout.md');
    const changed = Buffer.concat([readFileSync(checkout), Buffer.from('Edited after the proposal.\n')]);
    writeFileSync(checkout, changed);
    const summary = readFileSync(path.join(dir, 'docs', 'payments-summary.md'));
    const applied = engine.apply(rebuild.proposalId);
    assert.equal(applied.ok, false);
    assert.match(applied.message, /stale/);
    assert.ok(readFileSync(checkout).equals(changed));
    assert.ok(readFileSync(path.join(dir, 'docs', 'payments-summary.md')).equals(summary));
    assert.equal(readFileSync(checkout, 'utf8').includes('- Wallets are accepted.'), false);
  } finally {
    removeProject(dir);
  }
});

test('proof: a failed upstream build does not run dependents', async () => {
  const dir = makeProject();
  try {
    const checkout = path.join(dir, 'specs', 'checkout.md');
    const original = readFileSync(checkout);
    writeFileSync(
      path.join(dir, 'sources', 'payments.md'),
      '# Payments\n\n- Cards and ACH are accepted.\nSIMULATE_UPSTREAM_FAILURE\n',
    );
    const engine = createEngine(dir);
    const tracked = trackingRunner(dir);
    const report = await engine.build(undefined, tracked.runner);
    assert.equal(report.ok, false);
    assert.equal(report.results.find((result) => result.id === 'payment-summary')?.outcome, 'failed');
    assert.equal(report.results.find((result) => result.id === 'checkout-spec')?.outcome, 'blocked');
    assert.equal(tracked.calls.some((call) => call.target === 'checkout-spec'), false);
    assert.equal(tracked.calls.some((call) => call.target === 'payment-summary'), true);
    assert.ok(readFileSync(checkout).equals(original));
  } finally {
    removeProject(dir);
  }
});

test('prompt edits stale the target, and an unrelated build does not', async () => {
  const dir = makeProject();
  try {
    const engine = createEngine(dir);
    const built = await engine.build(undefined, trackingRunner(dir).runner);
    assert.equal(engine.apply(built.proposalId ?? '').ok, true);
    const prompt = path.join(dir, 'prompts', 'summarize.md');
    writeFileSync(prompt, `${readFileSync(prompt, 'utf8').trimEnd()}\nMention wallets.\n`);
    assert.equal(targetOf(dir, 'payment-summary').state, 'stale');
    assert.ok(targetOf(dir, 'payment-summary').reasons.some((reason) => reason.code === 'prompt-changed'));
    assert.equal(targetOf(dir, 'checkout-spec').state, 'stale');
    assert.equal(targetOf(dir, 'shipping-note').state, 'current');

    const only = await engine.build('shipping-note', trackingRunner(dir).runner);
    assert.equal(only.message, 'nothing to build');
    const summaryOnly = await engine.build('payment-summary', trackingRunner(dir).runner);
    assert.deepEqual(
      summaryOnly.results.map((result) => result.id),
      ['payment-summary'],
    );
  } finally {
    removeProject(dir);
  }
});

test('non-empty generated sections require explicit adoption before a rebuild', async () => {
  const dir = makeProject();
  try {
    const summary = path.join(dir, 'docs', 'payments-summary.md');
    const original = readFileSync(summary, 'utf8').replace(
      '<!-- specdeps:generated summary:start -->\n<!-- specdeps:generated summary:end -->',
      '<!-- specdeps:generated summary:start -->\nExisting AI text.\n<!-- specdeps:generated summary:end -->',
    );
    writeFileSync(summary, original);
    const engine = createEngine(dir);
    assert.equal(targetOf(dir, 'payment-summary').state, 'unbuilt');
    assert.ok(targetOf(dir, 'payment-summary').reasons.some((reason) => reason.code === 'needs-adoption'));
    const tracked = trackingRunner(dir);
    const blocked = await engine.build(undefined, tracked.runner);
    assert.equal(blocked.results.find((result) => result.id === 'payment-summary')?.outcome, 'blocked');
    assert.equal(tracked.calls.some((call) => call.target === 'payment-summary'), false);
    assert.equal(readFileSync(summary, 'utf8'), original);
    assert.equal(engine.doctor().ok, false);
    const adopted = engine.adopt('payment-summary');
    assert.equal(adopted.ok, true, adopted.message);
    assert.equal(targetOf(dir, 'payment-summary').state, 'stale');
    assert.ok(targetOf(dir, 'payment-summary').reasons.some((reason) => reason.code === 'adopted'));
    const edited = readFileSync(summary, 'utf8').replace('Existing AI text.', 'Existing AI text!');
    writeFileSync(summary, edited);
    assert.equal(targetOf(dir, 'payment-summary').state, 'conflict');
    tracked.calls.length = 0;
    await engine.build('payment-summary', tracked.runner);
    assert.equal(tracked.calls.length, 0);
    assert.equal(readFileSync(summary, 'utf8'), edited);
  } finally {
    removeProject(dir);
  }
});

test('symlink escapes and generator ownership markers are rejected', async () => {
  const dir = makeProject();
  const outside = path.join(dir, '..', `specdeps-outside-${process.pid}.md`);
  try {
    writeFileSync(outside, 'secret outside\n');
    const link = path.join(dir, 'sources', 'payments.md');
    const { rmSync, symlinkSync } = await import('node:fs');
    rmSync(link);
    symlinkSync(outside, link);
    const engine = createEngine(dir);
    assert.equal(targetOf(dir, 'payment-summary').state, 'blocked');
    assert.equal(engine.doctor().errors.some((error) => error.message.includes('symlink')), true);
    const tracked = trackingRunner(dir);
    const report = await engine.build(undefined, tracked.runner);
    assert.equal(report.results.find((result) => result.id === 'payment-summary')?.outcome, 'blocked');
    assert.equal(JSON.stringify(tracked.calls).includes('secret outside'), false);

    const markerRunner: GeneratorRunner = async () => ({
      ok: true,
      content: '<!-- specdeps:generated summary:start -->\nnope',
    });
    const clean = makeProject();
    try {
      const output = path.join(clean, 'docs', 'payments-summary.md');
      const before = readFileSync(output);
      const rejected = await createEngine(clean).build('payment-summary', markerRunner);
      assert.equal(rejected.results[0]?.outcome, 'failed');
      assert.equal(rejected.proposalId, null);
      assert.ok(readFileSync(output).equals(before));
    } finally {
      removeProject(clean);
    }
  } finally {
    removeProject(dir);
    const { rmSync } = await import('node:fs');
    rmSync(outside, { force: true });
  }
});
