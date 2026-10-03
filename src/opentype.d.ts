/** opentype.js 类型声明（仅本仓用到的 API 子集）。 */
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    x:    number;
    y:    number;
    x1:   number;
    y1:   number;
    x2:   number;
    y2:   number;
  }
  export interface Path {
    commands: PathCommand[];
    getBoundingBox(): { x1: number, y1: number, x2: number, y2: number };
  }
  export interface Glyph {
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }
  export interface Font {
    unitsPerEm: number;
    ascender:   number;
    descender:  number;
    charToGlyph(ch: string): Glyph;
  }
  export function parse(buffer: ArrayBuffer): Font;
  export function loadSync(path: string): Font;
}
