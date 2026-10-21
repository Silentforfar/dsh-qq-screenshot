window.__ModuleLoader__.load({
  id: '@silentforfar/dsh-qq-screenshot',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const NS = 'qqScreenshot'
    const COMMAND_LINE = '/screenshot'

    const zh = {
      'button.title': 'QQ 截图',
      'button.aria': '用 QQ 截图工具截取屏幕区域',
      'busy': '正在等待 QQ 截图…',
      'saved': '截图已保存：{name}',
      'inserted': '截图路径已写入输入框',
      'editorBusy': '输入框正忙，截图路径未写入',
      'unknownCommand': '截图命令没有执行',
      'failed': '截图失败：{message}',
      'draftPrefix': '看看这张截图：',
    }

    const en = {
      'button.title': 'QQ screenshot',
      'button.aria': 'Capture a screen region with QQ screenshot',
      'busy': 'Waiting for QQ screenshot…',
      'saved': 'Screenshot saved: {name}',
      'inserted': 'Screenshot path inserted into the composer',
      'editorBusy': 'The composer is busy; the screenshot path was not inserted',
      'unknownCommand': 'The screenshot command did not run',
      'failed': 'Screenshot failed: {message}',
      'draftPrefix': 'Take a look at this screenshot: ',
    }

    const CSS = [
      '.dsh-qq-shot{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-qq-shot__button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'transition:background-color 120ms ease,color 120ms ease}',
      '.dsh-qq-shot__button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-qq-shot__button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-qq-shot__button:disabled{opacity:.55;cursor:default}',
      '.dsh-qq-shot__note{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-qq-shot__note[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
      '@keyframes dsh-qq-shot-spin{to{transform:rotate(360deg)}}',
      '.dsh-qq-shot__spin{animation:dsh-qq-shot-spin 900ms linear infinite}',
    ].join('')

    function captureIcon() {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 8.5V6a2 2 0 0 1 2-2h2.5' }),
        h('path', { d: 'M15.5 4H18a2 2 0 0 1 2 2v2.5' }),
        h('path', { d: 'M20 15.5V18a2 2 0 0 1-2 2h-2.5' }),
        h('path', { d: 'M8.5 20H6a2 2 0 0 1-2-2v-2.5' }),
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
      )
    }

    function spinnerIcon() {
      return h(
        'svg',
        {
          className: 'dsh-qq-shot__spin',
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3a9 9 0 1 0 9 9' }),
      )
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    function createButton(ctx, t) {
      return function ScreenshotButton(props) {
        const { sessionId, inputActions } = props
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)

        React.useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), 6000)
          return () => clearTimeout(timer)
        }, [notice])

        const run = async () => {
          if (busy) return
          setBusy(true)
          setNotice(null)
          try {
            const answer = await ctx.remote.commands.execute(sessionId, COMMAND_LINE, [])
            if (!answer.ok) throw new Error(answer.error?.message ?? 'command failed')
            const execution = answer.value
            if (execution === undefined || execution === null) throw new Error(t('unknownCommand'))
            if (execution.result.kind !== 'success') throw new Error(execution.result.text)

            const text = execution.result.text ?? ''
            const match = /([A-Za-z]:\\[^\r\n]+)/.exec(text)
            if (match === null || inputActions === undefined) {
              setNotice({ error: false, text: t('saved', { name: text.replace(/^.*[\\/]/, '') }) })
              return
            }

            const filePath = match[1].trim()
            const inserted = inputActions.insertText(
              `${t('draftPrefix')}${filePath}`,
              inputActions.captureInsertion(),
            )
            setNotice(
              inserted
                ? { error: false, text: t('inserted') }
                : { error: true, text: t('editorBusy') },
            )
          } catch (error) {
            setNotice({ error: true, text: t('failed', { message: messageOf(error) }) })
          } finally {
            setBusy(false)
          }
        }

        return h(
          'div',
          { className: 'dsh-qq-shot' },
          h('style', null, CSS),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-qq-shot__button',
              title: busy ? t('busy') : t('button.title'),
              'aria-label': t('button.aria'),
              disabled: busy,
              onMouseDown: (event) => event.preventDefault(),
              onClick: run,
            },
            busy ? spinnerIcon() : captureIcon(),
          ),
          notice === null
            ? null
            : h(
                'span',
                {
                  className: 'dsh-qq-shot__note',
                  'data-error': notice.error ? 'true' : 'false',
                  role: 'status',
                },
                notice.text,
              ),
        )
      }
    }

    /** Services this browser module needs before it activates. */
    const inject = ['slots', 'locale', 'remote', 'remote.commands']

    /**
     * Mount the QQ screenshot button in the composer tool row.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qq-screenshot: dictionaries')
      const t = ctx.locale.bind(NS)
      const Button = createButton(ctx, t)
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register({ name: 'conversation.input.left', id: 'qq-screenshot', order: 40 }, Button),
      )
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
