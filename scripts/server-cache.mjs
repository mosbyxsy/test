/** 索引按元数据失效；静态资源采用有界缓存和按需压缩，不缓存全部扫描文件。 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

export function fileSignature(information) {
  return [information.dev, information.ino, information.size, information.mtimeNs ?? information.mtimeMs, information.ctimeNs ?? information.ctimeMs].join('-');
}

/** 同时到来的请求共享一次读取；纳秒时间戳和 inode 可识别原子替换。 */
export function createCatalogLoader(filename) {
  let cached;
  let cachedKey;
  let loading;
  let loadingKey;
  return async function loadCatalog() {
    const key = fileSignature(await stat(filename, { bigint: true }));
    if (key === cachedKey) return cached;
    if (key === loadingKey) return loading;
    loadingKey = key;
    loading = (async () => {
      const source = await readFile(filename, 'utf8');
      const catalog = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
      const root = await realpath(catalog.root);
      cached = { root, allowedFiles: new Set(catalog.nodes.filter((node) => node.type === 'file').map((node) => node.path)) };
      cachedKey = key;
      return cached;
    })();
    try { return await loading; } finally {
      if (loadingKey === key) { loadingKey = null; loading = null; }
    }
  };
}

/** 最多缓存 64 个文件、32 MB（含 gzip），共享进行中的读取和压缩操作。 */
export function createAssetLoader({ maximumEntries = 64, maximumBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let retainedBytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) retainedBytes -= entry.bytes;
    entries.delete(key);
  }
  function trim() {
    while (entries.size > maximumEntries || retainedBytes > maximumBytes) remove(entries.keys().next().value);
  }
  return async function loadAsset(filename, signature, compressed = false) {
    let entry = entries.get(filename);
    if (!entry || entry.signature !== signature) {
      remove(filename);
      entry = { signature, bytes: 0 };
      entries.set(filename, entry);
      entry.body = readFile(filename).then((body) => {
        if (entries.get(filename) === entry) {
          entry.bytes += body.length;
          retainedBytes += body.length;
          trim();
        }
        return body;
      }).catch((error) => {
        if (entries.get(filename) === entry) remove(filename);
        throw error;
      });
      trim();
    } else {
      entries.delete(filename);
      entries.set(filename, entry);
    }
    if (!compressed) return entry.body;
    entry.compressed ||= entry.body.then((body) => compress(body)).then((body) => {
      if (entries.get(filename) === entry) {
        entry.bytes += body.length;
        retainedBytes += body.length;
        trim();
      }
      return body;
    });
    return entry.compressed;
  };
}

export function acceptsGzip(header = '') {
  const encodings = new Map(String(header).split(',').map((part) => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return [name.toLowerCase(), quality ? Number(quality.trim().slice(2)) : 1];
  }));
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
}
