/** 本地文件系统资产源（CLI/Bun 专用；ADR-0002 拆出——node:fs 不进浏览器包）。
 *
 * 与历史 readFileSync/join 语义逐字节一致。浏览器侧用 source.ts 的 mapSource。 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KeyMissingError, type AssetSource } from './source.js';

export function fsSource(root: string): AssetSource {
  return {
    text: key => {
      try {
        return readFileSync(join(root, key), 'utf-8');
      } catch {
        throw new KeyMissingError(key);
      }
    },
    bytes: key => {
      try {
        return readFileSync(join(root, key));
      } catch {
        throw new KeyMissingError(key);
      }
    },
    has:  key => existsSync(join(root, key)),
    list: prefix => {
      const dir = join(root, prefix);
      return existsSync(dir) ? readdirSync(dir).sort() : null;
    },
  };
}
