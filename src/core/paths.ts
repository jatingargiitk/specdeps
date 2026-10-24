import path from 'node:path';
import { SpecdepsError, type SourceLocation } from './errors.js';

const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function validateRelativePath(input: string, location: SourceLocation, what: string): void {
  if (input.length === 0) {
    throw new SpecdepsError(`${what} must be a relative path`, 'invalid-path', { location });
  }
  if (URI_SCHEME.test(input) || input.includes(':')) {
    throw new SpecdepsError(
      `${what} rejects remote or URI paths (${input}); v0.1 reads only files inside the repository`,
      'remote-path',
      { location },
    );
  }
  if (input.includes('\\') || input.includes('\0')) {
    throw new SpecdepsError(`${what} must use forward-slash relative paths`, 'invalid-path', { location });
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new SpecdepsError(`${what} must stay inside the repository (${input})`, 'invalid-path', { location });
  }
  const parts = input.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new SpecdepsError(`${what} must stay inside the repository (${input})`, 'invalid-path', { location });
  }
}

export function validateSectionId(input: string, location: SourceLocation, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input)) {
    throw new SpecdepsError(
      `${what} must match [A-Za-z0-9][A-Za-z0-9_-]*`,
      'invalid-id',
      { location },
    );
  }
}

export function validateCommand(command: string, location: SourceLocation): void {
  if (command.length === 0 || command.includes('\0') || /[\r\n]/.test(command)) {
    throw new SpecdepsError('runner command is invalid', 'invalid-runner', { location });
  }
  if (command.includes('/') || command.includes('\\')) {
    validateRelativePath(command, location, 'runner command');
  }
}
