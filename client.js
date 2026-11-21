// dsh-unslop — Client half.
//
// One composer chip in the input row ("unslop  核心 2/4 ▾"), modelled on dsh-rust-anything's
// tool-surface chip. It reads and switches which mcp__unslop__* tools this session carries, via the
// Host half's authenticated routes (/unslop/api/{token,surface}). No sidebar page, just the toggle.
//
// The chip is a plain React component registered on the `conversation.input.left` slot; it never
// touches the DOM outside its own tree and uses the Harness theme tokens with plain fallbacks.

window.__ModuleLoader__.load({
  id: 'dsh-unslop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TOKEN_ROUTE = '/unslop/api/token'
    const SURFACE_ROUTE = '/unslop/api/surface'

    // Bearer bootstrap: the token route sits behind DSH connection admission + loopback, so no user
    // input is involved. A rotated token (plugin reload) shows up as one 401, which re-bootstraps.
    let tokenPromise = null
    function fetchToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(TOKEN_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`token route HTTP ${response.status}`))))
          .then((body) => {
            if (!body || typeof body.token !== 'string' || body.token.length < 16) throw new Error('token route returned no token')
            return body.token
          })
          .catch((error) => { tokenPromise = null; throw error })
      }
      return tokenPromise
    }
    function apiFetch(pathname, options = {}) {
      const request = (token) => fetch(pathname, {
        ...options,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(options.headers || {}), authorization: `Bearer ${token}` },
      })
      return fetchToken().then(request).then((response) => {
        if (response.status !== 401) return response
        tokenPromise = null
        return fetchToken().then(request)
      })
    }
    const getJson = (pathname) => apiFetch(pathname).then((response) => response.json())
    const postJson = (pathname, body) => apiFetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((response) => response.json())

    const TIERS = [['off', '关闭'], ['core', '核心'], ['all', '全部']]
    const labelOf = (tier) => { const found = TIERS.find((x) => x[0] === tier); return found ? found[1] : tier }

    function Chip() {
      // A throwing slot render disappears silently in the host; show the reason instead.
      try { return ChipInner() } catch (error) {
        return h('span', { style: { fontSize: '11px', color: '#e06060' } }, 'unslop: ' + String(error && error.message ? error.message : error))
      }
    }

    function ChipInner() {
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const load = React.useCallback(() => {
        getJson(SURFACE_ROUTE).then(setState).catch(() => setState({ surface: 'unknown' }))
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 20_000)
        return () => clearInterval(timer)
      }, [load])
      const surface = state && state.surface ? state.surface : 'all'
      const tools = state && (state.mcpTools || state.mcp) ? (state.mcpTools || state.mcp) : null
      const pick = (tier) => {
        setOpen(false)
        postJson(SURFACE_ROUTE, { surface: tier }).then(setState).catch(() => {})
      }
      return h('div', { className: 'dsh-us-chip-wrap' },
        h('button', {
          type: 'button',
          className: `dsh-us-chip${surface === 'off' ? ' is-off' : ' is-on'}${open ? ' is-open' : ''}`,
          title: 'unslop 工具面：决定这轮对话里 mcp__unslop__* 有多少个工具',
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: 'dsh-us-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-us-label' }, 'unslop'),
        h('span', { className: 'dsh-us-tier' }, labelOf(surface)),
        tools ? h('span', { className: 'dsh-us-count' }, `${tools.visible}/${tools.total}`) : null,
        h('span', { className: `dsh-us-caret${open ? ' is-open' : ''}`, 'aria-hidden': 'true' }, '▾')),
        open ? h('div', { className: 'dsh-us-menu' },
          TIERS.map(([tier, label]) => h('button', {
            key: tier,
            type: 'button',
            className: `dsh-us-item${tier === surface ? ' is-on' : ''}`,
            onClick: () => pick(tier),
          }, label))) : null)
    }

    const css = `
.dsh-us-chip-wrap { position: relative; display: inline-flex; }
.dsh-us-chip { appearance: none; -webkit-appearance: none; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2); box-shadow: none; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1;
  padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.dsh-us-chip:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-us-chip.is-on { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsh-us-chip.is-on .dsh-us-dot { background: var(--dsw-alias-state-warn-primary); }
.dsh-us-chip.is-off { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l2); opacity: .7; }
.dsh-us-chip.is-off .dsh-us-dot { background: var(--dsw-alias-state-idle-primary); }
.dsh-us-chip.is-open { background: var(--dsw-alias-bg-layer-2); }
.dsh-us-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }
.dsh-us-label { opacity: .85; }
.dsh-us-tier { font-weight: 600; }
.dsh-us-count { opacity: .7; font-variant-numeric: tabular-nums; }
.dsh-us-caret { font-size: 9px; opacity: .7; line-height: 1; transition: transform .12s ease; }
.dsh-us-caret.is-open { transform: rotate(180deg); }
.dsh-us-menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 40; min-width: 120px; padding: 5px;
  border-radius: 9px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: var(--dsh-surface, rgba(28,28,30,.98)); box-shadow: 0 8px 26px rgba(0,0,0,.35); display: flex; flex-direction: column; }
.dsh-us-item { font: inherit; font-size: 12px; text-align: left; padding: 6px 9px; border-radius: 6px;
  border: 0; background: transparent; color: inherit; cursor: pointer; }
.dsh-us-item:hover { background: color-mix(in srgb, currentColor 9%, transparent); }
.dsh-us-item.is-on { background: color-mix(in srgb, var(--dsh-accent, #e2862a) 20%, transparent); }
`

    return {
      inject: ['slots'],
      apply(ctx) {
        // The composer chip lives outside any page tree, so install the stylesheet once on the document.
        try {
          if (typeof document !== 'undefined' && !document.getElementById('dsh-unslop-styles')) {
            const style = document.createElement('style')
            style.id = 'dsh-unslop-styles'
            style.textContent = css
            document.head.appendChild(style)
          }
        } catch { /* non-DOM host */ }
        const slots = ctx.slots
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'dsh-unslop/surface',
          order: 88,
          label: () => 'unslop',
        }, Chip))
      },
    }
  },
})
