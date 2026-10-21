import { makeElement, checkActive } from './shared.mjs';
import { createWorkerClient } from './worker-client.mjs';

/** 工作簿只在 worker 内保存，主线程每次只接收 200 行，最多展示 200 列。 */
export async function render(buffer, { signal, format = 'excel', encoding = 'auto', onEncodingChange }) {
  const isDelimited = format === 'csv' || format === 'tsv';
  const { send, dispose } = createWorkerClient(new URL('./sheet-worker.js', import.meta.url), { signal });
  try {
    const { sheets } = await send({ action: 'load', buffer, format, encoding }, [buffer]);
    checkActive(signal);
    const element = makeElement('section', undefined, `spreadsheet-reader${isDelimited ? ' delimited-reader' : ''}`);
    const toolbar = makeElement('div', undefined, 'reader-toolbar');
    const select = makeElement('select');
    select.setAttribute('aria-label', '选择工作表');
    for (const name of sheets) {
      const option = makeElement('option', name);
      option.value = name;
      select.append(option);
    }
    const previous = makeElement('button', '上一页');
    const next = makeElement('button', '下一页');
    const status = makeElement('span');
    const tableContainer = makeElement('div', undefined, 'sheet-table-scroll');
    const encodingSelect = makeElement('select');
    encodingSelect.setAttribute('aria-label', '文本编码');
    for (const [value, label] of [['auto', '自动识别编码'], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']]) {
      const option = makeElement('option', label);
      option.value = value;
      encodingSelect.append(option);
    }
    encodingSelect.value = encoding;
    const headerLabel = makeElement('label', undefined, 'reader-header-option');
    const headerInput = makeElement('input');
    headerInput.type = 'checkbox';
    headerLabel.append(headerInput, document.createTextNode('首行为表头'));
    if (isDelimited) toolbar.append(encodingSelect, headerLabel);
    else toolbar.append(select);
    const navigation = makeElement('div', undefined, 'reader-page-actions');
    navigation.append(previous, next);
    toolbar.append(navigation, status);
    element.append(toolbar, tableContainer);
    let offset = 0;
    let pageRequest = 0;
    async function showPage() {
      const request = ++pageRequest;
      previous.disabled = next.disabled = true;
      status.textContent = '正在读取…';
      try {
        const data = await send({ action: 'page', sheet: select.value, offset, useHeader: headerInput.checked });
        if (request !== pageRequest || signal.aborted) return;
        const table = makeElement('table');
        if (data.headers) {
          const thead = makeElement('thead');
          const headingRow = makeElement('tr');
          const rowHeading = makeElement('th', '#');
          rowHeading.scope = 'col';
          headingRow.append(rowHeading);
          for (const label of data.headers) {
            const heading = makeElement('th', label);
            heading.scope = 'col';
            headingRow.append(heading);
          }
          thead.append(headingRow);
          table.append(thead);
        }
        const tbody = makeElement('tbody');
        for (const [index, row] of data.rows.entries()) {
          // 宽表也分批构建，不让 200×200 个单元格一次占满主线程。
          if (index && index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          if (request !== pageRequest || signal.aborted) return;
          const tr = makeElement('tr');
          const rowNumber = makeElement('th', String(data.startRow + index + 1));
          rowNumber.scope = 'row';
          tr.append(rowNumber);
          for (let column = 0; column < data.columns; column++) tr.append(makeElement('td', String(row[column] ?? '')));
          tbody.append(tr);
        }
        table.append(tbody);
        if (request !== pageRequest || signal.aborted) return;
        tableContainer.replaceChildren(table);
        tableContainer.scrollTop = tableContainer.scrollLeft = 0;
        status.textContent = `第 ${Math.floor(offset / 200) + 1} / ${Math.max(1, Math.ceil(data.total / 200))} 页 · ${data.total} 行${data.encoding ? ` · ${data.encoding.toUpperCase()}` : ''}${data.truncated ? ' · 仅显示前 200 列' : ''}`;
        previous.disabled = offset === 0;
        next.disabled = offset + 200 >= data.total;
      } catch (error) {
        if (!signal.aborted) status.textContent = error.message;
      }
    }
    select.addEventListener('change', () => { offset = 0; showPage(); });
    headerInput.addEventListener('change', () => { offset = 0; showPage(); });
    encodingSelect.addEventListener('change', async () => {
      const request = ++pageRequest;
      previous.disabled = next.disabled = true;
      encodingSelect.disabled = headerInput.disabled = true;
      status.textContent = '正在重新解码…';
      try {
        const result = await send({ action: 'decode', encoding: encodingSelect.value });
        if (request !== pageRequest || signal.aborted) return;
        select.value = result.sheets[0];
        onEncodingChange?.(encodingSelect.value);
        offset = 0;
        await showPage();
      } catch (error) {
        if (!signal.aborted && request === pageRequest) status.textContent = error.message;
      } finally {
        if (!signal.aborted) encodingSelect.disabled = headerInput.disabled = false;
      }
    });
    previous.addEventListener('click', () => { offset = Math.max(0, offset - 200); showPage(); });
    next.addEventListener('click', () => { offset += 200; showPage(); });
    if (sheets.length) await showPage();
    else status.textContent = '工作簿没有工作表。';
    return { element, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
