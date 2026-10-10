/** 浏览器端 FreeType wasm 资产 URL（vite `?url` 约定，ADR-0002）。
 *
 * 放在 renderer 包内而非 web：@zkl2333/freetype-wasm 是本包依赖，?url 解析走本包
 * node_modules；bun/CLI 不 import 本模块（bun 不认 ?url，CLI 走包内 locateFile）。 */
import freetypeWasmUrl from '@zkl2333/freetype-wasm/freetype.wasm?url';

export default freetypeWasmUrl;
