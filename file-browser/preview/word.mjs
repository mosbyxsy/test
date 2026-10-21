import { renderOffice } from './office.mjs';

/** 懒加载入口，正文提取在 Worker 中完成。 */
export function render(buffer, options) {
  return renderOffice(buffer, options, 'word');
}

