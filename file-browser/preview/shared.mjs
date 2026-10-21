/** 仅供懒加载预览模块使用的 DOM 与资源工具。 */
export function checkActive(signal) {
  signal.throwIfAborted();
}

export function makeElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  element.className = className;
  return element;
}

export function disposeImages(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
}
