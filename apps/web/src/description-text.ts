/** 浏览器富文本归一为渲染协议支持的换行和 <b>/<i>，不携带 DOM 属性。
 * 局部取消加粗后 Chromium 会保留 <i style="">；不能直接删除整个起始标签，
 * 否则会丢失斜体并留下孤立的 </i>。 */
export function descriptionText(html: string): string {
  return html
    .replace(/<div(?:\s[^>]*)?>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(\/?)(b|i|strong|em)\b[^>]*>/gi, (_match, closing: string, tag: string) =>
      `<${closing}${/^(b|strong)$/i.test(tag) ? 'b' : 'i'}>`)
    .replace(/<(?!\/?(?:b|i)>)[^>]+>/gi, '');
}
