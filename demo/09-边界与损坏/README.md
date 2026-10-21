# 边界与损坏

[返回 Demo 总览](../README.md)

| 文件 | 预期效果 |
| --- | --- |
| empty.txt | 正常显示空内容 |
| large-over-5MB.txt | 超过 5 MB，用户确认后才读取正文；加载后可滚动 |
| binary.txt | 提示不适合作为文本预览，保留下载 |
| broken.png、broken.mp4 | 无法解析时显示失败或浏览器不支持提示 |
| broken.pdf | PDF 阅读器报告加载失败，仍可下载 |
| 损坏Word.docx、损坏Excel.xlsx、损坏PowerPoint.pptx | 故意写入无效 Office 内容，显示解析失败或不支持提示，保留下载 |

这些损坏样例故意写入无效内容，不应作为正常素材使用。失败后应能继续打开其他文件，页面不应卡住。正常 Office 样例见 [Markdown 与 Office 说明](../08-Markdown与Office/README.md)。
