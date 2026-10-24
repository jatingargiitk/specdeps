import { decodeUtf8 } from './content.js';
import { SpecdepsError } from './errors.js';

const MARKER = /^<!-- specdeps:generated ([A-Za-z0-9][A-Za-z0-9_-]*):(start|end) -->$/;

export type GeneratedSection = {
  id: string;
  startLine: number;
  endLine: number;
  interiorStart: number;
  interiorEnd: number;
};

export type MarkerDiagnostic = {
  code: 'duplicate' | 'nested' | 'mismatched' | 'unclosed' | 'orphan-end' | 'invalid-marker';
  message: string;
  line: number;
  column: number;
};

export type MarkerParse =
  | { ok: true; sections: GeneratedSection[] }
  | { ok: false; diagnostics: MarkerDiagnostic[] };

type Line = {
  text: string;
  line: number;
  start: number;
  next: number;
};

function splitLines(buf: Buffer): { ok: true; lines: Line[] } | { ok: false; diagnostic: MarkerDiagnostic } {
  const lines: Line[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index <= buf.length; index += 1) {
    if (index !== buf.length && buf[index] !== 0x0a) continue;
    let textEnd = index;
    if (textEnd > start && buf[textEnd - 1] === 0x0d) textEnd -= 1;
    const decoded = decodeUtf8(buf.subarray(start, textEnd));
    if (!decoded.ok) {
      return {
        ok: false,
        diagnostic: {
          code: 'invalid-marker',
          message: `line ${line} is not valid UTF-8`,
          line,
          column: 1,
        },
      };
    }
    const next = index === buf.length ? buf.length : index + 1;
    lines.push({ text: decoded.text, line, start, next });
    if (index === buf.length) break;
    start = next;
    line += 1;
  }
  return { ok: true, lines };
}

export function parseGeneratedSections(buf: Buffer): MarkerParse {
  const split = splitLines(buf);
  if (!split.ok) return { ok: false, diagnostics: [split.diagnostic] };

  const diagnostics: MarkerDiagnostic[] = [];
  const sections: GeneratedSection[] = [];
  const seen = new Set<string>();
  let open: { id: string; line: number; interiorStart: number } | null = null;

  for (const line of split.lines) {
    if (!line.text.includes('specdeps:generated')) continue;
    const match = MARKER.exec(line.text);
    if (!match) {
      diagnostics.push({
        code: 'invalid-marker',
        message: 'ownership marker must occupy the entire line with no extra whitespace',
        line: line.line,
        column: 1,
      });
      continue;
    }
    const id = match[1];
    const kind = match[2];
    if (id === undefined || (kind !== 'start' && kind !== 'end')) continue;

    if (kind === 'start') {
      if (open) {
        diagnostics.push({
          code: 'nested',
          message: `section "${id}" starts before "${open.id}" ends (nested or overlapping markers)`,
          line: line.line,
          column: 1,
        });
        continue;
      }
      if (seen.has(id)) {
        diagnostics.push({
          code: 'duplicate',
          message: `duplicate generated section id "${id}"`,
          line: line.line,
          column: 1,
        });
        continue;
      }
      open = { id, line: line.line, interiorStart: line.next };
      continue;
    }

    if (!open) {
      diagnostics.push({
        code: 'orphan-end',
        message: `end marker for section "${id}" has no matching start`,
        line: line.line,
        column: 1,
      });
      continue;
    }
    if (open.id !== id) {
      diagnostics.push({
        code: 'mismatched',
        message: `end marker for section "${id}" does not match open section "${open.id}"`,
        line: line.line,
        column: 1,
      });
      continue;
    }
    sections.push({
      id,
      startLine: open.line,
      endLine: line.line,
      interiorStart: open.interiorStart,
      interiorEnd: line.start,
    });
    seen.add(id);
    open = null;
  }

  if (open) {
    diagnostics.push({
      code: 'unclosed',
      message: `generated section "${open.id}" is missing an end marker`,
      line: open.line,
      column: 1,
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, sections };
}

export function sectionInterior(file: Buffer, sectionId: string): Buffer | null {
  const parsed = parseGeneratedSections(file);
  if (!parsed.ok) return null;
  const section = parsed.sections.find((item) => item.id === sectionId);
  if (!section) return null;
  return Buffer.from(file.subarray(section.interiorStart, section.interiorEnd));
}

export function replaceSection(file: Buffer, sectionId: string, interior: Buffer): Buffer {
  const parsed = parseGeneratedSections(file);
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    throw new SpecdepsError(first?.message ?? 'invalid ownership markers', 'markers');
  }
  const section = parsed.sections.find((item) => item.id === sectionId);
  if (!section) {
    throw new SpecdepsError(`missing generated section "${sectionId}"`, 'missing-section');
  }
  return Buffer.concat([
    file.subarray(0, section.interiorStart),
    interior,
    file.subarray(section.interiorEnd),
  ]);
}

export function outsidePieces(file: Buffer): Buffer[] | null {
  const parsed = parseGeneratedSections(file);
  if (!parsed.ok) return null;
  const pieces: Buffer[] = [];
  let cursor = 0;
  const ordered = [...parsed.sections].sort((a, b) => a.interiorStart - b.interiorStart);
  for (const section of ordered) {
    pieces.push(Buffer.from(file.subarray(cursor, section.interiorStart)));
    cursor = section.interiorEnd;
  }
  pieces.push(Buffer.from(file.subarray(cursor)));
  return pieces;
}
