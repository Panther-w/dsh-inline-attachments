/**
 * dsh-inline-attachments — 浏览器半（预构建产物）。
 *
 * 只做四件事，不改任何现有 slot：
 *   1. 在 `conversation.input.overlay`（list，session 作用域）里放一个不渲染常驻 UI 的
 *      组件：监听草稿附件变化，在光标处插原子引用 chip；
 *   2. 注册 `@` 输入源 `inline-attachments`，candidates 永远为空（不参与 @ 菜单），
 *      只为了携带 codec 与 openReference；
 *   3. codec：提交时按当前附件顺序输出**不可见**标记（U+2063 + N×U+200B + U+2063），
 *      让发送回显和队列行保持干净；缺附件时改发可见占位「［附件已移除］」。
 *   4. 点击 chip 时用附件自己的 previewUrl 打开灯箱。
 *
 * 所有 ctx 服务（inputTriggers / conversation / resolveDraftAttachments / sessions.binding）
 * 都可能缺失或改名：缺失时静默降级（不插 chip、不预览），绝不抛错。
 *
 * 删 chip 会移除对应附件（撤销时加回）；rail 删文末图会整稿重写删 chip，段中/quote/命令场景保留 chip。
 */
window.__ModuleLoader__.load({
  id: 'dsh-inline-attachments',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 引用 chip 的 source 名。 */
    const SOURCE = 'inline-attachments'
    /** 取不到附件对象时的兜底标签。 */
    const FALLBACK_LABEL = '附件'
    /** 有附件对象但没有文件名时的图片标签。 */
    const IMAGE_LABEL = '图片'
    /** 不可见标记的哨兵字符（U+2063 INVISIBLE SEPARATOR）。 */
    const SENTINEL = '\u2063'
    /** 序号编码字符（U+200B ZERO WIDTH SPACE）。 */
    const COUNTER = '\u200B'
    /** 悬浮联动时加在 rail 缩略图上的类；用 style 而不是 inline，避免盖掉 focus-visible。 */
    const OUTLINE_CLASS = 'dsh-inline-attachment-hover-outline'

    /**
     * 注入一次描边样式：业务蓝 55% 半透明、2px、内缩 2px；同时给不支持 color-mix 的
     * 环境一个静态淡蓝兜底。只在 hover 时加类，不常驻。
     */
    function ensureOutlineStyle() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return
      try {
        if (document.getElementById('dsh-inline-attachment-outline-style') !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-inline-attachment-outline-style'
        style.textContent = `.${OUTLINE_CLASS}{box-shadow:inset 0 0 0 2px rgba(65,118,230,.45);box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 55%, transparent);}`
        ;(document.head ?? document.documentElement).appendChild(style)
      } catch (error) {
        // 纯视觉，失败不影响输入。
      }
    }

    /**
     * 模块级附件登记表：sessionId → 最近一次渲染看到的草稿附件。
     * codec 在提交时同步读取它（序列化发生在渲染之外），所以必须在渲染期更新。
     * `at` 用于跨会话迁移草稿时优先采用最新的一份。
     */
    const registry = new Map()

    /** 灯箱宿主：sessionId → 该会话 overlay 的 open；多 composer 各自开自己的灯箱。 */
    const previewHosts = new Map()

    /**
     * chip ref → 当前归属会话。切工作区会迁移草稿和附件，但 chip.ref 里的 s 还是旧会话；
     * 渲染时按当前 occurrences 更新，codec 才能用新会话的附件顺序。
     */
    const refOwner = new Map()

    /** apply 之后才有值；组件渲染/输入源回调都从这里拿根上下文。 */
    const runtime = { ctx: null }

    /** 输入源注册成功前不插 chip：否则 chip 没有 serializer，草稿发不出去。 */
    let sourceReady = false

    /** 占位空状态：useInput 缺失时使用。 */
    const EMPTY_INPUT_STATE = Object.freeze({
      draft: '',
      attachmentIds: Object.freeze([]),
      draftRev: 0,
      phase: 'plain',
      occurrences: Object.freeze([]),
    })

    /**
     * 取 react-dom 的 createPortal；模块表里没有时退化为不 portal 的 fixed 层。
     */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === 'function') {
        createPortal = reactDom.createPortal.bind(reactDom)
      }
    } catch (error) {
      createPortal = null
    }

    /**
     * 解析 chip 的 ref：形态固定为 JSON `{"s":sessionId,"a":draftId}`。
     * @param {unknown} ref chip 引用原文。
     * @returns {{ s: string | undefined, a: string } | undefined} 解析结果；非法时 undefined。
     */
    function parseRef(ref) {
      if (typeof ref !== 'string' || ref === '') return undefined
      try {
        const value = JSON.parse(ref)
        if (value === null || typeof value !== 'object') return undefined
        if (typeof value.a !== 'string' || value.a === '') return undefined
        return {
          s: typeof value.s === 'string' && value.s !== '' ? value.s : undefined,
          a: value.a,
        }
      } catch (error) {
        return undefined
      }
    }

    /**
     * 不可见标记：U+2063 + index × U+200B + U+2063；0 仅用于内部兜底（codec 对外发占位）。
     * @param {number} index 1 起的当前附件序号。
     * @returns {string} 标记文本。
     */
    function stampOf(index) {
      const count = index > 0 ? Math.floor(index) : 0
      return `${SENTINEL}${COUNTER.repeat(count)}${SENTINEL}`
    }

    /**
     * 把 sessionId 统一转成 registry 键（SessionId 是字符串品牌类型）。
     * @param {unknown} sessionId 会话标识。
     * @returns {string | undefined} 字符串键；缺失时 undefined。
     */
    function keyOf(sessionId) {
      if (sessionId === undefined || sessionId === null) return undefined
      return String(sessionId)
    }

    /**
     * 通过 conversation 服务的公开（但不在类型里）方法取草稿附件对象。
     * @param {unknown} ctx 根上下文。
     * @param {readonly string[]} ids 草稿附件 id。
     * @returns {readonly any[] | undefined} 附件对象数组；取不到时 undefined。
     */
    function resolveAttachments(ctx, ids) {
      if (ctx === null || ctx === undefined) return undefined
      try {
        const conversation = ctx.conversation
        if (conversation === null || conversation === undefined) return undefined
        const resolve = conversation.resolveDraftAttachments
        if (typeof resolve !== 'function') return undefined
        const list = resolve.call(conversation, ids)
        return Array.isArray(list) ? list : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * 附件对象的显示标签：优先文件名，其次「图片/附件」。
     * @param {any} attachment ComposerAttachment 形状：{ id, kind, file:{name,size}, previewUrl }。
     * @returns {string} 标签。
     */
    function labelOf(attachment) {
      const name = attachment !== null && attachment !== undefined
        && attachment.file !== null && attachment.file !== undefined
        && typeof attachment.file.name === 'string'
        ? attachment.file.name.trim()
        : ''
      if (name !== '') return name
      return attachment !== null && attachment !== undefined && attachment.kind === 'image'
        ? IMAGE_LABEL
        : FALLBACK_LABEL
    }

    /**
     * 刷新某个会话的 registry 快照（渲染期调用，供 codec 在提交时读取）。
     * @param {unknown} sessionId 会话标识。
     * @param {readonly string[]} ids 本次渲染的附件顺序。
     * @param {readonly any[] | undefined} attachments 解析到的附件对象。
     * @returns {{ ids: string[], labels: Map<string,string>, previews: Map<string,string>, at: number }} 写入的条目。
     */
    function publishRegistry(sessionId, ids, attachments) {
      const key = keyOf(sessionId) ?? ''
      const labels = new Map()
      const previews = new Map()
      for (const attachment of attachments ?? []) {
        if (attachment === null || typeof attachment !== 'object') continue
        if (attachment.id === undefined || attachment.id === null) continue
        const id = String(attachment.id)
        labels.set(id, labelOf(attachment))
        if (typeof attachment.previewUrl === 'string' && attachment.previewUrl !== '') {
          previews.set(id, attachment.previewUrl)
        }
      }
      const entry = { ids: (ids ?? []).map(String), labels, previews, at: Date.now() }
      registry.set(key, entry)
      return entry
    }

    /**
     * 读取该会话输入状态里当前真实的附件顺序。codec 在提交时用这个而不是渲染期
     * 缓存的 registry：rail 删除/撤销后 registry 可能还没重渲染，用缓存会把序号
     * 算到别的附件上，模型就会收到错位的图。
     * @param {string} sessionId 会话标识。
     * @returns {string[] | undefined} 当前附件 id 顺序；取不到时 undefined。
     */
    function liveAttachmentIds(sessionId) {
      const ctx = runtime.ctx
      if (ctx === null || ctx === undefined) return undefined
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === null || binding === undefined || binding.ctx === undefined) return undefined
        const input = ctx.conversation.input.for(binding.ctx)
        const store = input === null || input === undefined ? undefined : input.state
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return undefined
        const state = store.getSnapshot()
        if (state === null || state === undefined || !Array.isArray(state.attachmentIds)) return undefined
        return state.attachmentIds.map(String)
      } catch (error) {
        return undefined
      }
    }

    /**
     * 按附件 id 找 registry 条目。先试 chip 记录的会话；找不到（草稿迁移到别的会话）
     * 就在所有会话里找，取最新发布的一份。
     * @param {string} attachmentId 草稿附件 id。
     * @param {string | undefined} preferredSession chip ref 里记录的会话。
     * @returns {{ ids: string[], labels: Map<string,string>, previews: Map<string,string> } | undefined} 条目。
     */
    function findEntry(attachmentId, preferredSession) {
      const matches = []
      for (const [key, entry] of registry) {
        if (entry !== null && Array.isArray(entry.ids) && entry.ids.includes(attachmentId)) {
          matches.push({ key, entry })
        }
      }
      if (matches.length === 0) return undefined
      // 草稿迁移后旧会话的登记可能还没被清掉；最新发布的一份才是附件当前所在。
      matches.sort((left, right) => right.entry.at - left.entry.at)
      if (matches.length > 1 && matches[0].entry.at === matches[1].entry.at
        && preferredSession !== undefined) {
        const own = matches.find((candidate) => candidate.key === preferredSession)
        if (own !== undefined) return own.entry
      }
      return matches[0].entry
    }

    /**
     * 取会话的 SessionInput 门面：sessions.binding(sessionId).ctx → conversation.input.for(ctx)。
     * @param {string} sessionId 会话标识。
     * @returns {any} SessionInput；取不到时 undefined。
     */
    function resolveSessionInput(sessionId) {
      const ctx = runtime.ctx
      if (ctx === null || ctx === undefined) return undefined
      try {
        const sessions = ctx.sessions
        if (sessions === null || sessions === undefined || typeof sessions.binding !== 'function') return undefined
        const binding = sessions.binding(sessionId)
        if (binding === null || binding === undefined || binding.ctx === undefined) return undefined
        const conversation = ctx.conversation
        if (conversation === null || conversation === undefined) return undefined
        const input = conversation.input
        if (input === null || input === undefined || typeof input.for !== 'function') return undefined
        return input.for(binding.ctx)
      } catch (error) {
        return undefined
      }
    }

    /**
     * 把 captureInsertion 的结果收成折叠点：有选区时插到选区末尾，绝不替换选中的文字。
     * @param {any} span captureInsertion 返回值。
     * @returns {{ start: number, end: number, draftRev: number } | undefined} 折叠 span。
     */
    function collapsedSpan(span) {
      if (span === null || span === undefined) return undefined
      const start = typeof span.start === 'number' ? span.start : 0
      const end = typeof span.end === 'number' ? span.end : start
      const point = Math.max(start, end)
      return { start: point, end: point, draftRev: span.draftRev }
    }

    /**
     * 把键盘还给输入框，但只在焦点已经掉到 body/已卸载节点时；不要在用户正用别的控件时抢焦点。
     * 触屏不主动聚焦编辑器（DSH 会避免弹软键盘）。
     * @param {string} sessionKey 会话标识。
     * @param {any} anchor 当前 overlay 的隐藏 anchor（用于确认所属 composer 卡片）。
     */
    function focusIfDetached(sessionKey, anchor) {
      if (typeof document === 'undefined' || typeof queueMicrotask !== 'function') return
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return
      queueMicrotask(() => {
        try {
          const active = document.activeElement
          if (active !== null && active !== undefined && active !== document.body && active.isConnected !== false) return
          if (anchor !== null && anchor !== undefined && typeof anchor.closest === 'function') {
            const card = anchor.closest('[data-composer-card]')
            if (card === null || card === undefined) return
            const editable = typeof card.querySelector === 'function'
              ? card.querySelector('[contenteditable="true"]')
              : null
            if (editable === null || editable === undefined || editable.isContentEditable !== true) return
          }
          const input = resolveSessionInput(sessionKey)
          if (input !== null && input !== undefined && typeof input.focus === 'function') input.focus()
        } catch (error) {
          // 焦点恢复失败不影响输入。
        }
      })
    }

    /**
     * 草稿里是否还有指定 ref 的 chip 出现项。
     * @param {any} state InputState 快照。
     * @param {string} ref chip 引用原文。
     * @returns {boolean} 是否出现。
     */
    function hasChip(state, ref) {
      const occurrences = state === null || state === undefined ? undefined : state.occurrences
      if (!Array.isArray(occurrences)) return false
      for (const occurrence of occurrences) {
        if (occurrence === null || occurrence === undefined) continue
        if (occurrence.source === SOURCE && occurrence.ref === ref) return true
      }
      return false
    }

    /**
     * 同名附件在草稿里追加显示序号：image.png → image.png（2）。只改 chip 标签，
     * 剪贴板仍是 @image.png，codec 仍按附件 id 工作。
     * @param {string} base 基础文件名。
     * @param {Map<string, any>} records 已插入的 chip 记录。
     * @returns {string} 显示标签。
     */
    function uniqueLabel(base, records) {
      let max = 0
      for (const record of records.values()) {
        if (record === null || record === undefined || typeof record.label !== 'string') continue
        // 删掉的 chip 记录会保留给撤销，不能再占一个新 chip 的序号。
        if (record.removedByPlugin === true) continue
        if (record.label === base) {
          max = Math.max(max, 1)
          continue
        }
        if (record.label.startsWith(`${base}（`) && record.label.endsWith('）')) {
          const parsed = Number(record.label.slice(base.length + 1, -1))
          if (Number.isFinite(parsed) && parsed > 0) max = Math.max(max, parsed)
        }
      }
      return max === 0 ? base : `${base}（${max + 1}）`
    }

    /**
     * 插入一个引用 chip：先 captureInsertion 并收成折叠点，失败时换新 span 重试一次。
     * @param {any} input SessionInput。
     * @param {any} inputActions 会话标准 props 里的稳定动作面。
     * @param {string} sessionId 会话标识。
     * @param {string} id 草稿附件 id。
     * @param {string} label 显示标签。
     * @returns {string | undefined} 写入 chips 的 ref；失败时 undefined。
     */
    function insertOneReference(input, inputActions, sessionId, id, label, clipboardLabel) {
      const ref = JSON.stringify({ s: sessionId, a: id })
      const reference = {
        source: SOURCE,
        ref,
        label,
        clipboardText: `@${clipboardLabel ?? label}`,
        appearance: 'file',
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const span = collapsedSpan(inputActions.captureInsertion())
          if (span === undefined) continue
          if (input.insertReference(reference, span) === true) return ref
        } catch (error) {
          // span 已过期/编辑器锁定：下一轮重试；第二次仍失败则放弃。
        }
      }
      return undefined
    }

    /**
     * 删掉草稿里指定 refs 的一组 chip，保留其余文本与引用。
     *
     * 公开 InputActions 只有整稿重写（setDraft），没有定点删 chip；这里把当前草稿
     * 投影成 DraftSnapshot（引用偏移按删除长度前移）再 restore。同一拍的所有删除
     * 必须一次 setDraft，否则第二条会用旧 state 覆盖第一条。只在没有 quote / command
     * chip 时执行；失败就放弃，让 chip 留在正文（提交时变占位）。
     * @param {any} state InputState 快照。
     * @param {readonly string[]} refs 要删除的 chip 引用。
     * @param {any} inputActions 会话标准 props 的输入动作。
     * @param {Element | null | undefined} scope 所属 composer 卡片，用于限定 quote/command 查询。
     * @returns {boolean} 是否已发起重写。
     */
    function removeChipsFromDraft(state, refs, inputActions, scope) {
      if (state === null || state === undefined) return false
      if (typeof state.draft !== 'string' || !Array.isArray(state.occurrences)) return false
      if (state.claim !== undefined) return false
      if (!Array.isArray(refs) || refs.length === 0) return false
      const removedRefs = new Set(refs)
      const root = scope !== null && scope !== undefined && typeof scope.closest === 'function'
        ? scope.closest('[data-composer-card]')
        : undefined
      if (typeof document !== 'undefined') {
        const container = root ?? document
        if (typeof container.querySelector === 'function'
          && container.querySelector('[data-composer-quote], [data-composer-command]') !== null) return false
      }
      if (inputActions === null || inputActions === undefined || typeof inputActions.setDraft !== 'function') return false
      const removed = state.occurrences.filter((occurrence) => occurrence !== null
        && occurrence !== undefined && occurrence.source === SOURCE && removedRefs.has(occurrence.ref)
        && typeof occurrence.offset === 'number' && typeof occurrence.length === 'number')
      if (removed.length === 0) return false
      let text = state.draft
      for (const occurrence of [...removed].sort((left, right) => right.offset - left.offset)) {
        text = text.slice(0, occurrence.offset) + text.slice(occurrence.offset + occurrence.length)
      }
      const references = []
      for (const occurrence of state.occurrences) {
        if (occurrence === null || occurrence === undefined || removed.includes(occurrence)) continue
        let shift = 0
        for (const gone of removed) if (gone.offset < occurrence.offset) shift += gone.length
        references.push({
          source: occurrence.source,
          ref: occurrence.ref,
          label: occurrence.label,
          ...(occurrence.appearance === undefined ? {} : { appearance: occurrence.appearance }),
          clipboardText: occurrence.clipboardText,
          offset: occurrence.offset - shift,
          length: occurrence.length,
          ...(occurrence.invalid === true ? { invalid: true } : {}),
        })
      }
      try {
        inputActions.setDraft({ text, references })
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * 读取草稿输入状态；会话标准 props 缺失时退化为空状态。
     * @param {unknown} useInput 会话标准 props 的 useInput。
     * @returns {any} InputState 快照。
     */
    function useInputState(useInput) {
      return typeof useInput === 'function'
        ? useInput((state) => state)
        : EMPTY_INPUT_STATE
    }

    /** 灯箱整层：固定在视口上的半透明遮罩。 */
    const layerStyle = {
      position: 'fixed',
      inset: 0,
      background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45))',
      backdropFilter: 'var(--dsw-mask-blur, blur(2px))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      cursor: 'zoom-out',
    }

    /** 灯箱图片：不超过视口九成。 */
    const imageStyle = {
      maxWidth: '90vw',
      maxHeight: '90vh',
      objectFit: 'contain',
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 32px rgba(0, 0, 0, .5))',
    }

    /** 关闭按钮：绝对定位在灯箱右上角。 */
    const closeStyle = {
      position: 'absolute',
      top: 20,
      right: 20,
      width: 36,
      height: 36,
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.18))',
      borderRadius: 999,
      background: 'var(--dsw-specific-input-major, rgba(0,0,0,.45))',
      color: 'var(--dsw-alias-label-primary, #fff)',
      fontSize: 18,
      lineHeight: '34px',
      cursor: 'pointer',
      zIndex: 1001,
    }

    /**
     * 附件原图灯箱：打开时焦点进入关闭按钮，Tab 限制在灯箱内，关闭后还原焦点；
     * 点背景或按 Esc 关闭；图片本身不触发关闭。
     * @param {any} props view = { url, label, id }，onClose 关闭回调。
     * @returns {any} portal 后的节点；无法渲染时 null。
     */
    function Lightbox(props) {
      const view = props.view
      const onClose = props.onClose
      const closeRef = React.useRef(null)
      const previousFocus = React.useRef(null)

      React.useEffect(() => {
        if (typeof document !== 'undefined') previousFocus.current = document.activeElement
        const button = closeRef.current
        if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus()
        return () => {
          const previous = previousFocus.current
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function'
            && previous.isConnected !== false) {
            previous.focus()
          }
        }
      }, [])

      if (view === null || view === undefined || typeof view.url !== 'string' || view.url === '') return null

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const button = closeRef.current
          if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus()
        }
      }

      const closeButton = h('button', {
        ref: closeRef,
        type: 'button',
        'aria-label': '关闭灯箱',
        title: '关闭',
        style: closeStyle,
        onClick: (event) => {
          event.stopPropagation()
          onClose()
        },
      }, '×')

      const layer = h('div', {
        style: layerStyle,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': view.label,
        onKeyDown,
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      }, closeButton, h('img', {
        src: view.url,
        alt: view.label,
        style: imageStyle,
        draggable: false,
      }))

      // 灯箱必须挂到 body：composer 卡片有自己的层叠上下文/overflow，fixed 层会被裁切。
      if (typeof document !== 'undefined' && typeof createPortal === 'function') {
        try {
          return createPortal(layer, document.body)
        } catch (error) {
          // portal 失败（document 不存在等）时退化为不 portal 的 fixed 层。
        }
      }
      return layer
    }

    /**
     * 覆盖层组件：不渲染任何常驻可见 UI，只在需要时渲染灯箱。
     * 副作用全部在这里：刷新 registry、插 chip、挂载预览宿主。
     * @param {any} props 会话标准 props：sessionId、useInput、inputActions。
     * @returns {any} 无灯箱时 null。
     */
    function Overlay(props) {
      const sessionId = props === null || props === undefined ? undefined : props.sessionId
      const inputActions = props === null || props === undefined ? undefined : props.inputActions
      const state = useInputState(props === null || props === undefined ? undefined : props.useInput)
      const [view, setView] = React.useState(null)
      const close = React.useCallback(() => { setView(null) }, [])
      const anchorRef = React.useRef(null)
      // null = 本会话还没跑过第一次 effect（首次挂载/会话切换后），先只登记不插 chip。
      const processedRef = React.useRef(null)
      // draftId → { ref, confirmed, removedByPlugin }：chip 与附件双向同步的状态。
      const recordsRef = React.useRef(null)
      const previousIdsRef = React.useRef(null)
      const sessionRef = React.useRef(sessionId)
      if (recordsRef.current === null) recordsRef.current = new Map()

      const ids = state !== null && state !== undefined && Array.isArray(state.attachmentIds)
        ? state.attachmentIds
        : []
      // 渲染期刷新 registry：codec 在提交时同步读取本次渲染的附件顺序与标签。
      publishRegistry(sessionId, ids, resolveAttachments(runtime.ctx, ids))
      // 记录每个 chip 当前归属的会话（迁移草稿后 ref 里的旧 session 不能再用）。
      const ownerKey = keyOf(sessionId)
      if (ownerKey !== undefined && Array.isArray(state.occurrences)) {
        for (const occurrence of state.occurrences) {
          if (occurrence !== null && occurrence !== undefined && occurrence.source === SOURCE) {
            refOwner.set(occurrence.ref, ownerKey)
          }
        }
      }

      // 预览宿主：按会话登记，多 composer 不会互相覆盖灯箱。
      React.useEffect(() => {
        const key = keyOf(sessionId) ?? ''
        const open = (url, label, id) => {
          if (typeof url === 'string' && url !== '') setView({ url, label: label || FALLBACK_LABEL, id })
        }
        previewHosts.set(key, open)
        return () => {
          if (previewHosts.get(key) === open) previewHosts.delete(key)
        }
      }, [sessionId])

      // 附件被删（rail 或草稿同步）时关掉灯箱，避免显示已回收的 blob。
      React.useEffect(() => {
        if (view === null || view === undefined) return
        if (typeof view.id !== 'string' || view.id === '') return
        if (!ids.includes(view.id)) setView(null)
      }, [ids, view])

      // 悬浮 chip 时给同一 composer 卡片里对应的 rail 缩略图描边：chip 的 DOM 顺序与
      // occurrences 顺序一致，用预览 URL（blob，唯一）找图；多 composer 只在各自卡片内查。
      const stateRef = React.useRef(state)
      stateRef.current = state
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && !window.matchMedia('(hover: hover)').matches) return undefined
        ensureOutlineStyle()
        const chipOf = (target) => (typeof Element === 'function' && target instanceof Element
          ? target.closest('[data-composer-chip="inline-attachments"]')
          : null)
        const cardOf = () => {
          const anchor = anchorRef.current
          return anchor === null || anchor === undefined || typeof anchor.closest !== 'function'
            ? undefined
            : anchor.closest('[data-composer-card]')
        }
        const clearOutline = (card) => {
          const scope = card ?? cardOf()
          if (scope === undefined || scope === null || typeof scope.querySelectorAll !== 'function') return
          for (const element of scope.querySelectorAll('[data-inline-attach-outline="1"]')) {
            element.classList.remove(OUTLINE_CLASS)
            delete element.dataset.inlineAttachOutline
          }
        }
        const onOver = (event) => {
          try {
            const chip = chipOf(event.target)
            if (chip === null) { clearOutline(); return }
            const card = cardOf()
            if (card === undefined || card === null || typeof card.contains !== 'function' || !card.contains(chip)) return
            const chips = [...card.querySelectorAll('[data-composer-chip="inline-attachments"]')]
            const index = chips.indexOf(chip)
            if (index < 0) return
            const current = stateRef.current
            const occurrences = current !== null && current !== undefined && Array.isArray(current.occurrences)
              ? current.occurrences.filter((occurrence) => occurrence !== null && occurrence !== undefined && occurrence.source === SOURCE)
              : []
            const occurrence = occurrences[index]
            if (occurrence === undefined) return
            const parsed = parseRef(occurrence.ref)
            if (parsed === undefined) return
            const entry = registry.get(keyOf(sessionId) ?? '')
            const url = entry === undefined ? undefined : entry.previews.get(parsed.a)
            if (typeof url !== 'string' || url === '') return
            const image = [...card.querySelectorAll('img')].find((element) => element.src === url)
            const target = image === undefined ? undefined : (image.closest('button') ?? image)
            if (target === undefined || target === null) return
            clearOutline(card)
            target.dataset.inlineAttachOutline = '1'
            target.classList.add(OUTLINE_CLASS)
          } catch (error) {
            // 描边只是视觉提示，失败不影响输入。
          }
        }
        const onOut = (event) => {
          const chip = chipOf(event.target)
          if (chip === null) return
          if (typeof Node === 'function' && event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return
          clearOutline()
        }
        document.addEventListener('pointerover', onOver, true)
        document.addEventListener('pointerout', onOut, true)
        return () => {
          document.removeEventListener('pointerover', onOver, true)
          document.removeEventListener('pointerout', onOut, true)
          clearOutline()
        }
      }, [sessionId])

      // 会话切换：同一组件实例不能把上个会话的“已处理”集合带过来。
      React.useEffect(() => {
        if (sessionRef.current === sessionId) return
        sessionRef.current = sessionId
        processedRef.current = null
        recordsRef.current = new Map()
        previousIdsRef.current = null
      }, [sessionId])

      // 同步删除订阅：chip 被退格删掉时，输入状态会立刻 publish；在这里同步移除附件，
      // 避免“删完立刻回车”时附件移除还没跑、图以未引用附件排到末尾。
      React.useEffect(() => {
        const key = keyOf(sessionId)
        if (key === undefined) return undefined
        const input = resolveSessionInput(key)
        const store = input === null || input === undefined ? undefined : input.state
        if (store === null || store === undefined || typeof store.subscribe !== 'function') return undefined
        const onStoreChange = () => {
          try {
            const current = store.getSnapshot()
            if (current === null || current === undefined || current.phase !== 'plain') return
            const ids = Array.isArray(current.attachmentIds) ? current.attachmentIds.map(String) : []
            const live = new Set(ids)
            for (const [id, record] of [...recordsRef.current]) {
              if (!record.confirmed || !live.has(id) || hasChip(current, record.ref)) continue
              if (inputActions === null || inputActions === undefined
                || typeof inputActions.removeAttachment !== 'function') continue
              inputActions.removeAttachment(id)
              record.removedByPlugin = true
            }
          } catch (error) {
            // 订阅回调里的失败不能影响输入。
          }
        }
        return store.subscribe(onStoreChange)
      }, [sessionId, inputActions])

      React.useEffect(() => {
        const key = keyOf(sessionId)
        if (key === undefined) return
        const currentIds = ids.map(String)

        // 首次挂载（含会话切换后首次）：草稿里已有的附件是历史附件，不能当成「新附件」
        // 在光标处插一串 chip；只登记为已处理，从第二次变化起才插。
        if (processedRef.current === null) {
          processedRef.current = new Set(currentIds)
          // 恢复的草稿/会话迁移可能已经带着我们的 chip：先登记，之后删 chip 才能同步附件。
          const records = recordsRef.current
          for (const occurrence of Array.isArray(state.occurrences) ? state.occurrences : []) {
            if (occurrence === null || occurrence === undefined || occurrence.source !== SOURCE) continue
            const parsed = parseRef(occurrence.ref)
            if (parsed !== undefined) {
              records.set(parsed.a, { ref: occurrence.ref, confirmed: true, removedByPlugin: false, label: occurrence.label })
            }
          }
          return
        }
        const processed = processedRef.current
        const fresh = currentIds.filter((id) => !processed.has(id))
        for (const id of currentIds) processed.add(id)

        // 1) chip ↔ 附件双向同步：
        //    - 删 chip（且附件还在）→ 移除附件；撤销让 chip 回来时再把附件加回；
        //    - rail 里删附件 → 文末 chip 重写删除；段中/chip 无法定点删时保留，提交时变占位。
        const records = recordsRef.current
        const live = new Set(currentIds)
        const removals = []
        // 本次 effect 前由插件主动移除的附件；撤销/附件减少时不要误抢焦点。
        const pluginRemoved = new Set([...records]
          .filter(([, record]) => record.removedByPlugin === true)
          .map(([id]) => id))
        for (const [id, record] of [...records]) {
          const chipLive = hasChip(state, record.ref)
          const idLive = live.has(id)
          if (chipLive) {
            record.confirmed = true
            if (idLive) {
              record.removedByPlugin = false
              continue
            }
            if (record.removedByPlugin) {
              const resolved = resolveAttachments(runtime.ctx, [id])
              if ((resolved === undefined ? 0 : resolved.length) > 0
                && inputActions !== null && inputActions !== undefined
                && typeof inputActions.addAttachments === 'function'
                && inputActions.addAttachments([id]) === true) {
                record.removedByPlugin = false
              }
              continue
            }
            removals.push({ id, ref: record.ref })
            continue
          }
          if (idLive && record.confirmed && state !== null && state !== undefined && state.phase === 'plain') {
            if (inputActions !== null && inputActions !== undefined
              && typeof inputActions.removeAttachment === 'function') {
              inputActions.removeAttachment(id)
              record.removedByPlugin = true
            }
            continue
          }
          // 未确认的 chip 可能只是本拍还没出现；先保留记录，等它出现再决定是否重写。
          if (!idLive && !record.removedByPlugin && record.confirmed) records.delete(id)
        }
        // 同一拍把全部缺失的 chip 一次重写，避免第二条 setDraft 覆盖第一条。
        if (removals.length > 0 && state !== null && state !== undefined && state.phase === 'plain') {
          const removed = removeChipsFromDraft(state, removals.map((item) => item.ref), inputActions, anchorRef.current)
          if (removed) {
            // 保留记录：如果用户 Cmd+Z 让 chip 回来，下面“撤销恢复附件”的分支能把图加回。
            // 不保证一定可行——整稿重写会并进上一组撤销；但比直接丢记录好。
            for (const item of removals) {
              const record = records.get(item.id)
              if (record !== undefined) record.removedByPlugin = true
            }
          }
        }

        // 附件减少时判断是不是“点 ×”导致的焦点掉落：chip 删除由订阅移除（removedByPlugin），不抢焦点；
        // rail 删除/无 record/claimed 时，如果焦点已在 body 或已卸载节点，再把键盘还给输入框。
        const previousIds = previousIdsRef.current
        previousIdsRef.current = currentIds
        if (previousIds !== null) {
          const removedIds = previousIds.filter((id) => !live.has(id))
          const editable = state !== null && state !== undefined
            && (state.phase === 'plain' || state.phase === 'claimed')
          if (removedIds.length > 0 && editable) {
            const allByPlugin = removedIds.every((id) => pluginRemoved.has(id))
            if (!allByPlugin) focusIfDetached(key, anchorRef.current)
          }
        }

        if (fresh.length === 0) return
        if (!sourceReady) return
        if (inputActions === null || inputActions === undefined
          || typeof inputActions.captureInsertion !== 'function') return
        const input = resolveSessionInput(key)
        if (input === null || input === undefined || typeof input.insertReference !== 'function') return
        const entry = registry.get(key)
        for (const id of fresh) {
          const base = (entry !== undefined && entry.labels.get(id)) || FALLBACK_LABEL
          const label = uniqueLabel(base, records)
          const ref = insertOneReference(input, inputActions, key, id, label, base)
          if (ref !== undefined) records.set(id, { ref, confirmed: false, removedByPlugin: false, label })
        }
      }, [state, sessionId, inputActions])

      const anchor = h('span', { ref: anchorRef, style: { display: 'none' }, 'aria-hidden': true })
      if (view === null) return anchor
      return h(React.Fragment, null, anchor, h(Lightbox, { view, onClose: close }))
    }

    /**
     * 引用编解码器：clipboardText 给复制/落盘，serialize 给模型侧标记。
     */
    const codec = {
      /**
       * 剪贴板/持久化投影：`@标签`。
       * @param {string} ref chip 引用原文。
       * @returns {string} 投影文本。
       */
      clipboardText(ref) {
        const parsed = parseRef(ref)
        if (parsed === undefined) return `@${FALLBACK_LABEL}`
        const entry = findEntry(parsed.a, parsed.s)
        const label = entry === undefined ? undefined : entry.labels.get(parsed.a)
        return `@${label || FALLBACK_LABEL}`
      },

      /**
       * 模型序列化：按当前附件顺序输出不可见标记，找不到附件时输出 0。
       * @param {string} ref chip 引用原文。
       * @returns {Promise<string>} 标记文本。
       */
      async serialize(ref) {
        const parsed = parseRef(ref)
        if (parsed === undefined) return stampOf(0)
        // 归属会话优先用渲染时记录的当前会话（迁移草稿后 ref 里的 s 可能是旧的）。
        const owner = refOwner.get(ref) ?? parsed.s
        const live = owner === undefined ? undefined : liveAttachmentIds(owner)
        if (live !== undefined) {
          const index = live.indexOf(parsed.a) + 1
          return index > 0 ? stampOf(index) : '［附件已移除］'
        }
        // 实时状态取不到就不猜序号：宁可发占位，也不把图指到别的附件上。
        return '［附件已移除］'
      },
    }

    /** `@` 源：不参与菜单，只为 codec 与 chip 预览存在。 */
    const source = {
      trigger: '@',
      name: SOURCE,
      candidates: async () => [],
      onPick: () => 'handled',
      codec,
      /**
       * 点击 chip：用当前 registry 里的 previewUrl 打开灯箱。
       * @param {any} session 会话投影（ClientSessionContext）。
       * @param {any} reference { ref, appearance }。
       * @returns {boolean} 是否打开。
       */
      openReference(session, reference) {
        try {
          const parsed = parseRef(reference === null || reference === undefined ? undefined : reference.ref)
          if (parsed === undefined) return false
          const fallback = session === null || session === undefined ? undefined : keyOf(session.sessionId)
          const entry = findEntry(parsed.a, parsed.s ?? fallback)
          const list = resolveAttachments(runtime.ctx, [parsed.a])
          const attachment = Array.isArray(list) ? list[0] : undefined
          if (attachment !== null && attachment !== undefined && attachment.kind === 'file'
            && attachment.file !== null && attachment.file !== undefined) {
            const file = attachment.file
            const name = typeof file.name === 'string' && file.name !== ''
              ? file.name
              : (entry === undefined ? FALLBACK_LABEL : (entry.labels.get(parsed.a) || FALLBACK_LABEL))
            if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
              const fileUrl = URL.createObjectURL(file)
              const revoke = () => { try { URL.revokeObjectURL(fileUrl) } catch (error) {} }
              // Node 测试环境里 setTimeout 会保持事件循环；浏览器里没有 unref，忽略即可。
              const scheduleRevoke = (delay = 60000) => {
                const timer = setTimeout(revoke, delay)
                if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
              }
              const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name)
              if (isPdf && typeof window !== 'undefined' && typeof window.open === 'function') {
                // noopener 会让 window.open 返回 null，不能拿返回值判断成功；先开窗再清 opener。
                const opened = window.open(fileUrl, '_blank')
                if (opened !== null && opened !== undefined) {
                  try { opened.opener = null } catch (error) {}
                  scheduleRevoke(10 * 60 * 1000)
                  return true
                }
              }
              if (typeof document !== 'undefined' && typeof document.createElement === 'function'
                && document.body !== null && document.body !== undefined
                && typeof document.body.appendChild === 'function') {
                const anchor = document.createElement('a')
                anchor.href = fileUrl
                anchor.download = name
                anchor.rel = 'noopener'
                document.body.appendChild(anchor)
                anchor.click()
                if (typeof anchor.remove === 'function') anchor.remove()
                scheduleRevoke()
                return true
              }
              revoke()
            }
            return false
          }
          if (entry === undefined) return false
          const url = entry.previews.get(parsed.a)
          if (typeof url !== 'string' || url === '') return false
          const sessionKey = keyOf(session === null || session === undefined ? undefined : session.sessionId) ?? parsed.s
          const open = sessionKey === undefined ? undefined : previewHosts.get(sessionKey)
          if (typeof open !== 'function') return false
          open(url, entry.labels.get(parsed.a) || FALLBACK_LABEL, parsed.a)
          return true
        } catch (error) {
          return false
        }
      },
    }

    /**
     * 注册覆盖层组件与输入源；任一步失败都不影响另一半。
     * @param {any} ctx 浏览器根上下文（Cordis）。
     */
    function apply(ctx) {
      runtime.ctx = ctx
      // 旧版本注入过“可选中小标签”的覆盖样式；热重载/升级时顺手清掉，避免残留。
      try {
        if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
          const stale = document.getElementById('dsh-inline-attachment-chip-style')
          if (stale !== null && stale !== undefined && typeof stale.remove === 'function') stale.remove()
        }
      } catch (error) {
        // 清理失败不影响输入。
      }

      // 等待槽位声明后再注册；不替换任何现有 slot，卸载即恢复原样。
      try {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'inline-attachments',
          order: 10,
        }, Overlay))
      } catch (error) {
        console.warn('[inline-attachments] overlay registration failed')
      }

      // 输入源：空 candidates 不参与 @ 菜单，只为 codec/openReference 存在。
      try {
        if (ctx.inputTriggers === undefined || ctx.inputTriggers === null
          || typeof ctx.inputTriggers.registerSource !== 'function') {
          sourceReady = false
          return
        }
        ctx.effect(() => {
          const dispose = ctx.inputTriggers.registerSource(source)
          sourceReady = true
          return () => {
            sourceReady = false
            dispose()
          }
        }, 'inline-attachments: source')
      } catch (error) {
        sourceReady = false
        console.warn('[inline-attachments] trigger source registration failed')
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions', 'conversation', 'inputTriggers']
    return module.exports
  },
})
