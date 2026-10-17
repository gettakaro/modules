import { createHash } from 'node:crypto';

/** The one on-disk form of every generated JSON file. Its bytes are what sha256 covers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
