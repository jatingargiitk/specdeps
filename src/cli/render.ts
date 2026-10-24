import type { ApplyReport, BuildReport, DiffReport, DoctorReport, InitReport, PlanReport, StatusReport } from '../core/engine.js';

export const HELP = `specdeps — rebuild AI-derived Markdown without erasing human decisions

Usage:
  specdeps init [--example]
  specdeps status [--strict] [--json]
  specdeps plan [target] [--json]
  specdeps build [target] [--json]
  specdeps diff <proposal-id> [--json]
  specdeps apply <proposal-id> [--json]
  specdeps adopt <target> [--json]
  specdeps doctor [--json]

Preserving a human-written decision does not mean it is still consistent
with changed sources. specdeps checks freshness and ownership, not meaning.

Options:
  --root <dir>       Repository root (default: current directory)
  --manifest <path>  Manifest relative to the root (default: specdeps.yaml)
  --json             Print one JSON document for CI
  --strict           status exits 1 unless every target is current
  --example          init writes the prototype fixture
  --help             Show this help
  --version          Print the version
`;

export function renderStatus(report: StatusReport): string {
  if (report.targets.length === 0) return 'no targets\n';
  const width = Math.max(...report.targets.map((target) => target.id.length));
  return `${report.targets
    .map((target) => {
      const lines = [`${target.id.padEnd(width)}  ${target.state}`];
      for (const item of target.reasons) lines.push(`${' '.repeat(width)}  ${item.message}`);
      return lines.join('\n');
    })
    .join('\n')}\n`;
}

export function renderPlan(report: PlanReport): string {
  if (report.targets.length === 0) return 'no targets\n';
  const width = Math.max(...report.targets.map((target) => target.id.length));
  return `${report.targets
    .map((target) => {
      const lines = [`${target.id.padEnd(width)}  ${target.action}`];
      for (const item of target.reasons) lines.push(`${' '.repeat(width)}  ${item.message}`);
      return lines.join('\n');
    })
    .join('\n')}\n`;
}

export function renderBuild(report: BuildReport): string {
  const lines: string[] = [];
  if (report.results.length === 0) lines.push(report.message);
  const width = Math.max(6, ...report.results.map((result) => result.id.length));
  for (const result of report.results) {
    lines.push(`${result.id.padEnd(width)}  ${result.outcome}`);
    for (const item of result.reasons) lines.push(`${' '.repeat(width)}  ${item.message}`);
  }
  if (report.results.length > 0) lines.push(report.message);
  return `${lines.join('\n')}\n`;
}

export function renderDiff(report: DiffReport): string {
  if (!report.ok) return `${report.message}\n`;
  const lines = [`proposal ${report.id}`, 'targets:'];
  for (const target of report.targets) {
    lines.push(`  ${target.id}  ${target.outputPath}  section ${target.section}`);
    for (const item of target.reasons) lines.push(`    ${item.message}`);
  }
  for (const file of report.files) {
    lines.push(`file ${file.path} (${file.targets.join(', ')})`);
    lines.push(file.patch.endsWith('\n') ? file.patch.slice(0, -1) : file.patch);
  }
  return `${lines.join('\n')}\n`;
}

export function renderApply(report: ApplyReport): string {
  if (!report.ok) return `${report.message}\n`;
  return `${report.message}
human-owned bytes outside generated sections were left unchanged
preserving those bytes does not mean they are still consistent with changed sources
`;
}

export function renderInit(report: InitReport): string {
  if (!report.ok) return `${report.message}\n`;
  return `${[report.message, ...report.written].join('\n')}\n`;
}

export function renderDoctor(report: DoctorReport): string {
  if (report.errors.length === 0 && report.warnings.length === 0) return 'ok\n';
  const lines = [
    ...report.errors.map((item) => `error  ${item.message}`),
    ...report.warnings.map((item) => `warning  ${item.message}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderAdopt(message: string): string {
  return `${message}\n`;
}
