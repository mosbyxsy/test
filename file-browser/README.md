# 文件浏览器

文件导航、详情查看、预览工具。

## 浏览与预览

支持目录树、面包屑、全局名称搜索、类型筛选与排序，以及名称和地址复制、详情、下载。当前目录记录在 URL 中，刷新后恢复；预览支持页面内全屏和移动端布局。

| 格式 | 展示方式 |
| --- | --- |
| 文本、代码、JSON | 安全源码展示，JSON 默认原文，可点击格式化并切回原文 |
| Markdown | 阅读与源码切换，支持表格、代码块和本地图片 |
| 图片、SVG | 图片展示，SVG 可切换源码 |
| 音频、视频 | 浏览器原生播放 |
| PDF | 桌面原生阅读器，移动端逐页滚动 |
| DOCX、PPTX | 提取文字、表格和常见内嵌图片，不精确还原排版 |
| XLSX、XLS | 工作表切换、每页 200 行，最多展示 200 列 |
| CSV、TSV | 表格与源码切换，可选首行表头及编码 |
| 其他格式 | 文件信息与下载 |

预览模块与本地解析库按需加载，不上传文件。HTML 和脚本不执行，Markdown 渲染内容经过清理，Office 不执行宏或公式。示例见 [demo 说明](../demo/README.md)。

### 大文件限制

- 文本、Markdown、CSV、TSV 超过 5 MB，Office 超过 20 MB：确认后加载。
- Office 超过 50 MB：仅提供下载。
- 文档解析支持取消与超时终止；损坏、加密或解压后超出预算的文件停止预览。

## 文件说明

| 文件或目录 | 用途 |
| --- | --- |
| [app.js](./app.js) | 页面交互入口，负责目录导航、搜索筛选、列表展示及预览调度 |
| [styles.css](./styles.css) | 页面布局、组件样式和移动端适配 |
| [logo.svg](./logo.svg) | 网站 Logo，同时用于浏览器标签图标 |
| [folder.svg](./folder.svg) | 目录树与文件列表共用的文件夹图标 |
| `catalog-data.js` | 扫描生成的目录索引，通过 `window.FILE_CATALOG` 提供数据，请勿手动修改 |
| [preview/](./preview/) | 按需加载的内容预览模块，具体职责见下表 |
| [vendor/](./vendor/) | 本地第三方解析库及许可证，运行时无需访问 CDN |
| [README.md](./README.md) | 浏览能力、使用限制与文件说明 |

### 预览模块

| 文件 | 用途 |
| --- | --- |
| [markdown.mjs](./preview/markdown.mjs) | Markdown 渲染、内容清理和相对图片路径处理 |
| [word.mjs](./preview/word.mjs)、[slides.mjs](./preview/slides.mjs) | Word 与 PowerPoint 预览入口 |
| [office.mjs](./preview/office.mjs) | 将 Office 解析结果构建为文字、表格和图片视图 |
| [office-worker.js](./preview/office-worker.js) | 在 Worker 中解析 DOCX、PPTX 内容 |
| [office-limits.mjs](./preview/office-limits.mjs) | Office 资源预算与 ZIP 解压前检查 |
| [sheet.mjs](./preview/sheet.mjs) | Excel、CSV、TSV 的表格展示、分页及选项控制 |
| [sheet-worker.js](./preview/sheet-worker.js) | 在 Worker 中解析工作簿和分隔文本，处理分页数据 |
| [pdf.mjs](./preview/pdf.mjs) | 移动端 PDF 逐页渲染与画布回收 |
| [worker-client.mjs](./preview/worker-client.mjs) | Worker 通信、超时、取消与终止管理 |
| [shared.mjs](./preview/shared.mjs) | 预览模块共用的 DOM、取消检查和图片资源释放方法 |
| [readers.css](./preview/readers.css) | 文档、表格和移动端 PDF 的阅读样式 |

页面入口位于根目录的 [index.html](../index.html)，扫描与服务命令见 [scripts 说明](../scripts/README.md)。索引更新通过扫描脚本完成。
