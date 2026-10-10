/** 资产源抽象（ticket 01 findings §5 的落地，票 14/10 Workers 路线的前置）。
 *
 * core（assets/font/ubertext/plan/render-card）只认这个接口：键 = 包/数据根的相对路径
 * （'/' 分隔，posix）。全部方法**同步**——Workers 侧先 `await prime(keys)` 把所需字节
 * hydrate 进内存，再跑同步渲染链（findings §5.2 方案 A；prime 缺漏由渲染期 KeyMissingError
 * 兜底，Worker 入口捕获后补 prime 重试一次）。
 *
 * - `fsSource`：CLI/本地 Bun（行为与历史 readFileSync/join 逐字节一致）。
 * - `mapSource`：Workers（静态资产绑定预取后 hydrate；或测试注入）。
 * 设计取舍见 explore/2026-10-08-diy-workers-port/findings.md §5（VFS /tmp 方案实测否决）。 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 同步读取时键缺失（Worker 侧据此补 prime 重试；站点侧映射 4xx/5xx）。 */
export class KeyMissingError extends Error {
  constructor(public readonly key: string) {
    super(`asset key missing: ${key}`);
    this.name = 'KeyMissingError';
  }
}

export interface AssetSource {
  /** 读为 UTF-8 文本（JSON 等）。缺失抛 KeyMissingError。 */
  text(key: string): string;
  /** 读为字节（PNG/TTF）。缺失抛 KeyMissingError。 */
  bytes(key: string): Uint8Array;
  /** 存在性探测（plan 原画选择、glyph 目录探测、水印占位裁决）。 */
  has(key: string): boolean;
  /** 目录清单（站点预设枚举；无目录语义的源返回 null，调用方回落 manifest）。 */
  list?(prefix: string): string[] | null;
  /** 预取（Worker 侧把静态资产往返合并到渲染前；CLI 无操作）。 */
  prime?(keys: readonly string[]): Promise<void>;
}

/** 本地文件系统源：join(root, key)，与历史 join(packDir, key) 语义逐字节一致。 */
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

/** 内存 Map 源（Workers hydrate 后 / 测试注入）。缺失 = KeyMissingError。 */
export function mapSource(bytes: Map<string, Uint8Array>): AssetSource {
  return {
    text: key => {
      const b = bytes.get(key);
      if (b === undefined) throw new KeyMissingError(key);
      return new TextDecoder().decode(b);
    },
    bytes: key => {
      const b = bytes.get(key);
      if (b === undefined) throw new KeyMissingError(key);
      return b;
    },
    has: key => bytes.has(key),
  };
}
