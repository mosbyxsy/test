/** 目录扫描入口：正文不进入索引，避免大文件撑大页面首次加载的数据。 */
import { lstat, readdir, readlink, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseIgnoreRules, isIgnored } from './scan-ignore.mjs';

// 资源始终定位到项目根目录，与执行命令时的工作目录无关。
export const toolDirectory = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(toolDirectory, 'file-browser');

/**
 * 扫描目录，返回按相对路径关联的扁平索引。
 * @param {string} rootDirectory 扫描根目录。
 * @returns {Promise<object>} 包含节点、根目录及扫描错误的数据。
 */
export async function scanDirectory(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const nodes = [];
  const errors = [];
  const collator = new Intl.Collator('zh-CN');

  async function visit(absolutePath, parentPath = null, inheritedRules = []) {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    let node;
    try {
      const information = await lstat(absolutePath);
      // Git 元数据目录由扫描器直接跳过，不依赖项目忽略配置，也不受 ! 规则恢复。
      // 仅过滤后代目录；名为 .git 的普通文件（如 worktree 标记）仍可正常记录。
      if (relativePath && information.isDirectory() && path.basename(absolutePath) === '.git') return null;
      if (relativePath && isIgnored(relativePath, information.isDirectory(), inheritedRules)) return null;
      node = {
        path: relativePath,
        parentPath,
        name: relativePath ? path.basename(absolutePath) : path.basename(root),
        type: information.isSymbolicLink() ? 'link' : information.isDirectory() ? 'directory' : 'file',
        size: information.isFile() ? information.size : 0,
        modifiedAt: information.mtime.toISOString(),
        // 文件系统不提供有效创建时间时留空，不以修改时间冒充。
        createdAt: information.birthtimeMs > 0 ? information.birthtime.toISOString() : null,
        fileCount: 0,
        directoryCount: 0,
      };
      nodes.push(node);
      // 不跟随链接：避免循环，也避免把扫描根目录以外的文件带入索引。
      if (node.type === 'link') node.target = await readlink(absolutePath);
      if (node.type === 'directory') {
        let rules = inheritedRules;
        const ignorePath = path.join(absolutePath, '.gitignore');
        try {
          // 不跟随配置文件链接，避免从扫描范围之外读取配置。
          const ignoreInformation = await lstat(ignorePath);
          if (ignoreInformation.isFile()) {
            rules = inheritedRules.concat(parseIgnoreRules(await readFile(ignorePath, 'utf8'), relativePath));
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            errors.push({ path: relativePath ? `${relativePath}/.gitignore` : '.gitignore', message: `${error.code || 'ERROR'}：忽略配置读取失败，继续使用父目录规则：${error.message}` });
          }
        }
        const entries = await readdir(absolutePath);
        entries.sort(collator.compare);
        for (const name of entries) {
          const childPath = path.join(absolutePath, name);
          const child = await visit(childPath, relativePath, rules);
          if (!child) continue;
          node.size += child.size;
          node.fileCount += child.type === 'file' ? 1 : child.fileCount;
          node.directoryCount += child.type === 'directory' ? child.directoryCount + 1 : 0;
        }
      }
    } catch (error) {
      const message = `${error.code || 'ERROR'}：${error.message}`;
      errors.push({ path: relativePath, message });
      if (node) node.error = message;
      else {
        node = { path: relativePath, parentPath, name: path.basename(absolutePath), type: 'unavailable', size: 0, fileCount: 0, directoryCount: 0, error: message };
        nodes.push(node);
      }
    }
    return node;
  }

  const rootInformation = await lstat(root);
  if (!rootInformation.isDirectory()) throw new Error('扫描目标必须是目录');
  await visit(root);
  return { version: 1, root, generatedAt: new Date().toISOString(), nodes, errors };
}

/** 同目录写入后原子替换，避免浏览器或服务读取到半份索引。 */
export async function writeCatalogData(catalog, filename = path.join(outputDirectory, 'catalog-data.js')) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const serialized = JSON.stringify(catalog).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  try {
    await writeFile(temporary, `window.FILE_CATALOG = ${serialized};\n`, 'utf8');
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const catalog = await scanDirectory(process.argv[2] || process.cwd());
    await writeCatalogData(catalog);
    const rootNode = catalog.nodes[0];
    console.log(`扫描完成：${rootNode.directoryCount} 个目录，${rootNode.fileCount} 个文件，${rootNode.size} 字节，${catalog.errors.length} 个错误。`);
    for (const error of catalog.errors) console.warn(`${error.path || '/'}：${error.message}`);
  } catch (error) {
    console.error(`扫描失败：${error.message}`);
    process.exitCode = 1;
  }
}
