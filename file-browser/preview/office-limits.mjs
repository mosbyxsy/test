/** Office 统一资源预算，可在主线程、Worker 和测试中共用。 */
export const OFFICE_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  entryBytes: 20 * 1024 * 1024,
  xmlBytes: 16 * 1024 * 1024,
  entries: 5000,
  timeoutMs: 15000,
});

/** 解压前验证 ZIP 中央目录及预算；不支持加密、分卷或 ZIP64。 */
export function inspectOfficeZip(buffer) {
  if (buffer.byteLength > OFFICE_LIMITS.fileBytes) throw new Error('Office 文件超过 50 MB，已停止预览，请下载后打开。');
  const view = new DataView(buffer);
  let footer = -1;
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === buffer.byteLength) {
      footer = offset;
      break;
    }
  }
  if (footer < 0) throw new Error('文档不是有效的 ZIP/Office 文件，可能已损坏。');
  const count = view.getUint16(footer + 10, true);
  const size = view.getUint32(footer + 12, true);
  const start = view.getUint32(footer + 16, true);
  if (count === 65535 || size === 0xffffffff || start === 0xffffffff) throw new Error('暂不预览 ZIP64 文档，请下载后打开。');
  if (view.getUint16(footer + 4, true) || view.getUint16(footer + 6, true) || view.getUint16(footer + 8, true) !== count) throw new Error('不支持分卷 Office 文档。');
  if (count > OFFICE_LIMITS.entries) throw new Error('文档内部文件超过 5000 个，已停止解析。');
  if (start + size > footer) throw new Error('文档压缩目录已损坏。');
  let offset = start;
  let expanded = 0;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || view.getUint32(offset, true) !== 0x02014b50) throw new Error('文档压缩目录已损坏。');
    const length = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + filenameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > start + size) throw new Error('文档条目边界无效。');
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, filenameLength));
    if (view.getUint16(offset + 8, true) & 1) throw new Error('加密文档无法预览，请下载后打开。');
    if (length > OFFICE_LIMITS.entryBytes || (/\.(xml|rels)$/i.test(name) && length > OFFICE_LIMITS.xmlBytes)) throw new Error('文档包含过大的内部文件，已在解压前停止。');
    expanded += length;
    if (expanded > OFFICE_LIMITS.expandedBytes) throw new Error('文档预计解压大小超过 100 MB，已停止解析。');
    if (entries.has(name)) throw new Error('文档包含重复的内部路径。');
    entries.set(name, length);
    offset = next;
  }
  if (offset !== start + size) throw new Error('文档压缩目录长度不匹配。');
  return { entries, expandedBytes: expanded };
}
