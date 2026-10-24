type DiffOp = { type: 'equal' | 'del' | 'add'; line: string };

export function unifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return '';
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length * right.length > 1_500_000) {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ diff omitted because the file is large @@\n`;
  }
  const ops = lcsDiff(left, right);
  return formatUnified(filePath, ops);
}

function lcsDiff(left: string[], right: string[]): DiffOp[] {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const scores: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let col = right.length - 1; col >= 0; col -= 1) {
      const current = scores[row];
      const below = scores[row + 1];
      if (!current || !below) continue;
      if (left[row] === right[col]) current[col] = (below[col + 1] ?? 0) + 1;
      else current[col] = Math.max(below[col] ?? 0, current[col + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let row = 0;
  let col = 0;
  while (row < left.length && col < right.length) {
    const leftLine = left[row];
    const rightLine = right[col];
    if (leftLine === undefined || rightLine === undefined) break;
    if (leftLine === rightLine) {
      ops.push({ type: 'equal', line: leftLine });
      row += 1;
      col += 1;
      continue;
    }
    const down = scores[row + 1]?.[col] ?? 0;
    const across = scores[row]?.[col + 1] ?? 0;
    if (down >= across) {
      ops.push({ type: 'del', line: leftLine });
      row += 1;
    } else {
      ops.push({ type: 'add', line: rightLine });
      col += 1;
    }
  }
  while (row < left.length) {
    const line = left[row];
    if (line !== undefined) ops.push({ type: 'del', line });
    row += 1;
  }
  while (col < right.length) {
    const line = right[col];
    if (line !== undefined) ops.push({ type: 'add', line });
    col += 1;
  }
  return ops;
}

function formatUnified(filePath: string, ops: DiffOp[]): string {
  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.type === 'equal') {
      index += 1;
      continue;
    }
    let start = index;
    let end = index + 1;
    while (end < ops.length) {
      if (ops[end]?.type !== 'equal') {
        end += 1;
        continue;
      }
      let gap = 0;
      let cursor = end;
      while (cursor < ops.length && ops[cursor]?.type === 'equal') {
        gap += 1;
        cursor += 1;
      }
      if (cursor < ops.length && gap <= 6) {
        end = cursor;
        continue;
      }
      break;
    }
    let contextBefore = 0;
    while (contextBefore < 3 && start > 0 && ops[start - 1]?.type === 'equal') {
      start -= 1;
      contextBefore += 1;
    }
    let contextAfter = 0;
    while (contextAfter < 3 && end < ops.length && ops[end]?.type === 'equal') {
      end += 1;
      contextAfter += 1;
    }
    hunks.push(renderHunk(ops, start, end));
    index = end;
  }
  if (hunks.length === 0) return '';
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...hunks].join('\n') + '\n';
}

function renderHunk(ops: DiffOp[], start: number, end: number): string {
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < start; index += 1) {
    const op = ops[index];
    if (!op || op.type === 'add') {
      if (op?.type === 'add') newLine += 1;
      continue;
    }
    if (op.type === 'del') oldLine += 1;
    else {
      oldLine += 1;
      newLine += 1;
    }
  }
  const oldStart = oldLine;
  const newStart = newLine;
  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (let index = start; index < end; index += 1) {
    const op = ops[index];
    if (!op) continue;
    if (op.type === 'equal') {
      body.push(` ${op.line}`);
      oldCount += 1;
      newCount += 1;
    } else if (op.type === 'del') {
      body.push(`-${op.line}`);
      oldCount += 1;
    } else {
      body.push(`+${op.line}`);
      newCount += 1;
    }
  }
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body].join('\n');
}
