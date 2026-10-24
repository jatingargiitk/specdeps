import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outsidePieces, parseGeneratedSections, replaceSection } from '../src/core/markers.js';

const START = '<!-- specdeps:generated summary:start -->';
const END = '<!-- specdeps:generated summary:end -->';

test('parses sibling sections and rejects broken ownership markers', () => {
  const file = Buffer.from(`# Title\n\n${START}\nhello\n${END}\n\n<!-- specdeps:generated other:start -->\n<!-- specdeps:generated other:end -->\n`);
  const parsed = parseGeneratedSections(file);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.sections.map((section) => section.id),
    ['summary', 'other'],
  );
  assert.equal(file.subarray(parsed.sections[0]?.interiorStart, parsed.sections[0]?.interiorEnd).toString('utf8'), 'hello\n');
  assert.equal(file.subarray(parsed.sections[1]?.interiorStart, parsed.sections[1]?.interiorEnd).toString('utf8'), '');

  const cases: Array<{ text: string; code: string }> = [
    { text: `${START}\n${START}\n${END}\n${END}\n`, code: 'nested' },
    { text: `${START}\n${END}\n${START}\n${END}\n`, code: 'duplicate' },
    { text: `${START}\n<!-- specdeps:generated other:end -->\n`, code: 'mismatched' },
    { text: `${START}\nhello\n`, code: 'unclosed' },
    { text: `${END}\n`, code: 'orphan-end' },
    { text: `  ${START}\n${END}\n`, code: 'invalid-marker' },
  ];
  for (const item of cases) {
    const result = parseGeneratedSections(Buffer.from(item.text));
    assert.equal(result.ok, false, item.code);
    if (result.ok) continue;
    assert.equal(result.diagnostics[0]?.code, item.code);
  }
});

test('section replacement keeps surrounding bytes, including CRLF and trailing spaces', () => {
  const file = Buffer.from(`human\r\n${START}\r\nOLD\r\n${END}\r\nkeep  \r\n`);
  const next = replaceSection(file, 'summary', Buffer.from('NEW\n'));
  const start = Buffer.from(`${START}\r\n`);
  const end = Buffer.from(END);
  const prefix = file.subarray(0, file.indexOf(start) + start.length);
  const suffix = file.subarray(file.indexOf(end));
  assert.ok(prefix.equals(next.subarray(0, prefix.length)));
  assert.ok(suffix.equals(next.subarray(next.indexOf(end))));
  assert.ok(next.includes(Buffer.from('keep  \r\n')));
  const pieces = outsidePieces(file);
  const nextPieces = outsidePieces(next);
  assert.ok(pieces && nextPieces);
  assert.deepEqual(pieces?.map((piece) => piece.toString('utf8')), nextPieces?.map((piece) => piece.toString('utf8')));
});
