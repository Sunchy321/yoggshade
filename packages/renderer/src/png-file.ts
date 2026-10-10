/** PNG 文件 IO（CLI 专用；ADR-0002 拆出——node:fs 不进浏览器包）。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePngBytes, encodePngBytes } from './image.js';
import type { RGBAImage } from './types.js';

export function decodePng(path: string): RGBAImage {
  return decodePngBytes(readFileSync(path));
}

/** uint8 RGBA（h×w×4，行主序）→ PNG 文件。 */
export function encodePng(path: string, w: number, h: number, rgba: Uint8Array): void {
  writeFileSync(path, encodePngBytes(w, h, rgba));
}
