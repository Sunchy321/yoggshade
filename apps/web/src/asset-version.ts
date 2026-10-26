/** 构建期生成（scripts/build-worker.ts）：pack+data 内容哈希前 16 hex。
 *  render-client 预取 URL 以 ?v=d567730b0b3152a8 携带——资产内容变则版本变，
 *  immutable 缓存（dist/_headers）因此不背旧资产。勿手改。 */
export const ASSET_VERSION = 'd567730b0b3152a8';
