# 发布材料（0.1.2）

> GitHub/npm `0.1.1` 已发布；`0.1.2` 本地准备（改名“输入框图片与文件” + 发送后保留 `@文件名`），待发；市场暂缓。

## 身份

- 名称：`dsh-inline-attachments`
- 版本：`0.1.2`（本地准备，待发）
- 作者：`Panther-w`
- 许可：MIT
- 仓库：`https://github.com/Panther-w/dsh-inline-attachments`
- npm：`dsh-inline-attachments`
- 实测：macOS DSH Desktop `0.2.2-rc.3`
- 发布状态：GitHub `v0.1.1` / npm `0.1.1` 已发布；`0.1.2` 待发

## 一句话（GitHub / npm / 市场统一）

**在输入框里把图/文件放在哪里，模型就在哪个位置读到它——不用再写“如图 1、图 2 等等”。**

English：**Put images/files where you mean them — the model reads them in that exact position.**

## 截图

- 主图：`docs/preview.jpg`
- 图注：`行内附件：输入框里 4 张图片的小标签；鼠标停在 image.png（2） 时，上方第二个缩略图有淡蓝色描边。`

## GitHub

- About：`在输入框里把图/文件放在哪里，模型就在哪个位置读到它——不用再写“如图 1、图 2 等等”。`
- Topics：`dsh`, `dsh-plugin`, `deepseek-harness`, `composer`, `attachments`
- README：仓库里的 [`README.md`](README.md)
- Release 标题：`v0.1.0`

**Release 说明**

```markdown
## 行内附件 0.1.0

在输入框里把图/文件放在哪里，模型就在哪个位置读到它——不用再写“如图 1、图 2 等等”。

### 功能
- 图片/文件在光标处变成小标签，发送时按标签位置重排。
- 删正文小标签会连附件一起删，撤销能找回；同名文件加（2）（3）。
- 发送后消息文本保留 `@文件名`，图片在同一位置。
- 图片点开看大图；PDF 打开，Excel 等下载。
- 悬浮标签时，上方对应缩略图会描边。

28 个自动测试 + 多轮人工测试。MIT。
```

## npm

- description：`行内附件：在输入框里把图/文件放在哪里，模型就在哪个位置读到它——不用再写“如图 1、图 2 等等”。`
- 发布前补 `LICENSE`、`icon.svg`，去掉 `private`；`npm pack --dry-run`；干净 profile 安装/卸载。
- `files` 含 `index.js`、`host.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`icon.svg`、`docs`。

## 插件市场

**标题**：行内附件

**一句话**：在输入框里把图/文件放在哪里，模型就在哪个位置读到它——不用再写“如图 1、图 2 等等”。

**功能**
- 在光标处粘贴、拖入或上传，图片和文件变成小标签。
- 发送时按标签位置重排，模型按位置读。
- 删正文小标签连附件一起删，撤销能找回；同名加（2）（3）。
- 图片看大图；PDF 打开，Excel 等下载。
- 悬浮标签时，上方对应缩略图描边。

**English**：Inline attachments for the DSH composer. Put images/files where you mean them and the model reads them in that exact position. Version 0.1.0 relies on composer internals. MIT.

**市场 PR 正文**

```markdown
### Add dsh-inline-attachments 0.1.0

**它是什么.** DSH 输入框的行内附件：图片/文件在光标处变成小标签，发送时按标签位置把消息重排，模型按位置读。

**包 / 仓库 / 许可.** `dsh-inline-attachments@0.1.0` · https://github.com/Panther-w/dsh-inline-attachments · MIT。

**兼容.** 已测 DSH Desktop 0.2.2-rc.3；亮/暗主题跟随 DSH；Windows 无平台相关代码但未实测。

**验证.** 自动测试 + 多轮人工测试（粘贴/拖入、删图、焦点、描边、文件标签、亮/暗主题）。

**English.** Inline attachments for the DSH composer. Put images/files where you mean them and the model reads them in that exact position. Version 0.1.0; MIT.
```

## 发布步骤

1. 补 `LICENSE`、`icon.svg`；改 `package.json`；`npm pack --dry-run`。
2. 干净 profile 从 tarball 安装 → 重启 → 卸载。
3. npm 发布 → GitHub 仓库/tag/Release → 市场 PR。
4. 更新 `codex/memory/dsh-inline-attachments/` 与 `PROJECT_CONTEXT`。
