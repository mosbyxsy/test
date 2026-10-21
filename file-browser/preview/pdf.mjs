import { checkActive, makeElement } from './shared.mjs';

let libraryPromise;

/** 手机 PDF 阅读器：按需绘制，最多保留 6 个画布，离开页面后释放显存。 */
export async function render(buffer, { url, signal, onStatus }) {
  const assetRoot = new URL('../vendor/pdfjs/', import.meta.url);
  libraryPromise ||= import(new URL('pdf.min.mjs', assetRoot).href).catch((error) => {
    libraryPromise = null;
    throw error;
  });
  const pdfjs = await libraryPromise;
  checkActive(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', assetRoot).href;
  const task = pdfjs.getDocument({
    url,
    cMapUrl: new URL('cmaps/', assetRoot).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assetRoot).href,
    wasmUrl: new URL('wasm/', assetRoot).href,
    isEvalSupported: false,
  });
  const content = document.getElementById('preview-content');
  const pages = makeElement('div', undefined, 'pdf-pages');
  const retained = new Map();
  const queued = new Set();
  const near = new Set();
  const placeholders = new Map();
  let observer;
  let renderTask;
  let disposed = false;
  let rendering = false;

  function release(number) {
    const canvas = retained.get(number);
    if (!canvas) return;
    canvas.width = canvas.height = 0;
    retained.delete(number);
    const placeholder = placeholders.get(number);
    placeholder.classList.remove('rendered');
    placeholder.textContent = `第 ${number} 页`;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    renderTask?.cancel();
    for (const number of [...retained.keys()]) release(number);
    queued.clear();
    signal.removeEventListener('abort', dispose);
    task.destroy().catch(() => {});
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const pdf = await task.promise;
    checkActive(signal);
    const firstPage = await pdf.getPage(1);
    const firstSize = firstPage.getViewport({ scale: 1 });
    onStatus?.(`PDF · ${pdf.numPages} 页 · 上下滑动阅读`);

    async function renderNext() {
      if (rendering || disposed) return;
      rendering = true;
      try {
        while (queued.size && !disposed) {
          const number = queued.values().next().value;
          queued.delete(number);
          if (!near.has(number) || retained.has(number)) continue;
          const placeholder = placeholders.get(number);
          try {
            const page = await pdf.getPage(number);
            checkActive(signal);
            const base = page.getViewport({ scale: 1 });
            const width = Math.max(100, placeholder.clientWidth);
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            const scale = Math.min(width / base.width * ratio, 4096 / Math.max(base.width, base.height), Math.sqrt(3000000 / (base.width * base.height)));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', `第 ${number} 页`);
            renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
            await renderTask.promise;
            renderTask = null;
            checkActive(signal);
            placeholder.style.aspectRatio = `${base.width} / ${base.height}`;
            placeholder.replaceChildren(canvas);
            placeholder.classList.add('rendered');
            retained.set(number, canvas);
            page.cleanup();
            // 优先淘汰已经离开可见范围的页面，保留占位尺寸避免滚动跳动。
            while (retained.size > 6) {
              const victim = [...retained.keys()].find((candidate) => !near.has(candidate)) ?? retained.keys().next().value;
              release(victim);
            }
          } catch {
            if (!disposed) placeholder.textContent = `第 ${number} 页加载失败，可下载查看。`;
          }
        }
      } finally { rendering = false; }
    }

    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const number = Number(entry.target.dataset.page);
        if (entry.isIntersecting) {
          near.add(number);
          if (!retained.has(number)) queued.add(number);
        } else {
          near.delete(number);
          queued.delete(number);
        }
      }
      renderNext();
    }, { root: content, rootMargin: '300px 0px' });
    const fragment = document.createDocumentFragment();
    for (let number = 1; number <= pdf.numPages; number++) {
      const placeholder = makeElement('div', `第 ${number} / ${pdf.numPages} 页`, 'pdf-page');
      placeholder.dataset.page = String(number);
      placeholder.style.aspectRatio = `${firstSize.width} / ${firstSize.height}`;
      placeholders.set(number, placeholder);
      fragment.append(placeholder);
    }
    pages.append(fragment);
    for (const placeholder of placeholders.values()) observer.observe(placeholder);
    checkActive(signal);
    return { element: pages, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
