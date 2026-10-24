#!/usr/bin/env node
// Deterministic prototype generator. It reads the specdeps protocol document
// from stdin and writes a JSON object to stdout. It does not fetch a network
// and it does not open the output file.

import { readFileSync } from 'node:fs';

const raw = readFileSync(0, 'utf8');
const input = JSON.parse(raw);

if (!input || typeof input !== 'object' || !Array.isArray(input.sources)) {
  process.stderr.write('invalid specdeps request\n');
  process.exit(1);
}

const pieces = input.sources.map((source) =>
  source && typeof source.content === 'string' ? source.content : '',
);
const joined = pieces.join('\n---\n');

if (joined.includes('SIMULATE_UPSTREAM_FAILURE')) {
  process.stderr.write('simulated upstream failure\n');
  process.exit(1);
}

const bullets = [];
for (const line of joined.split('\n')) {
  if (line.startsWith('- ')) bullets.push(line);
}

const section = typeof input.section === 'string' ? input.section : '';
let content;
if (section === 'payment-requirements') {
  const upstream = (pieces[0] ?? '').trimEnd();
  content = [
    'Checkout payment requirements',
    '',
    ...bullets,
    '',
    'Upstream section follows.',
    upstream,
  ].join('\n');
} else if (section === 'risk') {
  content = ['Shipping risk notes', '', ...bullets].join('\n');
} else {
  content = ['Summary', '', ...bullets].join('\n');
}

process.stdout.write(JSON.stringify({ content }));
