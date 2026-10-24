export function decodeUtf8(
  bytes: Buffer,
): { ok: true; text: string } | { ok: false; message: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, message: 'not valid UTF-8' };
  }
}

export function normalizeGeneratedContent(
  content: string,
): { ok: true; content: string } | { ok: false; message: string } {
  if (content.includes('\0')) {
    return { ok: false, message: 'generator content contains NUL' };
  }
  if (content.includes('specdeps:generated')) {
    return { ok: false, message: 'generator content contains an ownership marker' };
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.includes('specdeps:generated')) {
    return { ok: false, message: 'generator content contains an ownership marker' };
  }
  if (normalized.length === 0) return { ok: true, content: '' };
  return { ok: true, content: normalized.endsWith('\n') ? normalized : `${normalized}\n` };
}

export function interiorHasContent(interior: Buffer): boolean {
  const decoded = decodeUtf8(interior);
  if (!decoded.ok) return true;
  return decoded.text.trim().length > 0;
}
