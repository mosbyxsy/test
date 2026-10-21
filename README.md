# 数据站

各种用于测试的数据站，可以通过[index.html](./index.html)浏览相关文件详情。

## 内容导航

| 目录或文件 | 用途 | 说明 |
| --- | --- | --- |
| [index.html](./index.html) | 数据站网页入口 | 通过 HTTP 服务访问 |
| [file-browser/](./file-browser/) | 文件浏览器的样式、交互与预览资源 | [使用与维护说明](./file-browser/README.md) |
| [scripts/](./scripts/) | 目录扫描与本地服务脚本 | [Node.js 脚本说明](./scripts/README.md) |
| [demo/](./demo/) | 各种格式的演示文件、边界与损坏样例 | [测试文件说明](./demo/README.md) |

## 说明

- 新增、删除、修改文件或调整 `.gitignore` 后需重新运行扫描，详情查看[Node.js 脚本说明](./scripts/README.md)。
- `file-browser/catalog-data.js` 是扫描生成的目录索引。

## 数据说明

- demo测试文件
