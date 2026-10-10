/** 资产源抽象（ticket 01 findings §5 的落地）。
 *
 * core（assets/font/ubertext/plan/render-card）只认这个接口：键 = 包/数据根的相对路径
 * （'/' 分隔，posix）。全部方法**同步**——调用方先把所需字节 hydrate 进内存（CLI =
 * source-fs.ts 的 fsSource 直读磁盘；浏览器 = render-client.ts 预取后 mapSource），
 * 再跑同步渲染链；缺漏由渲染期 KeyMissingError 兜底，入口补取后重跑。
 *
 * 本文件保持零 Node 依赖（ADR-0002）：浏览器包直接 import。 */
/** 同步读取时键缺失（调用方据此补 prime 重试；站点侧映射 4xx/5xx）。 */
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
  /** 预取（客户端把静态资产取回合并到渲染前；CLI 无操作）。 */
  prime?(keys: readonly string[]): Promise<void>;
}

/** 内存 Map 源（预取 hydrate 后 / 测试注入）。缺失 = KeyMissingError。 */
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
