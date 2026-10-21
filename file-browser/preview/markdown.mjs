import { marked } from '../vendor/marked/marked.esm.js';
import DOMPurify from '../vendor/marked/purify.es.mjs';
import { checkActive, makeElement } from './shared.mjs';

/** 清理 Markdown 输出，再解析相对路径；禁止原始脚本、事件与嵌入式页面。 */
export async function render(buffer, { url, signal }) {
  checkActive(signal);
  const article = makeElement('article', undefined, 'document-reader markdown-reader');
  const source = new TextDecoder().decode(buffer);
  const html = marked.parse(source, { gfm: true, breaks: false });
  article.append(DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset'],
  }));
  for (const image of article.querySelectorAll('img')) {
    const target = new URL(image.getAttribute('src') || '', url);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== new URL(url).origin) {
      image.replaceWith(makeElement('span', `[外部图片未加载：${image.alt || ''}]`));
    } else {
      image.src = target.href;
      image.loading = 'lazy';
    }
  }
  for (const link of article.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const target = new URL(href, url);
    if (!['http:', 'https:', 'mailto:'].includes(target.protocol)) link.removeAttribute('href');
    else {
      link.href = target.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  for (const checkbox of article.querySelectorAll('input')) checkbox.disabled = true;
  checkActive(signal);
  return { element: article };
}
