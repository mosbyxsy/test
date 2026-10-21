/** Word/PPTX 解压、XML 解析与内容提取均在可终止的 Worker 内执行。 */
importScripts('../vendor/jszip/jszip.min.js', '../vendor/sax/sax.js');

/** 只读 XML 树；不处理实体声明，并限制节点数量和嵌套深度。 */
function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('不支持包含实体声明的文档。');
  const parser = sax.parser(true, { xmlns: true });
  const document = { children: [] };
  const stack = [document];
  let nodes = 0;
  parser.onopentag = (tag) => {
    if (++nodes > 150000 || stack.length > 100) throw new Error('文档 XML 结构过于复杂，已停止。');
    const node = { name: tag.local, children: [], values: [], attributes: Object.values(tag.attributes) };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  };
  parser.ontext = parser.oncdata = (text) => stack[stack.length - 1].values?.push(text);
  parser.onclosetag = () => stack.pop();
  parser.write(source).close();
  return document;
}

function descendants(node, name) {
  const result = [];
  function visit(parent) {
    for (const child of parent.children || []) {
      if (child.name === name) result.push(child);
      visit(child);
    }
  }
  visit(node);
  return result;
}

function attribute(node, name, namespace) {
  return node.attributes?.find((item) => item.local === name && (!namespace || item.uri === namespace))?.value || '';
}

self.onmessage = async ({ data }) => {
  const { id, buffer, format } = data;
  try {
    const { inspectOfficeZip, OFFICE_LIMITS } = await import('./office-limits.mjs');
    const inspection = inspectOfficeZip(buffer);
    const zip = await JSZip.loadAsync(buffer);
    let extracted = 0;
    let blocks = 0;
    const images = [];
    const imageCache = new Map();
    async function read(name) {
      const entry = zip.file(name);
      if (!entry || !inspection.entries.has(name)) throw new Error(`文档缺少必要内容：${name}`);
      const bytes = await entry.async('uint8array');
      extracted += bytes.byteLength;
      if (bytes.byteLength > inspection.entries.get(name) || extracted > OFFICE_LIMITS.expandedBytes) throw new Error('实际解压大小异常，已停止。');
      return bytes;
    }
    async function xml(name) { return parseXml(new TextDecoder().decode(await read(name))); }
    async function relations(part) {
      const slash = part.lastIndexOf('/');
      const name = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
      const result = new Map();
      if (!zip.file(name)) return result;
      for (const relation of descendants(await xml(name), 'Relationship')) {
        if (attribute(relation, 'TargetMode') === 'External') continue;
        const target = attribute(relation, 'Target');
        if (/^[a-z]+:|^\/\//i.test(target)) continue;
        result.set(attribute(relation, 'Id'), decodeURIComponent(new URL(target, `https://package.invalid/${part}`).pathname.slice(1)));
      }
      return result;
    }
    async function imageNodes(source, relationships) {
      const result = [];
      for (const image of descendants(source, 'blip')) {
        const filename = relationships.get(attribute(image, 'embed'));
        const extension = filename?.split('.').pop().toLowerCase();
        const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
        if (!types[extension] || !zip.file(filename)) continue;
        if (!imageCache.has(filename)) {
          const index = images.length;
          imageCache.set(filename, index);
          images.push({ type: types[extension], bytes: await read(filename) });
        }
        result.push({ kind: 'image', index: imageCache.get(filename) });
      }
      return result;
    }
    function budget() {
      if (++blocks > 20000) throw new Error('文档内容超过 20000 个展示块，请下载后打开。');
    }
    function paragraphText(source, word = false) {
      const parts = [];
      function visit(node) {
        if (node.name === 't') parts.push(node.values.join(''));
        else if (node.name === 'tab') parts.push('\t');
        else if (node.name === 'br') parts.push('\n');
        else for (const child of node.children || []) visit(child);
      }
      visit(source);
      return `${word && descendants(source, 'numPr').length ? '• ' : ''}${parts.join('')}`;
    }
    async function wordBlocks(source, relationships) {
      const result = [];
      for (const child of source.children || []) {
        budget();
        if (child.name === 'p') {
          const style = descendants(child, 'pStyle')[0];
          const heading = /^(?:Heading|标题)\s*([1-6])$/i.exec(style ? attribute(style, 'val') : '');
          result.push({ kind: heading ? `h${heading[1]}` : 'p', text: paragraphText(child, true), children: await imageNodes(child, relationships) });
        } else if (child.name === 'tbl') {
          const rows = [];
          for (const row of child.children.filter((item) => item.name === 'tr')) {
            budget();
            const cells = [];
            for (const cell of row.children.filter((item) => item.name === 'tc')) {
              budget();
              cells.push(await wordBlocks(cell, relationships));
            }
            rows.push(cells);
          }
          result.push({ kind: 'table', rows });
        } else if (['sdt', 'sdtContent'].includes(child.name)) result.push(...await wordBlocks(child, relationships));
      }
      return result;
    }
    let content;
    if (format === 'word') {
      const body = descendants(await xml('word/document.xml'), 'body')[0];
      if (!body) throw new Error('Word 正文结构缺失。');
      content = await wordBlocks(body, await relations('word/document.xml'));
    } else {
      const presentation = await xml('ppt/presentation.xml');
      const relationships = await relations('ppt/presentation.xml');
      const slides = descendants(presentation, 'sldId');
      content = [];
      if (slides.length > 500) throw new Error('幻灯片超过 500 页，请下载后打开。');
      for (const [index, slide] of slides.entries()) {
        const part = relationships.get(attribute(slide, 'id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'));
        if (!part) throw new Error('幻灯片关系缺失。');
        const document = await xml(part);
        const slideRelations = await relations(part);
        const children = [{ kind: 'h2', text: `第 ${index + 1} / ${slides.length} 页` }];
        for (const shape of descendants(document, 'spTree')[0]?.children || []) {
          budget();
          if (shape.name === 'graphicFrame') {
            for (const table of descendants(shape, 'tbl')) {
              children.push({ kind: 'table', rows: descendants(table, 'tr').map((row) => {
                budget();
                return row.children.filter((item) => item.name === 'tc').map((cell) => {
                  budget();
                  return [{ kind: 'p', text: descendants(cell, 't').map((item) => item.values.join('')).join('\n') }];
                });
              }) });
            }
          } else {
            for (const paragraph of descendants(shape, 'p')) {
              budget();
              const text = paragraphText(paragraph);
              if (text) children.push({ kind: 'p', text });
            }
          }
          children.push(...await imageNodes(shape, slideRelations));
        }
        content.push({ kind: 'slide', children });
      }
    }
    self.postMessage({ id, content, images }, [...new Set(images.map((image) => image.bytes.buffer))]);
  } catch (error) {
    self.postMessage({ id, error: error.message || '文档解析失败。' });
  }
};
