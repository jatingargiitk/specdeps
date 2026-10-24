import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpecdepsError } from '../src/core/errors.js';
import { buildGraph } from '../src/core/graph.js';
import { parseManifest } from '../src/core/manifest.js';

function load(text: string) {
  return buildGraph(parseManifest(text, 'specdeps.yaml'));
}

const runner = `    prompt: prompts/spec.md
    runner:
      command: node
      args:
        - scripts/generate.mjs
`;

test('manifest reports location-specific dependency and ownership errors', () => {
  assert.throws(
    () =>
      load(`version: 1
targets:
  b:
    sources:
      - target: a
    output:
      path: docs/b.md
      section: b
${runner}  a:
    sources:
      - target: b
    output:
      path: docs/a.md
      section: a
${runner}`),
    (error: unknown) => error instanceof SpecdepsError && error.code === 'cycle' && /a -> b -> a|b -> a -> b/.test(error.message),
  );

  const unknown = `version: 1
targets:
  checkout-spec:
    sources:
      - target: missing
    output:
      path: specs/checkout.md
      section: payment-requirements
${runner}`;
  assert.throws(
    () => load(unknown),
    (error: unknown) =>
      error instanceof SpecdepsError &&
      error.code === 'unknown-target' &&
      error.message.includes('missing') &&
      error.location !== undefined &&
      error.location.line > 1,
  );

  assert.throws(
    () =>
      load(`version: 1
targets:
  one:
    sources:
      - path: https://example.com/payments.md
    output:
      path: docs/one.md
      section: one
${runner}`),
    (error: unknown) => error instanceof SpecdepsError && error.code === 'remote-path',
  );

  assert.throws(
    () =>
      load(`version: 1
targets:
  one:
    sources:
      - path: ../payments.md
    output:
      path: docs/one.md
      section: one
${runner}`),
    (error: unknown) => error instanceof SpecdepsError && error.code === 'invalid-path',
  );

  assert.throws(
    () =>
      load(`version: 1
targets:
  one:
    sources:
      - path: docs/shared.md
    output:
      path: docs/shared.md
      section: one
${runner}`),
    (error: unknown) => error instanceof SpecdepsError && error.code === 'self-dependency',
  );

  assert.throws(
    () =>
      load(`version: 1
targets:
  summary:
    sources:
      - path: sources/payments.md
    output:
      path: docs/payments-summary.md
      section: summary
${runner}  copy:
    sources:
      - path: docs/payments-summary.md
    output:
      path: docs/copy.md
      section: copy
${runner}`),
    (error: unknown) =>
      error instanceof SpecdepsError && error.code === 'self-dependency' && error.message.includes('managed output'),
  );

  assert.throws(
    () =>
      load(`version: 1
targets:
  one:
    sources:
      - path: sources/payments.md
    output:
      path: docs/shared.md
      section: summary
${runner}  two:
    sources:
      - path: sources/other.md
    output:
      path: docs/shared.md
      section: summary
${runner}`),
    (error: unknown) => error instanceof SpecdepsError && error.code === 'output-collision',
  );
});

test('a file can declare multiple owned sections', () => {
  const graph = load(`version: 1
targets:
  beta:
    sources:
      - target: alpha
    output:
      path: specs/checkout.md
      section: beta
${runner}  alpha:
    sources:
      - path: sources/payments.md
      - path: sources/policy.md
    output:
      path: specs/checkout.md
      section: alpha
${runner}`);
  assert.deepEqual(graph.order, ['alpha', 'beta']);
  assert.deepEqual(graph.dependencies.get('beta'), ['alpha']);
});
