/**
 * 浏览器入口：一次建立目录索引，按需渲染列表；预览模块独立懒加载。
 * 文件名使用 textContent；Markdown 由独立模块清理后展示。
 */
(() => {
  'use strict';

  const catalog = window.FILE_CATALOG;
  const elementCache = new Map();
  const getElement = (id) => {
    if (!elementCache.has(id)) elementCache.set(id, document.getElementById(id));
    return elementCache.get(id);
  };
  if (!catalog || !Array.isArray(catalog.nodes)) {
    getElement('empty-message').hidden = false;
    getElement('empty-message').textContent = '目录数据未加载，请先运行 node scripts/scan.mjs，再通过本地服务打开页面。';
    return;
  }

  const nodeByPath = new Map(catalog.nodes.map((node) => [node.path, node]));
  const childrenByPath = new Map();
  const directoriesByPath = new Map();
  const directSummaries = new Map();
  const searchableNames = new WeakMap();
  for (const node of catalog.nodes) {
    searchableNames.set(node, node.name.toLowerCase());
    if (node.parentPath === null) continue;
    if (!childrenByPath.has(node.parentPath)) childrenByPath.set(node.parentPath, []);
    childrenByPath.get(node.parentPath).push(node);
    if (!directSummaries.has(node.parentPath)) directSummaries.set(node.parentPath, { folders: 0, files: 0, size: 0 });
    const summary = directSummaries.get(node.parentPath);
    if (node.type === 'directory') {
      summary.folders++;
      if (!directoriesByPath.has(node.parentPath)) directoriesByPath.set(node.parentPath, []);
      directoriesByPath.get(node.parentPath).push(node);
    } else if (node.type === 'file') {
      summary.files++;
      summary.size += node.size;
    }
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
  const categoryCache = new WeakMap();
  const viewCache = new Map();
  const rowByPath = new Map();
  const treeLimits = new Map();
  let visibleRows = 200;
  let selectedRow = null;
  let searchTimer;
  let composingSearch = false;
  const state = { directory: '', search: '', filter: 'all', sort: 'name', direction: 1, selected: null };
  const directoryResizer = getElement('directory-resizer');
  const directorySidebar = document.querySelector('.directory-sidebar');
  const workspaceElement = document.querySelector('.workspace');
  let preferredDirectoryWidth = null;
  const mobileDirectoryDialog = getElement('mobile-directory-dialog');
  const mobileViewport = window.matchMedia('(max-width: 650px)');

  /** 同一目录树在手机抽屉与桌面侧栏之间移动，保持展开状态与事件不丢失。 */
  function updateDirectoryPlacement() {
    mobileDirectoryDialog.close();
    if (mobileViewport.matches) {
      getElement('mobile-directory-content').append(directorySidebar);
    } else {
      workspaceElement.insertBefore(directorySidebar, directoryResizer);
      if (preferredDirectoryWidth !== null) setDirectoryWidth(preferredDirectoryWidth, false);
    }
  }
  getElement('open-mobile-directory').addEventListener('click', () => mobileDirectoryDialog.showModal());
  getElement('close-mobile-directory').addEventListener('click', () => mobileDirectoryDialog.close());
  mobileDirectoryDialog.addEventListener('click', (event) => {
    const bounds = mobileDirectoryDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) mobileDirectoryDialog.close();
  });
  mobileViewport.addEventListener('change', updateDirectoryPlacement);
  updateDirectoryPlacement();

  /** 保留列表至少 240px，避免目录树在狭窄视口中挤占全部可用宽度。 */
  function getDirectoryWidthLimit() {
    return Math.max(120, Math.min(480, workspaceElement.clientWidth - 240));
  }

  function setDirectoryWidth(width, remember = true) {
    const maximum = getDirectoryWidthLimit();
    const constrained = Math.round(Math.min(maximum, Math.max(120, width)));
    if (remember) preferredDirectoryWidth = constrained;
    document.body.style.setProperty('--directory-width', `${constrained}px`);
    document.body.classList.add('directory-width-custom');
    directoryResizer.setAttribute('aria-valuemax', String(maximum));
    directoryResizer.setAttribute('aria-valuenow', String(constrained));
  }

  let resizePointer = null;
  let resizeFrame = null;
  let pendingDirectoryWidth = null;
  let directoryLeft = 0;
  function applyDirectoryResize() {
    resizeFrame = null;
    if (pendingDirectoryWidth !== null) {
      setDirectoryWidth(pendingDirectoryWidth);
      pendingDirectoryWidth = null;
    }
  }
  directoryResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || resizePointer !== null) return;
    event.preventDefault();
    resizePointer = event.pointerId;
    directoryLeft = directorySidebar.getBoundingClientRect().left;
    directoryResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-directory');
  });
  directoryResizer.addEventListener('pointermove', (event) => {
    if (event.pointerId !== resizePointer) return;
    pendingDirectoryWidth = event.clientX - directoryLeft;
    if (resizeFrame === null) resizeFrame = requestAnimationFrame(applyDirectoryResize);
  });
  function finishDirectoryResize(event) {
    if (event.pointerId !== resizePointer) return;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    applyDirectoryResize();
    resizePointer = null;
    document.body.classList.remove('resizing-directory');
    if (directoryResizer.hasPointerCapture(event.pointerId)) directoryResizer.releasePointerCapture(event.pointerId);
  }
  directoryResizer.addEventListener('pointerup', finishDirectoryResize);
  directoryResizer.addEventListener('pointercancel', finishDirectoryResize);
  directoryResizer.addEventListener('lostpointercapture', finishDirectoryResize);
  directoryResizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = directorySidebar.getBoundingClientRect().width;
    const target = event.key === 'Home' ? 120 : event.key === 'End' ? getDirectoryWidthLimit() : current + (event.key === 'ArrowRight' ? 10 : -10);
    setDirectoryWidth(target);
  });
  // 预览开关或窗口尺寸变化后，重新约束已有宽度并同步辅助技术读数。
  new ResizeObserver(() => {
    if (mobileViewport.matches) return;
    const current = directorySidebar.getBoundingClientRect().width;
    if (preferredDirectoryWidth !== null) setDirectoryWidth(preferredDirectoryWidth, false);
    else {
      directoryResizer.setAttribute('aria-valuemax', String(getDirectoryWidthLimit()));
      directoryResizer.setAttribute('aria-valuenow', String(Math.round(current)));
    }
  }).observe(workspaceElement);
  const expandedDirectories = new Set(['']);
  let previewRequest = 0;
  let previewController;
  let feedbackTimer;
  let documentPreviewDispose = null;
  let delimitedEncoding = 'auto';
  const previewModules = new Map();
  let moduleRetry = 0;
  let readerStylesPromise;

  /** 文档专用样式同样按需加载，列表首屏不承担文档阅读器的样式体积。 */
  function loadReaderStyles() {
    readerStylesPromise ||= new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL('./file-browser/preview/readers.css', window.location.href).href;
      link.onload = resolve;
      link.onerror = () => {
        link.remove();
        readerStylesPromise = null;
        reject(new Error('文档样式加载失败，请重试。'));
      };
      document.head.append(link);
    });
    return readerStylesPromise;
  }

  /** import 仅在点击对应格式后执行，成功后复用模块；失败移除缓存允许重试。 */
  function loadPreviewModule(category) {
    if (!previewModules.has(category)) {
      const files = { markdown: 'markdown.mjs', word: 'word.mjs', sheet: 'sheet.mjs', delimited: 'sheet.mjs', slides: 'slides.mjs', pdf: 'pdf.mjs' };
      const url = new URL(`./file-browser/preview/${files[category]}`, window.location.href);
      if (moduleRetry) url.searchParams.set('retry', String(moduleRetry));
      const promise = Promise.all([import(url.href), loadReaderStyles()]).then(([module]) => module).catch((error) => {
        previewModules.delete(category);
        moduleRetry++;
        throw new Error(`预览组件加载失败，请检查本地资源后重试。${error.message}`);
      });
      previewModules.set(category, promise);
    }
    return previewModules.get(category);
  }

  function disposeDocumentPreview() {
    documentPreviewDispose?.();
    documentPreviewDispose = null;
    for (const media of getElement('preview-content').querySelectorAll('audio, video')) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
  }
  // 弹窗可独立于预览打开，单独保存其目标，避免复制到其他文件的地址。
  let detailsNode = null;
  const textExtensions = new Set('txt md markdown js mjs cjs ts tsx jsx json jsonc css scss sass less html htm xml yaml yml toml ini conf config log csv tsv sql sh bash ps1 bat cmd py rb php java c cpp h hpp cs go rs vue svelte env gitignore dockerfile svg'.split(' '));
  const extensionGroups = {
    delimited: new Set(['csv', 'tsv']),
    markdown: new Set(['md', 'markdown']),
    word: new Set(['docx']),
    sheet: new Set(['xlsx', 'xls']),
    slides: new Set(['pptx']),
    image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']),
    audio: new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']),
    video: new Set(['mp4', 'webm', 'ogv', 'mov']),
    pdf: new Set(['pdf']),
  };

  /** 根据扩展名判断能力；SVG 使用 img 隔离渲染，不插入页面 DOM。 */
  function getCategory(node) {
    if (node.type !== 'file') return node.type;
    if (categoryCache.has(node)) return categoryCache.get(node);
    const extension = node.name.split('.').pop().toLowerCase();
    for (const [category, extensions] of Object.entries(extensionGroups)) {
      if (extensions.has(extension)) {
        categoryCache.set(node, category);
        return category;
      }
    }
    const category = textExtensions.has(extension) || ['LICENSE', 'Makefile', 'Dockerfile', '.gitignore', '.env'].includes(node.name) ? 'text' : 'other';
    categoryCache.set(node, category);
    return category;
  }

  const categoryNames = { directory: '文件夹', text: '文本 / 代码', delimited: 'CSV / TSV', markdown: 'Markdown', word: 'Word', sheet: 'Excel', slides: 'PowerPoint', image: '图片', audio: '音频', video: '视频', pdf: 'PDF', other: '其他格式', link: '符号链接', unavailable: '无法访问' };

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
  }

  function formatDate(value) {
    return value && Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)) : '—';
  }

  /** 逐段编码，保留目录分隔符，同时正确处理 #、?、中文等字符。 */
  function contentUrl(node) {
    // 相对于页面所在目录解析，兼容项目挂载在静态服务子路径的情况。
    return new URL(`./${node.path.split('/').map(encodeURIComponent).join('/')}`, window.location.href).href;
  }

  function createButton(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className;
    if (action) button.addEventListener('click', action);
    return button;
  }

  /** 使用短提示反馈操作结果，不改变目录浏览或文件预览状态。 */
  function showActionFeedback(message) {
    const feedback = getElement('action-feedback');
    clearTimeout(feedbackTimer);
    feedback.textContent = message;
    feedback.hidden = false;
    feedbackTimer = setTimeout(() => {
      feedback.hidden = true;
    }, 3000);
  }

  /**
   * 复制完整访问地址，自动沿用当前页面的协议、域名和端口。
   * 旧浏览器使用临时文本框降级，失败时明确提示，不误报成功。
   */
  async function copyFilePath(node) {
    const absoluteUrl = new URL(contentUrl(node), window.location.origin).href;
    await copyText(absoluteUrl, `已复制访问地址：${absoluteUrl}`);
  }

  /** 路径和名称共用剪贴板逻辑，复制内容不受界面省略显示影响。 */
  async function copyText(value, successMessage) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const previousFocus = document.activeElement;
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.className = 'clipboard-fallback';
        document.body.append(textarea);
        try {
          textarea.select();
          if (!document.execCommand('copy')) throw new Error('复制不可用');
        } finally {
          textarea.remove();
          previousFocus?.focus();
        }
      }
      showActionFeedback(successMessage);
    } catch {
      showActionFeedback('复制失败，请检查浏览器剪贴板权限。');
    }
  }

  /** 普通文件才提供下载，链接与不可访问节点不生成无效下载入口。 */
  function createFileActions(node) {
    const cell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const copyButton = createButton('路径', null, 'file-action');
    copyButton.dataset.action = 'copy-path';
    copyButton.title = `复制访问地址：${new URL(contentUrl(node), window.location.origin).href}`;
    copyButton.setAttribute('aria-label', `复制 ${node.name} 的完整访问地址`);
    actions.append(copyButton);
    const detailsButton = createButton('详情', null, 'file-action');
    detailsButton.dataset.action = 'details';
    detailsButton.setAttribute('aria-label', `查看 ${node.name} 的详情`);
    actions.append(detailsButton);
    if (node.type === 'file') {
      const download = document.createElement('a');
      download.className = 'file-action';
      download.textContent = '下载';
      download.href = `${contentUrl(node)}?download=1`;
      download.download = node.name;
      download.setAttribute('aria-label', `下载 ${node.name}`);
      actions.append(download);
    }
    cell.append(actions);
    return cell;
  }

  function navigateTo(relativePath) {
    clearTimeout(searchTimer);
    mobileDirectoryDialog.close();
    // 地址中的路径属于外部输入，只恢复索引里确实存在的目录。
    const destination = nodeByPath.get(relativePath);
    state.directory = destination?.type === 'directory' ? relativePath : '';
    const pageUrl = new URL(window.location.href);
    if (state.directory) pageUrl.searchParams.set('dir', state.directory);
    else pageUrl.searchParams.delete('dir');
    // 仅更新当前历史记录，避免每次进入目录产生大量后退记录。
    window.history.replaceState(null, '', pageUrl);
    state.search = '';
    getElement('search').value = '';
    let current = nodeByPath.get(state.directory);
    while (current) {
      expandedDirectories.add(current.path);
      // 从搜索结果进入较深目录时，确保当前目录不落在“更多目录”之后。
      const siblings = directoriesByPath.get(current.parentPath) || [];
      const position = siblings.indexOf(current);
      if (position >= 100) treeLimits.set(current.parentPath, Math.max(treeLimits.get(current.parentPath) || 100, Math.ceil((position + 1) / 100) * 100));
      current = nodeByPath.get(current.parentPath);
    }
    renderDirectory();
    renderTree();
  }

  /** 仅为已展开的分支创建 DOM，避免大目录初次加载生成大量元素。 */
  function renderTree() {
    const tree = getElement('directory-tree');
    tree.replaceChildren();
    function appendDirectory(node, container) {
      const row = document.createElement('div');
      row.className = `tree-row${state.directory === node.path ? ' active' : ''}`;
      const directories = directoriesByPath.get(node.path) || [];
      const expanded = expandedDirectories.has(node.path);
      const toggle = createButton('', () => {
        if (expanded) expandedDirectories.delete(node.path);
        else expandedDirectories.add(node.path);
        renderTree();
      }, 'tree-toggle');
      toggle.disabled = directories.length === 0;
      toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${node.name}`);
      toggle.setAttribute('aria-expanded', String(expanded));
      const name = createButton('', () => navigateTo(node.path), 'tree-name');
      const folderIcon = document.createElement('span');
      folderIcon.className = 'tree-folder-icon';
      folderIcon.setAttribute('aria-hidden', 'true');
      const folderLabel = document.createElement('span');
      folderLabel.className = 'tree-label';
      folderLabel.textContent = node.name;
      name.append(folderIcon, folderLabel);
      name.title = node.path || node.name;
      if (state.directory === node.path) name.setAttribute('aria-current', 'location');
      row.append(toggle, name);
      container.append(row);
      if (expanded && directories.length) {
        const children = document.createElement('div');
        children.className = 'tree-children';
        const limit = treeLimits.get(node.path) || 100;
        for (const child of directories.slice(0, limit)) appendDirectory(child, children);
        if (directories.length > limit) {
          children.append(createButton(`更多目录（剩余 ${directories.length - limit}）`, () => {
            treeLimits.set(node.path, limit + 100);
            renderTree();
          }, 'tree-more'));
        }
        container.append(children);
      }
    }
    appendDirectory(catalog.nodes[0], tree);
  }

  function renderBreadcrumbs() {
    const breadcrumbs = getElement('breadcrumbs');
    breadcrumbs.replaceChildren();
    const ancestors = [];
    let current = nodeByPath.get(state.directory);
    while (current) {
      ancestors.unshift(current);
      current = nodeByPath.get(current.parentPath);
    }
    for (const [index, node] of ancestors.entries()) {
      if (index) breadcrumbs.append(document.createTextNode('/'));
      breadcrumbs.append(createButton(node.name, () => navigateTo(node.path)));
    }
  }

  /** 视图结果以排序/筛选条件缓存，最多保留 8 份，避免搜索无限占用内存。 */
  function getDirectoryEntries() {
    const key = JSON.stringify([state.directory, state.search, state.filter, state.sort, state.direction]);
    if (viewCache.has(key)) return viewCache.get(key);
    const query = state.search.toLowerCase();
    let entries = query
      ? catalog.nodes.filter((node) => node.path && searchableNames.get(node).includes(query))
      : [...(childrenByPath.get(state.directory) || [])];
    if (state.filter !== 'all') entries = entries.filter((node) => getCategory(node) === state.filter);
    entries.sort((left, right) => {
      if ((left.type === 'directory') !== (right.type === 'directory')) return left.type === 'directory' ? -1 : 1;
      const comparison = state.sort === 'size' ? left.size - right.size : collator.compare(String(left[state.sort] || ''), String(right[state.sort] || ''));
      return comparison * state.direction;
    });
    if (viewCache.size >= 8) viewCache.delete(viewCache.keys().next().value);
    viewCache.set(key, entries);
    return entries;
  }

  /** 选中文件只更新两行样式，不再排序或重建全部文件节点。 */
  function updateSelectedRow() {
    selectedRow?.classList.remove('selected');
    selectedRow = rowByPath.get(state.selected) || null;
    selectedRow?.classList.add('selected');
  }

  function renderDirectory(append = false) {
    const directory = nodeByPath.get(state.directory);
    // 统计仅针对当前目录的直接子项，不受搜索、筛选影响，也不累加子目录内容。
    const direct = directSummaries.get(state.directory) || { folders: 0, files: 0, size: 0 };
    const summary = getElement('catalog-summary');
    const directSummary = document.createElement('span');
    directSummary.textContent = `直接子项：${direct.folders} 个文件夹 · ${direct.files} 个文件 · ${formatSize(direct.size)}`;
    const recursiveSummary = document.createElement('span');
    recursiveSummary.textContent = `全部后代：${directory.directoryCount} 个文件夹 · ${directory.fileCount} 个文件 · ${formatSize(directory.size)}`;
    summary.replaceChildren(directSummary, recursiveSummary);
    // 搜索和筛选不改变目录统计；符号链接不计入文件数、目录数和大小。
    summary.title = `当前目录：${directory.path || '/'}。直接子项大小仅合计当前层文件；全部后代包含各级子目录中的文件。`;
    renderBreadcrumbs();
    getElement('directory-title').textContent = state.search ? '搜索结果' : directory.name;
    getElement('parent-directory').disabled = state.directory === '';
    const entries = getDirectoryEntries();
    getElement('item-count').textContent = `${entries.length} 个项目${state.search ? ' · 全目录搜索' : ''}`;
    const list = getElement('file-list');
    const start = append ? visibleRows : 0;
    visibleRows = append ? visibleRows + 200 : 200;
    if (!append) {
      rowByPath.clear();
      selectedRow = null;
      document.querySelector('.file-panel').scrollTop = 0;
    }
    const fragment = document.createDocumentFragment();
    for (const node of entries.slice(start, visibleRows)) {
      const category = getCategory(node);
      const row = document.createElement('tr');
      row.dataset.path = node.path;
      rowByPath.set(node.path, row);
      if (node.path === state.selected) row.classList.add('selected');
      const nameCell = document.createElement('td');
      const nameRow = document.createElement('div');
      nameRow.className = 'file-name-row';
      const button = createButton('', null, 'file-name');
      button.dataset.action = 'open';
      button.title = node.name;
      const icon = document.createElement('span');
      icon.className = `file-icon ${category}`;
      icon.textContent = node.type === 'directory' ? '' : node.name.split('.').pop().slice(0, 4).toUpperCase();
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'file-label';
      label.textContent = node.name;
      button.append(icon, label);
      // 复制按钮与打开按钮并列，避免嵌套按钮及误触打开文件。
      const copyName = createButton('', null, 'copy-name-button');
      copyName.dataset.action = 'copy-name';
      copyName.title = '复制名称';
      copyName.setAttribute('aria-label', `复制名称：${node.name}`);
      nameRow.append(button, copyName);
      nameCell.append(nameRow);
      if (state.search) {
        const location = document.createElement('small');
        location.className = 'search-path';
        location.textContent = node.parentPath || '/';
        nameCell.append(location);
      }
      row.append(nameCell);
      for (const value of [categoryNames[category], formatSize(node.size), formatDate(node.modifiedAt)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      row.append(createFileActions(node));
      fragment.append(row);
    }
    if (append) list.append(fragment);
    else list.replaceChildren(fragment);
    updateSelectedRow();
    const more = getElement('load-more-files');
    more.hidden = entries.length <= visibleRows;
    more.textContent = `加载更多（剩余 ${Math.max(0, entries.length - visibleRows)} 项）`;
    const message = getElement('empty-message');
    message.hidden = entries.length > 0;
    message.textContent = directory.error || (state.search || state.filter !== 'all' ? '没有符合条件的项目' : '这个文件夹是空的');
    for (const button of document.querySelectorAll('[data-sort]')) {
      button.parentElement.setAttribute('aria-sort', button.dataset.sort === state.sort ? (state.direction === 1 ? 'ascending' : 'descending') : 'none');
    }
  }

  /** 详情使用语义化定义列表；旧索引缺少创建时间时显示明确的占位提示。 */
  function renderFileDetails(node, category) {
    const extensionIndex = node.name.lastIndexOf('.');
    const extension = node.type === 'file' && extensionIndex > 0 && extensionIndex < node.name.length - 1
      ? node.name.slice(extensionIndex)
      : '无扩展名';
    const entries = [
      ['文件名', node.name],
      ['文件类型', categoryNames[category]],
      ['扩展名', extension],
      ['精确大小', `${node.size.toLocaleString('zh-CN')} 字节`],
      ['创建时间', node.createdAt ? formatDate(node.createdAt) : '未提供（可重新扫描）'],
      ['修改时间', formatDate(node.modifiedAt)],
      ['所在目录', node.parentPath || '/（扫描根目录）'],
      ['相对路径', node.path],
    ];
    if (node.type === 'link') entries.push(['链接目标', node.target || '未知']);
    if (node.error) entries.push(['读取错误', node.error]);
    const fragment = document.createDocumentFragment();
    for (const [label, value] of entries) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      fragment.append(term, description);
    }
    getElement('preview-file-details').replaceChildren(fragment);
  }

  /** 列表与预览共用详情入口，不切换目录、不打开预览或读取文件正文。 */
  function openFileDetails(node) {
    detailsNode = node;
    renderFileDetails(node, getCategory(node));
    getElement('preview-path').textContent = contentUrl(node);
    getElement('file-details-dialog').showModal();
  }

  function showPreviewMessage(message, action, actionLabel = '继续加载文件') {
    const content = getElement('preview-content');
    const paragraph = document.createElement('div');
    paragraph.className = 'preview-message';
    paragraph.textContent = message;
    if (action) paragraph.append(createButton(actionLabel, action));
    content.replaceChildren(paragraph);
  }

  /** 即使扫描后文件变大，也在读取过程中强制限制，超过上限立即取消响应流。 */
  async function readDocumentBuffer(response, signal, maximum) {
    if (Number(response.headers.get('Content-Length')) > maximum) {
      await response.body?.cancel();
      throw new Error('Office 文件超过 50 MB，已停止读取，请下载后打开。');
    }
    if (!response.body?.getReader) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maximum) throw new Error('Office 文件超过 50 MB，已停止解析。');
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) {
          await reader.cancel();
          throw new Error('Office 文件超过 50 MB，已停止读取，请下载后打开。');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes.buffer;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 每次选择递增请求序号并取消上次 fetch，防止快速切换后旧内容覆盖新内容。
   * 大文本仅在主动点击后读取；未知格式始终保留下载入口。
   */
  async function openPreview(node, allowLargeText = false, showSvgSource = false) {
    const request = ++previewRequest;
    disposeDocumentPreview();
    getElement('preview-content').classList.remove('mobile-pdf');
    previewController?.abort();
    previewController = new AbortController();
    if (state.selected !== node.path) delimitedEncoding = 'auto';
    state.selected = node.path;
    updateSelectedRow();
    const panel = getElement('preview-panel');
    panel.hidden = false;
    document.body.classList.add('preview-open');
    // 切换文件后从顶部阅读，不沿用上一个文件的内容与信息区滚动位置。
    getElement('preview-content').scrollTop = 0;
    getElement('preview-content').scrollLeft = 0;
    document.querySelector('.preview-information').scrollTop = 0;
    // 切换文件时关闭旧详情，避免弹窗与当前内容不一致。
    getElement('file-details-dialog').close();
    getElement('preview-name').textContent = node.name;
    const isSvg = node.type === 'file' && node.name.toLowerCase().endsWith('.svg');
    const isMarkdown = node.type === 'file' && /\.(md|markdown)$/i.test(node.name);
    const isDelimited = node.type === 'file' && /\.(csv|tsv)$/i.test(node.name);
    const isJson = node.type === 'file' && /\.json$/i.test(node.name);
    const formatJsonButton = getElement('format-json');
    // 每次切换清除旧文件的处理函数，读取完成后再允许格式化，不额外请求正文。
    formatJsonButton.hidden = !isJson;
    formatJsonButton.disabled = true;
    formatJsonButton.textContent = '格式化';
    formatJsonButton.setAttribute('aria-pressed', 'false');
    formatJsonButton.onclick = null;
    const category = (isSvg || isMarkdown || isDelimited) && showSvgSource ? 'text' : getCategory(node);
    const isOffice = ['word', 'sheet', 'slides'].includes(category);
    const sourceButton = getElement('toggle-svg-source');
    sourceButton.hidden = !isSvg && !isMarkdown && !isDelimited;
    sourceButton.textContent = showSvgSource ? (isDelimited ? '表格模式' : isMarkdown ? '阅读模式' : '查看图片') : '查看源码';
    sourceButton.setAttribute('aria-pressed', String(showSvgSource));
    getElement('preview-metadata').textContent = `${categoryNames[category]} · ${formatSize(node.size)}`;
    renderFileDetails(node, category);
    getElement('preview-modified').textContent = formatDate(node.modifiedAt);
    if (node.modifiedAt) getElement('preview-modified').dateTime = node.modifiedAt;
    else getElement('preview-modified').removeAttribute('datetime');
    getElement('preview-path').textContent = contentUrl(node);
    getElement('preview-file-icon').textContent = node.name.includes('.') ? node.name.split('.').pop().slice(0, 5).toUpperCase() : 'FILE';
    getElement('preview-file-icon').dataset.category = category;
    getElement('preview-content').dataset.category = category;
    getElement('preview-mode').textContent = category === 'text' ? '文本阅读' : `${categoryNames[category]}预览`;
    const download = getElement('download-file');
    download.hidden = node.type !== 'file';
    download.href = `${contentUrl(node)}?download=1`;
    download.download = node.name;
    if (node.type !== 'file') {
      showPreviewMessage(node.error || `符号链接不跟随、不预览。目标：${node.target || '未知'}`);
      return;
    }
    if (category === 'other') {
      showPreviewMessage('此格式暂不支持内容预览，请下载后使用本地应用打开。旧版 DOC、PPT 暂不解析。');
      return;
    }
    if (['text', 'markdown', 'delimited'].includes(category) && node.size > 5 * 1024 * 1024 && !allowLargeText) {
      showPreviewMessage(`该文本为 ${formatSize(node.size)}，加载可能需要一些时间。`, () => openPreview(node, true, showSvgSource));
      return;
    }
    if (isOffice && node.size > 50 * 1024 * 1024) {
      showPreviewMessage('该 Office 文件超过 50 MB，已停止预览，请使用上方下载按钮。');
      return;
    }
    if (isOffice && node.size > 20 * 1024 * 1024 && !allowLargeText) {
      showPreviewMessage(`该文档为 ${formatSize(node.size)}，解析可能占用较多内存，是否继续？`, () => openPreview(node, true));
      return;
    }
    showPreviewMessage('正在加载…');
    try {
      const previewUrl = new URL(contentUrl(node));
      // 普通静态服务忽略此查询参数；内置服务用它区分源码预览与页面入口。
      previewUrl.searchParams.set('raw', '1');
      const url = previewUrl.href;
      if (['markdown', 'word', 'sheet', 'slides', 'delimited'].includes(category)) {
        const controller = previewController;
        const signal = controller.signal;
        const cancel = () => {
          if (request !== previewRequest) return;
          controller.abort();
          showPreviewMessage('已取消解析。你可以重试或下载后打开。', () => openPreview(node, allowLargeText, showSvgSource), '重试');
        };
        showPreviewMessage('正在加载预览组件…', cancel, '取消解析');
        const module = await loadPreviewModule(category);
        if (request !== previewRequest) return;
        if (signal.aborted) return;
        showPreviewMessage('正在读取和解析文件…', cancel, '取消解析');
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`文件读取失败（HTTP ${response.status}），请重新扫描并刷新页面。`);
        const buffer = isOffice
          ? await readDocumentBuffer(response, signal, 50 * 1024 * 1024)
          : await response.arrayBuffer();
        if (request !== previewRequest) return;
        // Worker 本身也有超时；外层预算同时覆盖 Word/PPTX 的分批 DOM 构建。
        const timeout = isOffice ? setTimeout(() => {
          controller.abort(new Error('解析超过 15 秒，已自动停止，请下载后打开或重试。'));
        }, 15000) : null;
        let result;
        try {
          result = await module.render(buffer, {
            url,
            signal,
            format: isDelimited ? node.name.split('.').pop().toLowerCase() : 'excel',
            encoding: delimitedEncoding,
            onEncodingChange: (encoding) => {
              if (request === previewRequest) delimitedEncoding = encoding;
            },
          });
        } finally {
          clearTimeout(timeout);
        }
        if (request !== previewRequest || signal.aborted) {
          result.dispose?.();
          return;
        }
        documentPreviewDispose = result.dispose || null;
        getElement('preview-content').replaceChildren(result.element);
        return;
      }
      // 原生媒体直接请求文件，不再先发一次 HEAD；文本仍需校验读取状态。
      const response = category === 'text' ? await fetch(url, { signal: previewController.signal }) : null;
      if (response && !response.ok) {
        const reason = response.status === 403
          ? '文件不在当前服务的索引中，请刷新页面；若服务仍运行旧代码，请重启服务。'
          : '文件可能已删除或权限发生变化，请重新扫描后刷新页面。';
        throw new Error(`文件读取失败（HTTP ${response.status}）。${reason}`);
      }
      if (category === 'text') {
        const buffer = await response.arrayBuffer();
        if (request !== previewRequest) return;
        const bytes = new Uint8Array(buffer);
        const encoding = isDelimited && delimitedEncoding !== 'auto'
          ? delimitedEncoding
          : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        let text = new TextDecoder(encoding).decode(bytes);
        if (text.includes('\0')) throw new Error('该文件包含二进制内容，无法作为文本预览。');
        const pre = document.createElement('pre');
        pre.textContent = text || '（空文件）';
        getElement('preview-content').replaceChildren(pre);
        if (isJson) {
          const originalText = text;
          let formattedText;
          let formatted = false;
          formatJsonButton.disabled = false;
          formatJsonButton.onclick = () => {
            try {
              // 首次点击才解析；切回原文保留原始空白和换行，不重新读取文件。
              if (formattedText === undefined) formattedText = JSON.stringify(JSON.parse(originalText), null, 2);
              formatted = !formatted;
              pre.textContent = (formatted ? formattedText : originalText) || '（空文件）';
              formatJsonButton.textContent = formatted ? '查看原文' : '格式化';
              formatJsonButton.setAttribute('aria-pressed', String(formatted));
              getElement('preview-mode').textContent = formatted ? 'JSON 格式化' : '文本阅读';
            } catch {
              getElement('preview-mode').textContent = 'JSON 格式无效，已保留原文';
            }
          };
        }
      } else {
        if (request !== previewRequest) return;
        if (category === 'pdf' && mobileViewport.matches) {
          const signal = previewController.signal;
          const module = await loadPreviewModule('pdf');
          if (request !== previewRequest || signal.aborted) return;
          const result = await module.render(null, {
            url,
            signal,
            onStatus: (message) => {
              if (request === previewRequest) getElement('preview-mode').textContent = message;
            },
          });
          if (request !== previewRequest || signal.aborted) {
            result.dispose?.();
            return;
          }
          documentPreviewDispose = result.dispose;
          getElement('preview-content').classList.add('mobile-pdf');
          getElement('preview-content').replaceChildren(result.element);
          return;
        }
        const tag = { image: 'img', audio: 'audio', video: 'video', pdf: 'iframe' }[category];
        const element = document.createElement(tag);
        if (category === 'image') element.alt = node.name;
        if (category === 'pdf') element.title = `PDF 预览：${node.name}`;
        if (category === 'audio' || category === 'video') {
          element.controls = true;
          element.preload = 'metadata';
        }
        element.addEventListener('error', () => {
          if (request === previewRequest) showPreviewMessage('文件不存在、已损坏或格式不受浏览器支持，请下载后打开。');
        });
        element.src = url;
        getElement('preview-content').replaceChildren(element);
        if (category === 'pdf') {
          const hint = document.createElement('p');
          hint.className = 'preview-message';
          hint.textContent = '若浏览器未显示 PDF，请使用上方下载按钮打开。';
          getElement('preview-content').append(hint);
        }
      }
    } catch (error) {
      if (request === previewRequest && error.name !== 'AbortError') {
        showPreviewMessage(error.message, () => openPreview(node, allowLargeText, showSvgSource), '重试');
      }
    }
  }

  /** 仅放大至页面视口，保留浏览器地址栏；退出时恢复页面滚动。 */
  function exitFullscreen() {
    getElement('preview-panel').classList.remove('expanded');
    document.body.classList.remove('preview-expanded');
    getElement('fullscreen').textContent = '全屏查看';
    getElement('fullscreen').setAttribute('aria-pressed', 'false');
  }

  getElement('fullscreen').setAttribute('aria-pressed', 'false');
  getElement('fullscreen').addEventListener('click', () => {
    const panel = getElement('preview-panel');
    if (panel.classList.contains('expanded')) {
      exitFullscreen();
      return;
    }
    panel.classList.add('expanded');
    document.body.classList.add('preview-expanded');
    getElement('fullscreen').textContent = '退出全屏';
    getElement('fullscreen').setAttribute('aria-pressed', 'true');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') exitFullscreen();
  });
  getElement('close-preview').addEventListener('click', () => {
    exitFullscreen();
    disposeDocumentPreview();
    ++previewRequest;
    previewController?.abort();
    getElement('preview-content').replaceChildren();
    getElement('preview-panel').hidden = true;
    document.body.classList.remove('preview-open');
    state.selected = null;
    updateSelectedRow();
  });
  getElement('toggle-svg-source').addEventListener('click', () => {
    const selectedFile = nodeByPath.get(state.selected);
    if (selectedFile) {
      const showSource = getElement('toggle-svg-source').getAttribute('aria-pressed') !== 'true';
      openPreview(selectedFile, false, showSource);
    }
  });
  getElement('open-file-details').addEventListener('click', () => {
    const selectedFile = nodeByPath.get(state.selected);
    if (selectedFile) openFileDetails(selectedFile);
  });
  getElement('close-file-details').addEventListener('click', () => {
    getElement('file-details-dialog').close();
  });
  getElement('copy-preview-path').addEventListener('click', () => {
    if (detailsNode) copyFilePath(detailsNode);
  });
  getElement('parent-directory').addEventListener('click', () => navigateTo(nodeByPath.get(state.directory).parentPath ?? ''));
  function scheduleSearch() {
    clearTimeout(searchTimer);
    if (composingSearch) return;
    searchTimer = setTimeout(() => {
      state.search = getElement('search').value.trim();
      renderDirectory();
    }, 120);
  }
  getElement('search').addEventListener('input', scheduleSearch);
  getElement('search').addEventListener('compositionstart', () => { composingSearch = true; clearTimeout(searchTimer); });
  getElement('search').addEventListener('compositionend', () => { composingSearch = false; scheduleSearch(); });
  getElement('load-more-files').addEventListener('click', () => renderDirectory(true));
  // 整张列表只使用一个事件监听器，新增行不再创建多份点击闭包。
  getElement('file-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const node = nodeByPath.get(button.closest('tr')?.dataset.path);
    if (!node) return;
    if (button.dataset.action === 'open') node.type === 'directory' ? navigateTo(node.path) : openPreview(node);
    if (button.dataset.action === 'copy-name') copyText(node.name, `已复制名称：${node.name}`);
    if (button.dataset.action === 'copy-path') copyFilePath(node);
    if (button.dataset.action === 'details') openFileDetails(node);
  });
  getElement('type-filter').addEventListener('change', (event) => { state.filter = event.target.value; renderDirectory(); });
  document.querySelector('.toolbar').addEventListener('submit', (event) => event.preventDefault());
  for (const button of document.querySelectorAll('[data-sort]')) {
    button.addEventListener('click', () => {
      state.direction = state.sort === button.dataset.sort ? -state.direction : 1;
      state.sort = button.dataset.sort;
      renderDirectory();
    });
  }
  getElement('scan-time').textContent = `最后扫描 ${formatDate(catalog.generatedAt)}`;
  getElement('error-summary').textContent = catalog.errors.length ? `${catalog.errors.length} 个扫描错误（详情见扫描终端）` : '本地目录 · 只读浏览';
  // URLSearchParams 自动处理中文、空格、# 等特殊字符，刷新后保持当前位置。
  const savedDirectory = new URL(window.location.href).searchParams.get('dir') || '';
  navigateTo(savedDirectory);
})();
