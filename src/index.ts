export { SpecdepsError, formatError } from './core/errors.js';
export { PROTOCOL_VERSION } from './core/constants.js';
export { Engine } from './core/engine.js';
export { createProcessRunner } from './exec/runner.js';
export { createRepoFs } from './io/repo.js';
export type {
  AdoptReport,
  ApplyReport,
  BuildReport,
  Diagnostic,
  DiffReport,
  DoctorReport,
  Engine as SpecdepsEngine,
  InitReport,
  PlanReport,
  RepoFs,
  StatusReport,
} from './core/engine.js';
export type { GeneratorRequest, GeneratorRunner, TargetStateName } from './core/types.js';

import { Engine } from './core/engine.js';
import { createRepoFs } from './io/repo.js';

export function createEngine(root: string, manifestRel = 'specdeps.yaml'): Engine {
  return new Engine(createRepoFs(root), manifestRel);
}
