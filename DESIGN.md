# dsh-inline-attachments 设计（0.1）

> 状态：0.1 方案定稿并实现，经过 7 席独立评审（产品/设计/工程/QA/红队/审计/隐私）后修订。
> 品牌名 `dsh-inline-attachments`，中文「行内附件」。
> 目标：在 DSH 输入框里，粘贴/拖入/上传的图片和文件在光标处变成 chip；发送时，模型收到「文字 → 图 → 文字 → 图」的交错内容，而不是「所有附件在前、正文在后」。

## 1. 为什么是「插件对」，不是改核心

- **改核心**能拿到最完整的视觉（缩略图、悬浮卡、×），但打包桌面版无法安装，只能等官方版本或从源码跑。
- **A（只在正文里插假标记）** 的模型侧仍是附件在前、正文在后，删图/重名/超预算时静默指错。
- **B（插件重写整个输入框）** 要重做草稿、上传、队列、快捷键、手机端，代价大且跟版本强耦合。
- **0.1 采用插件对**：客户端插原子引用 chip；宿主在 `agent/pre-step` 按标记把消息重排成交错 content。`agent/pre-step` 的 `decision.messages` 会被 `step()` 逐条 append 成 `user/message`，所以重写后的批次就是落盘/送模型的批次。

**0.1 不做的视觉**：chip 内的缩略图、悬浮预览卡、chip 上的 ×。这三样由核心 `ReferenceChip` 渲染，插件没有替换点。0.1 保留：chip 标签（同名加序号）、点击看原图（仅图片）、退格整块删除、复制/剪切。视觉完整版需核心/上游（见第 8 节）。

## 2. 数据流

```
粘贴/拖入/上传
  └─ 核心：附件进草稿（上传、rail 缩略图/文件卡）
      └─ 客户端：新附件 id → 在编辑器保留光标处插 chip
          └─ chip.ref = JSON{sessionId, draftAttachmentId}
          └─ 渲染时记录 ref → 当前会话（refOwner，处理切工作区迁移）
  └─ 发送：content = [...附件, {type:'text', text}]，text 里带不可见标记
      └─ 宿主 agent/pre-step：按 N 把第 N 个附件块搬到标记位置；同标记只取第一次
          └─ 模型/日志收到 [text, image, text, image, ...]
```

## 3. 标记协议（不可见）

- 形态：`U+2063` + `N × U+200B` + `U+2063`；`N` 为 1 起的附件序号。
- 为什么不可见：提交的 text 先出现在发送回显/队列行里；不可见标记让这些界面保持干净，只有宿主解析。
- 为什么用序号：图片耐久 `sha256:` id 在 Host 归一化后才生成；composer 上传状态只保留 `receiptId`，客户端发送前拿不到耐久 id。序号是客户端与宿主共享的稳定量。
- 序号在**提交时**算：codec 读 `input.state.getSnapshot()` 的实时 `attachmentIds`；取不到就发占位，不猜旧 registry 的序号。chip 的归属会话由 `refOwner` 决定（切工作区后 ref 里的旧 session 不可用）。
- **同标记只取第一次**：宿主用 `used` 集合，重复/伪造的标记不会把同一附件插两次；缺附件/未知标记直接丢弃。
- 缺附件时 codec 发可见占位「［附件已移除］」（不区分图片/文件），不发空标记。

## 4. 客户端（`client.js`）

- 挂载：`conversation.input.overlay`（list、session 作用域，必须带 `id`）；组件常驻一个隐藏 anchor，用于定位所属 composer 卡片。
- 输入源：注册 `@` 源 `inline-attachments`（空 candidates，只为 codec/openReference）；**source 注册成功后才允许插 chip**（否则 chip 没有 serializer，草稿发不出去）。
- 新附件：对每个新 id：
  1. 插在**编辑器保留的光标**处（折叠成点）；不要求编辑器聚焦。点 + 打开文件选择器后焦点离开编辑器，仍用最后保留的光标——打完字点 + 就是文字末尾（WorkBuddy 式追加）；先点回中间则插中间。
  2. `collapsedSpan(captureInsertion())` 取 `max(start,end)`，绝不替换选中文字。
  3. `insertReference({ source, ref, label, clipboardText:'@'+base, appearance:'file' }, span)`；失败重试一次。
- 标签：文件名；同名追加 `（2）`/`（3）`（只改显示，剪贴板与 codec 仍用基础名 + 附件 id）。
- 删除（双向）：
  - 删 chip → 移除附件；撤销让 chip 回来时把附件加回（rail 末尾）。
  - rail 删附件 → 整稿重写（`setDraft` 的 DraftSnapshot）删 chip（段中/末尾都删；重写会把光标丢到末尾，删完接着打字需点回原位置）；有 quote/command 时跳过。chip 尚未确认时先保留记录，等 chip 出现再补删。
  - 缺失附件的 chip 在发送时变成「［附件已移除］」。
- 跨会话迁移草稿：渲染时 `refOwner.set(chip.ref, 当前会话)`；codec 优先用当前会话的实时附件顺序，旧会话 binding 仍存活也不会归零。
- 刷新：草稿 references 持久化、附件 File 不持久化；刷新后 chip 在、附件没了，发送时占位。这是 DSH「未发送草稿不持久化附件」的延续。
- 预览：点击图片 chip 打开灯箱（关闭按钮、焦点进入/还原、Tab 圈定、Esc、点背景关闭；附件删除时自动关闭）。灯箱宿主按 session 登记，多 composer 不会互相覆盖。文件标签点击打开/下载。
- 悬浮联动：只在 `(hover: hover)` 且同一 composer 卡片内，按预览 URL 匹配 rail 缩略图并加内描边；用注入的 `<style>` 类，`box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent)`，内描边不裁切、不盖 focus-visible、不常驻；多 composer 不会串。

## 5. 宿主（`host.js` + `index.js`）

```js
ctx.on('agent/pre-step', async (_payload, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision
  const messages = Array.isArray(decision.messages) ? decision.messages.map(rewriteMessage) : decision.messages
  return { ...decision, messages }
})
```

`rewriteMessage(message)`：

1. 只处理 `message.source.kind === 'user'`；其余原样。
2. 有哨兵才改写；没有标记原样返回。
3. 从 content 按顺序收集 `image`/`file` 块。
4. 扫描 text 块标记：标记前文字 → text；第 N 个附件插到标记处（**同一 N 只插一次**）；`N=0`/越界/重复 → 删标记。
5. 没有被引用的附件按原顺序追加到末尾（不丢附件）。
6. 合并相邻 text，丢弃空 text；返回深冻结的新消息（保留 id/source）。

## 6. 失败模式（README 同步）

- 宿主未加载：不可见标记以零宽字符进模型（不可见，但仍是噪声）；bundle 同时装两半，正常不会出现。
- 删 chip、附件还在：移除附件；撤销恢复。
- rail 删附件：chip 被重写删掉（段中/末尾；光标到末尾）；quote/command 保留 chip（发送时占位）；未确认的 chip 等出现后补删。
- 刷新后：chip 在、附件不在；发送时该处是「［附件已移除］」，不是空白。
- 焦点不在编辑器：插在保留光标（通常末尾）。
- 有选区：插到选区末尾，不替换选中文字。
- 跨会话迁移草稿：refOwner + 实时顺序，不归零。
- 队列/steer 同样走 pre-step；子智能体只读 composer 不产生 chip。
- 卸载/禁用后残留 chip：owner 缺失，`serializeReference` 会拒绝，草稿发不出去；**卸载前先删掉草稿里的 chip**。

## 7. 回退

- `plugin_manager remove_bundle target=dsh-inline-attachments`，重启 DSH。
- 宿主 listener、客户端组件消失；已发送历史不受影响；**未发送草稿里的 chip 会变成无主引用，先删 chip 再卸载**。
- 不改核心文件、不改 profile 之外配置。

## 8. 视觉完整版（二期，需核心）

- 在 `ReferenceChipNode` 之外加 attachment decorator node（缩略图/悬浮卡/×），或给引用 chip 增加图片外观。
- `DraftSnapshot` 记录附件位置；提交时原生交错（不再需要宿主重写）。
- 0.1 的宿主重写可退役；标记协议可保留为兼容层。
- 需要上游补的 API：`removeReference(occurrenceId)`（定点删 chip，避免整稿重写）、`SessionStandardProps` 暴露附件元数据、`InputState` 暴露 quotes/command 结构。

## 9. 验收

- 宿主：`test/host.test.mjs` 10 个用例：交错、文件顺序、缺号/越界、无标记、未引用附件、非 user、冻结、无附件删标记、多 text 块、重复标记只插一次。
- 宿主接线：`test/host-wiring.test.mjs` 2 个（pre-step 注册、enter/reject）。
- 客户端：`test/client-load.test.mjs` 1 个（模块装载、slot 注册、source/codec）；`test/client-flow.test.mjs` 11 个（首挂 seed、保留光标插入、删 chip/撤销、rail 删文末/段中 chip、同步订阅、quote/command 阻断、同名序号、跨会话 refOwner、删除后同名不占号、未确认 chip 补删、同拍批量删、删先前同名后不复用编号）。
- 共 27 个测试；`node --check client.js` 通过；安装后人工验收（粘 3 张图、中间打字、删中间附件、有选区粘贴、发送、看模型是否按位置回答）。

## 10. 未核验 / 风险

- `ctx.conversation.resolveDraftAttachments`、`InputActions.setDraft(DraftSnapshot)` 是类型外/内部形态；升级可能改名或收紧（有降级）。
- 回显：客户端 `settleSubmittedAttachments` 按附件下标配对本地预览；宿主重排后本地预览可能短暂配错，耐久消息/刷新后正确（未实测）。
- rail 删图整稿重写会把光标移到末尾；段中删完接着打字要先点回位置。quote/command 草稿保留 chip，发送时占位。
- 队列行「编辑」暴露不可见标记原文；删改会丢位置（不丢图）。
- 文件标签点击打开/下载；键盘用户请用附件条缩略图。
- 文案硬编码中文；无 locale/icon/DETAIL，暂未上市场（`private:true`）。
