export type SourceLocation = {
  file: string;
  line: number;
  column: number;
};

export class SpecdepsError extends Error {
  readonly code: string;
  readonly location?: SourceLocation;
  readonly exitCode: number;

  constructor(
    message: string,
    code: string,
    options?: { location?: SourceLocation; exitCode?: number },
  ) {
    super(message);
    this.name = 'SpecdepsError';
    this.code = code;
    this.exitCode = options?.exitCode ?? 2;
    if (options?.location !== undefined) this.location = options.location;
  }
}

export function formatError(error: SpecdepsError): string {
  if (error.location) {
    return `${error.location.file}:${error.location.line}:${error.location.column}: ${error.message}`;
  }
  return error.message;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
