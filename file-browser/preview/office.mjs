import { makeElement, checkActive, disposeImages } from './shared.mjs';
import { createWorkerClient } from './worker-client.mjs';

/** 主线程只构建安全 DOM；每 100 个元素让出事件循环，保持取消和滚动可响应。 */
export async function renderOffice(buffer, { signal }, format) {
  const client = createWorkerClient(new URL('./office-worker.js', import.meta.url), { signal });
  const urls = [];
  let rendered = 0;
  signal.addEventListener('abort', () => disposeImages(urls), { once: true });
  try {
    const result = await client.send({ buffer, format }, [buffer]);
    client.dispose();
    checkActive(signal);
    const imageUrls = result.images.map((image) => {
      const url = URL.createObjectURL(new Blob([image.bytes], { type: image.type }));
      urls.push(url);
      return url;
    });
    const article = makeElement('article', undefined, `document-reader ${format === 'word' ? 'word-reader' : 'slides-reader'}`);
    async function cooperate() {
      checkActive(signal);
      if (++rendered % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    async function appendBlocks(blocks, target) {
      for (const block of blocks) {
        await cooperate();
        if (block.kind === 'image') {
          const image = makeElement('img');
          image.src = imageUrls[block.index];
          image.alt = '文档内嵌图片';
          image.loading = 'lazy';
          target.append(image);
        } else if (block.kind === 'table') {
          const table = makeElement('table');
          for (const row of block.rows) {
            await cooperate();
            const tr = makeElement('tr');
            for (const cell of row) {
              await cooperate();
              const td = makeElement('td');
              await appendBlocks(cell, td);
              tr.append(td);
            }
            table.append(tr);
          }
          target.append(table);
        } else {
          const tag = /^h[1-6]$/.test(block.kind) ? block.kind : block.kind === 'slide' ? 'section' : 'p';
          const element = makeElement(tag, block.text, block.kind === 'slide' ? 'slide-page' : '');
          if (block.children) await appendBlocks(block.children, element);
          target.append(element);
        }
      }
    }
    await appendBlocks(result.content, article);
    checkActive(signal);
    if (!article.childNodes.length) article.textContent = '文档没有可读取的内容。';
    return { element: article, dispose: () => disposeImages(urls) };
  } catch (error) {
    client.dispose();
    disposeImages(urls);
    throw error;
  }
}
