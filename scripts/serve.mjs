/** 无依赖静态服务器。UI 与原始文件分路由，防止 HTML 文件在应用源中执行。 */
import http from 'node:http';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCatalogLoader, createAssetLoader, fileSignature, acceptsGzip } from './server-cache.mjs';

// 脚本位于 scripts，页面与静态资源位于其上一级项目根目录。
const toolDirectory = fileURLToPath(new URL('../', import.meta.url));
const interfaceDirectory = path.join(toolDirectory, 'file-browser');
const interfaceAssets = new Set(['styles.css', 'app.js', 'catalog-data.js', 'logo.svg', 'folder.svg']);
const compressibleExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
};

/** 使用 realpath 再次检查，阻止通过目录内的符号链接逃出根目录。 */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function createFileServer() {
  const loadCatalog = createCatalogLoader(path.join(interfaceDirectory, 'catalog-data.js'));
  const loadAsset = createAssetLoader();
  // 启动时仍检查索引，以便在缺少扫描结果时立即给出明确错误。
  await loadCatalog();
  return http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405).end('Method not allowed');
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      // 页面资源使用真实文件路径，普通静态服务器也能直接加载。
      // raw 参数仅用于本工具源码的预览和下载，避免把页面入口当作可执行页面返回。
      const assetName = url.pathname.startsWith('/file-browser/')
        ? url.pathname.slice('/file-browser/'.length)
        : null;
      const isVendorAsset = ['vendor/', 'preview/'].some((prefix) => assetName?.startsWith(prefix));
      const isInterfaceAsset = (interfaceAssets.has(assetName) || isVendorAsset) && !url.searchParams.has('raw') && !url.searchParams.has('download');
      const isPage = (url.pathname === '/' || url.pathname === '/index.html') && !url.searchParams.has('raw') && !url.searchParams.has('download');
      const isContent = !isPage && !isInterfaceAsset;
      let filename;
      if (isContent) {
        const { root, allowedFiles } = await loadCatalog();
        const relative = decodeURIComponent(url.pathname.slice(1));
        if (!allowedFiles.has(relative)) {
          response.writeHead(403).end('文件不在索引中');
          return;
        }
        filename = await realpath(path.resolve(root, relative));
        if (!isInside(root, filename)) {
          response.writeHead(403).end('禁止访问目录之外的文件');
          return;
        }
      } else {
        const asset = isInterfaceAsset ? assetName : 'index.html';
        if (asset !== 'index.html' && !interfaceAssets.has(asset) && !isVendorAsset) {
          response.writeHead(404).end('Not found');
          return;
        }
        // 页面入口位于项目根目录，其余静态资源继续集中存放。
        filename = asset === 'index.html'
          ? path.join(toolDirectory, 'index.html')
          : path.join(interfaceDirectory, asset);
        if (isVendorAsset) {
          filename = await realpath(filename);
          const assetRoot = assetName.startsWith('preview/') ? 'preview' : 'vendor';
          const vendorRoot = await realpath(path.join(interfaceDirectory, assetRoot));
          if (!isInside(vendorRoot, filename)) {
            response.writeHead(403).end('禁止访问资源目录之外的文件');
            return;
          }
        }
      }
      const information = await stat(filename);
      if (!information.isFile()) throw Object.assign(new Error('不是普通文件'), { code: 'ENOENT' });
      const extension = path.extname(filename).toLowerCase();
      const headers = {
        'Content-Type': isContent ? (mimeTypes[extension] || 'application/octet-stream') : (mimeTypes[extension] || 'text/plain'),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': isContent ? 'no-store' : 'private, no-cache',
        // 原始文件即使直接打开，也不能运行脚本或访问应用状态。
        'Content-Security-Policy': isContent
          ? (extension === '.pdf' ? "default-src 'none'; frame-ancestors 'self'" : "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:")
          : "default-src 'self'; worker-src 'self'; img-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; frame-src 'self'; style-src 'self'",
        'Accept-Ranges': 'bytes',
      };
      // 静态代码和目录数据支持条件请求；原始文件继续按需流式读取。
      if (!isContent) {
        const signature = fileSignature(information);
        const etag = `W/"${signature}"`;
        headers.ETag = etag;
        headers.Vary = 'Accept-Encoding';
        if (String(request.headers['if-none-match'] || '').split(',').some((value) => value.trim() === etag || value.trim() === '*')) {
          response.writeHead(304, headers).end();
          return;
        }
        if (!request.headers.range && information.size <= 8 * 1024 * 1024) {
          const compressed = information.size >= 1024 && compressibleExtensions.has(extension) && acceptsGzip(request.headers['accept-encoding']);
          const body = await loadAsset(filename, signature, compressed);
          if (compressed) headers['Content-Encoding'] = 'gzip';
          headers['Content-Length'] = body.length;
          response.writeHead(200, headers);
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }
      }
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`;
      let start = 0;
      let end = information.size - 1;
      let status = 200;
      // 音视频拖动播放位置及 PDF 按需读取需要支持单段 Range 请求。
      if (request.headers.range && information.size > 0) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) {
          response.writeHead(416, { 'Content-Range': `bytes */${information.size}` }).end();
          return;
        }
        if (!match[1]) start = Math.max(0, information.size - Number(match[2]));
        else start = Number(match[1]);
        if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
        if (start > end || start >= information.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${information.size}` }).end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${information.size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      response.writeHead(status, headers);
      if (request.method === 'HEAD' || information.size === 0) response.end();
      else {
        const stream = createReadStream(filename, { start, end });
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('文件无法读取，请重新扫描或检查访问权限。');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.argv[2] || 8080);
    const server = await createFileServer();
    server.on('error', (error) => { console.error(`服务启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`文件浏览器：http://127.0.0.1:${server.address().port}（Ctrl+C 停止）`));
  } catch (error) {
    console.error(`请先运行扫描脚本。${error.message}`);
    process.exitCode = 1;
  }
}
