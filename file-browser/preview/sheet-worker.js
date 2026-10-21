/** Excel 解析放入独立 worker，关闭预览即终止，不在主线程执行重计算。 */
importScripts('../vendor/sheetjs/xlsx.full.min.js');
let workbook;
let sourceBuffer;
let sourceFormat = 'excel';
let activeEncoding;

/** CSV/TSV 全程保留字符串，避免前导零、日期与等号开头的内容被自动转换。 */
function decodeDelimited(encoding = 'auto') {
  const bytes = new Uint8Array(sourceBuffer);
  activeEncoding = encoding === 'auto'
    ? (bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8')
    : encoding;
  const text = new TextDecoder(activeEncoding).decode(bytes);
  // 空文本明确映射为零行，避免解析库将其视为一个空单元格。
  workbook = text.length === 0
    ? { SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }
    : XLSX.read(text, { type: 'string', FS: sourceFormat === 'tsv' ? '\t' : ',', raw: true, cellFormula: false, cellHTML: false });
}

self.onmessage = async (event) => {
  const { id, action, buffer, sheet, offset = 0, format = 'excel', encoding = 'auto', useHeader = false } = event.data;
  try {
    if (action === 'load') {
      sourceFormat = format;
      if (sourceFormat === 'csv' || sourceFormat === 'tsv') {
        sourceBuffer = buffer;
        decodeDelimited(encoding);
      } else {
        const { inspectOfficeZip, OFFICE_LIMITS } = await import('./office-limits.mjs');
        if (buffer.byteLength > OFFICE_LIMITS.fileBytes) throw new Error('Office 文件超过 50 MB，已停止解析。');
        // XLS 为旧版二进制；XLSX 需要在库解压之前验证中央目录。
        if (new Uint8Array(buffer)[0] === 0x50 && new Uint8Array(buffer)[1] === 0x4b) inspectOfficeZip(buffer);
        workbook = XLSX.read(buffer, { type: 'array', cellHTML: false, cellFormula: false, cellStyles: false });
      }
      self.postMessage({ id, sheets: workbook.SheetNames, encoding: activeEncoding });
      return;
    }
    if (action === 'decode') {
      decodeDelimited(encoding);
      self.postMessage({ id, sheets: workbook.SheetNames, encoding: activeEncoding });
      return;
    }
    const worksheet = workbook.Sheets[sheet];
    if (!worksheet) throw new Error('工作表不存在。');
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    const isDelimited = sourceFormat === 'csv' || sourceFormat === 'tsv';
    const allRows = worksheet['!ref'] ? range.e.r - range.s.r + 1 : 0;
    const headerOffset = isDelimited && useHeader && allRows > 0 ? 1 : 0;
    const startRow = range.s.r + offset + headerOffset;
    const total = allRows - headerOffset;
    const endColumn = Math.min(range.e.c, range.s.c + 199);
    const rows = total ? XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: isDelimited,
      defval: '',
      blankrows: true,
      range: { s: { r: startRow, c: range.s.c }, e: { r: Math.min(startRow + 199, range.e.r), c: endColumn } },
    }) : [];
    const columns = worksheet['!ref'] ? endColumn - range.s.c + 1 : 0;
    let headers;
    if (isDelimited) {
      headers = Array.from({ length: columns }, (_, index) => XLSX.utils.encode_col(range.s.c + index));
      if (headerOffset) {
        const first = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '', range: { s: range.s, e: { r: range.s.r, c: endColumn } } })[0] || [];
        headers = headers.map((fallback, index) => String(first[index] || fallback));
      }
    }
    self.postMessage({ id, rows, headers, total, startRow, columns, firstColumn: range.s.c, truncated: range.e.c > endColumn, encoding: activeEncoding });
  } catch (error) {
    self.postMessage({ id, error: error.message || '表格解析失败' });
  }
};
