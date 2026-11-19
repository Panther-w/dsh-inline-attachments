# 发布材料（0.1.4）

> GitHub Release 与 npm `0.1.4` 待发布；本次同时提交 awesome-dsh-plugin（分类 `ui`）。

## 身份

- 名称：`dsh-inline-attachments`
- 版本：`0.1.4`
- 作者：`Panther-w`
- 许可：MIT
- 仓库：`https://github.com/Panther-w/dsh-inline-attachments`
- npm：`dsh-inline-attachments`
- 实测：macOS DSH Desktop `0.2.2-rc.5`
- 发布状态：GitHub `v0.1.4` / npm `0.1.4` 待发；市场投稿待提 PR

## 一句话（GitHub / npm / 市场统一）

**输入框增强：把图片或文件放在你想要的位置，模型就在该位置读到它。**

English：**Composer enhancement: put images or files where you mean them and the model reads each one at that exact position.**

## GitHub Release 正文

```markdown
适配 DSH 0.2.2-rc.5，并做两处输入体验优化。

## 适配

- 悬停描边在 rc.5 上不可见：缩略图改版后内阴影被图片内容盖住，改用 `outline` 绘制，
  颜色取主色 55% 透明度。

## 优化

- 正文占位改为纯文本 `[图片1]` / `[文件1]`，占位前后各留一个空格；**正文**不再生成 `@文件名`，
  避免点击时提示「文件不存在」。
- 同名附件序号改用英文括号：`image.png (2)`。

## 验证

- `npm test`：31/31
- 实测：macOS · DSH Desktop 0.2.2-rc.5
- 手工验收：插图/插文件成标签 → 发送后正文 `[图片N]` 占位、图片在对应位置；
  悬停标签 → 对应缩略图出现淡蓝描边（多图一一对应）

MIT
```

## 截图

- 主图：`docs/preview.jpg`
- 图注：`行内附件：输入框里 4 张图片的小标签；鼠标停在 image.png (2) 时，上方第二个缩略图有淡蓝色描边。`

## 验证清单

- [x] `node --check client.js`
- [x] `npm test` 31/31
- [x] 手工：插图/插文件、发送后占位、悬停描边、多图一一对应
- [x] 无手机号/邮箱/密钥进入包内容
