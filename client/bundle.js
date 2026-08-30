/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-dsh-sync",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
    /**
     * dsh-plugin-dsh-sync - Browser half.
     *
     * One React app for every surface (sidebar overlay + settings section).
     * All interactive controls are host primitives (@deepseek-ai/dsh-client-ui-
     * primitives); all colors come from the ui-theme `--dsw-*` token layers so
     * light/dark follows the shell; all copy comes from the locale registry
     * (`zh`/`en`) so switches render live. No hardcoded colors, no ad-hoc copy.
     * The client never sees the access token in cleartext — only `hasToken`.
     */

    // React is a loader platform module. Under plain Node (contract tests) a
    // minimal createElement/hook shim keeps the source loadable for assertions.
    let __React = null
    try { __React = require('react') } catch {}
    if (!__React || typeof __React.createElement !== 'function') {
      __React = {
        createElement(type, props, ...kids) {
          return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true || true) }
        },
        useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
        useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
      }
    }
    const { createElement: h, useState, useEffect, useMemo, useRef } = __React

    // Platform module — always present in the loader's seeded require table.
    // Under plain Node (tests) it is absent; a tagged-element shim keeps the
    // tree structurally testable while every real surface ships primitives.
    let P = null
    try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}
    let RDP = null
    try { RDP = require('react-dom') } catch {}

    // NOTE: no class components in this module. A `class X extends
    // React.Component` error boundary defined here silently killed rendering in
    // the plugin loader — render-time crashes are handled by the try/catch inside
    // SyncPage and recorded into globalThis.__skErrors instead.

    /** Idempotent stylesheet injection — .sk-overlay is position:fixed so
     *  mounting without it renders the panel invisibly at the end of <body>. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('dshsync-styles')) return
      const holder = document.createElement('div')
      holder.id = 'dshsync-styles'
      holder.style.display = 'none'
      holder.innerHTML = STYLE
      document.head.appendChild(holder)
    }

    const prim = (name) => P && P[name]
      ? P[name]
      : function Shim(props) {
          const { children, ...rest } = props
          const el = document.createElement('button')
          return h('button', { ...rest, 'data-p-shim': name }, children)
        }

    // Sessions service (client runtime): opens the conflict run's conversation
    // in the real UI. Resolved through dynamic ctx.inject; absence degrades the
    // 打开对话 button to hidden.
    let sessionsApi = null
    const sessionsSvc = () => sessionsApi

    // ── Locale ───────────────────────────────────────────────────────────────

    const NS = 'dshSync'

    const ZH = {
      title: '同步',
      close: '关闭',
      syncNow: '立即同步',
      syncing: '同步中，可能需要一分钟…',
      syncDone: '同步完成',
      syncFailed: '同步失败',
      settings: '同步设置',
      save: '保存',
      saved: '设置已保存',
      repoUrlLabel: '仓库地址',
      branchLabel: '分支',
      instanceLabel: '实例 ID',
      lastSyncLabel: '上次同步',
      dirLabel: '本地镜像目录',
      gitMissing: '未检测到 git',
      repoMissing: '尚未初始化，点「立即同步」',
      notConfigured: '未配置仓库地址或访问令牌',
      tokenLabel: 'GitCode 访问令牌',
      tokenConfigured: '已配置',
      tokenHint: '需有目标私有仓库的读写权限',
      clearToken: '清除',
      autoSyncLabel: '定时自动同步',
      syncOnStartupLabel: '启动时同步',
      intervalLabel: '同步间隔（分钟）',
      conflictModeLabel: '冲突处理',
      conflictModeAi: 'AI 处理（推荐）',
      conflictModeManual: '人工网页合并',
      conflictModeHint: '两台机器改了同一文件时：AI 模式弹出按钮由 AI 自动解决；人工模式 PR 挂起等你去 gitcode.com 合并',
      toggleSkills: '技能 skills',
      toggleSessions: '会话 sessions',
      toggleSettings: '设置 settings',
      togglePlugins: '插件 plugins',
      groupHint: '勾选要同步的类别（取消勾选不同步），首次开启会全量上传',
      conflictTitle: '解决同步冲突',
      conflictHint: '检测到未合并的同步 PR（两台机器改了同一文件）。点击下方按钮，AI 会读取本机令牌、分析两边改动、解决冲突并合并 PR。',
      conflictPending: '有未解决的冲突 PR',
      resolveBtn: 'AI 解决冲突',
      openChat: '打开对话',
      running: '执行中…（可能需要几分钟）',
      runDone: '解决完成',
      runFailed: '执行失败',
      outputLabel: '输出',
      noConflict: '当前没有待解决的冲突',
      repoUrlPlaceholder: 'https://gitcode.com/<owner>/<repo>.git',
      privateWarn: '检测到公共仓库：dsh-sync 会同步含凭证的 settings.yaml，必须用私有仓库',
      operationFailed: '操作失败',
    }

    const EN = {
      title: 'Sync',
      close: 'Close',
      syncNow: 'Sync now',
      syncing: 'Syncing, may take a minute…',
      syncDone: 'Sync complete',
      syncFailed: 'Sync failed',
      settings: 'Sync Settings',
      save: 'Save',
      saved: 'Settings saved',
      repoUrlLabel: 'Repository URL',
      branchLabel: 'Branch',
      instanceLabel: 'Instance ID',
      lastSyncLabel: 'Last sync',
      dirLabel: 'Local mirror dir',
      gitMissing: 'git not found',
      repoMissing: 'Not initialized — hit Sync now',
      notConfigured: 'Repo URL or access token not configured',
      tokenLabel: 'GitCode access token',
      tokenConfigured: 'configured',
      tokenHint: 'Needs read/write on the target private repo',
      clearToken: 'Clear',
      autoSyncLabel: 'Auto sync on schedule',
      syncOnStartupLabel: 'Sync on startup',
      intervalLabel: 'Interval (minutes)',
      conflictModeLabel: 'Conflict handling',
      conflictModeAi: 'AI resolve (recommended)',
      conflictModeManual: 'Manual web merge',
      conflictModeHint: 'When two machines edit the same file: AI mode shows a button the AI resolves; manual mode leaves the PR open for you to merge on gitcode.com',
      toggleSkills: 'Skills',
      toggleSessions: 'Sessions',
      toggleSettings: 'Settings',
      togglePlugins: 'Plugins',
      groupHint: 'Toggle categories to sync (off = skipped); first enable uploads the full set',
      conflictTitle: 'Resolve sync conflict',
      conflictHint: 'An unmerged sync PR exists (two machines edited the same file). Click below: the AI reads the local token, analyzes both sides, resolves the conflict and merges the PR.',
      conflictPending: 'Unresolved conflict PR',
      resolveBtn: 'AI resolve conflict',
      openChat: 'Open chat',
      running: 'Running… (may take minutes)',
      runDone: 'Resolved',
      runFailed: 'Run failed',
      outputLabel: 'Output',
      noConflict: 'No pending conflict',
      repoUrlPlaceholder: 'https://gitcode.com/<owner>/<repo>.git',
      privateWarn: 'Public repo detected: dsh-sync mirrors credentials in settings.yaml, a private repo is required',
      operationFailed: 'Operation failed',
    }

    // ── Pure helpers ────────────────────────────────────────────────────────

    function substituteParams(template, params) {
      let out = template
      for (const [key, value] of Object.entries(params)) {
        out = out.split(`{{${key}}}`).join(String(value))
      }
      return out
    }

    const API = '/dsh-sync/api'

    function formatTime(iso) {
      if (!iso) return '-'
      try {
        const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
        if (days > 30) return new Date(iso).toLocaleDateString()
        if (days > 0) return days + 'd'
        const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
        if (hours > 0) return hours + 'h'
        const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
        if (minutes > 0) return minutes + 'm'
        return 'now'
      } catch { return '-' }
    }

    // ── Token-based stylesheet (light/dark adaptive by construction) ────────

    const STYLE = `<style>
    .sk-page{position:relative;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}
    .sk-overlay{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base);overflow:auto;padding:20px 26px}
    .sk-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .sk-body{display:flex;flex-direction:column;gap:14px}
    .sk-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .sk-spacer{flex:1}
    .sk-hint{color:var(--dsw-alias-label-secondary)}
    .sk-dir{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13,12px)}
    .sk-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
    .sk-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
    .sk-tag.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
    .sk-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
    .sk-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
    .sk-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
    .sk-meta div{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;min-width:0}
    .sk-toggles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
    .sk-toggle{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}
    .sk-toggle.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
    .sk-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:36px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}
    .sk-loading{padding:48px;text-align:center;color:var(--dsw-alias-label-secondary)}
    .sk-spin{width:30px;height:30px;margin:0 auto 10px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));animation:dshspin .7s linear infinite}
    @keyframes dshspin{to{transform:rotate(360deg)}}
    .sk-dlg-backdrop{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
    .sk-dlg{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;min-width:340px;max-width:640px;max-height:82vh;overflow:auto;padding:18px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
    .sk-dlg h3{margin:0 0 12px;font-size:15px}
    .sk-dlg-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    .sk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}
    .sk-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
    .sk-btn:disabled{opacity:.5;cursor:not-allowed}
    .sk-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
    .sk-btn-primary:hover{filter:brightness(1.08);background:var(--dsw-alias-state-business-primary)}
    .sk-btn-sm{min-height:28px;padding:4px 12px;font-size:12.5px;min-width:64px}
    .sk-btn-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
    .sk-input{min-height:32px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none;box-sizing:border-box}
    .sk-input:focus{border-color:var(--dsw-alias-state-business-primary)}
    .sk-input::placeholder{color:var(--dsw-alias-label-tertiary)}
    .sk-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}
    </style>`

    // ── Fetch layer ─────────────────────────────────────────────────────────

    async function getJson(url) {
      const r = await fetch(url)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }

    // ── Small building blocks ────────────────────────────────────────────────

    const Tag = ({ tone, children }) =>
      h('span', { className: 'sk-tag' + (tone ? ' ' + tone : '') }, children)

    const Spinner = ({ label }) =>
      h('div', { className: 'sk-loading' },
        h('div', { className: 'sk-spin' }),
        h('div', null, label))

    const Empty = ({ children }) => h('div', { className: 'sk-empty' }, children)

    function ButtonLite({ primary, danger, small, children, ...rest }) {
      const cls = 'sk-btn' + (primary ? ' sk-btn-primary' : '') + (danger ? ' sk-btn-danger' : '') + (small ? ' sk-btn-sm' : '')
      if (prim('Button')) {
        return h(P.Button, { variant: primary ? 'primary' : (danger ? 'primary' : 'outline'), size: small ? 'sm' : 'md', className: cls, ...rest }, children)
      }
      return h('button', { className: cls, ...rest }, children)
    }

    /** In-page dialog: rendered INSIDE the fullscreen overlay's stacking context
     *  so it can never fall behind it. */
    function SkDialog({ title, onClose, footer, children, wide }) {
      return h('div', { className: 'sk-dlg-backdrop', onClick: onClose },
        h('div', { className: 'sk-dlg', style: wide ? { maxWidth: 920, width: '92vw' } : undefined,
            onClick: e => e.stopPropagation() },
          title && h('h3', null, title),
          children,
          footer && h('div', { className: 'sk-dlg-foot' }, footer)))
    }

    function InToast({ text }) {
      return h('div', { className: 'sk-toast' }, text)
    }

    // ── Conflict-resolution dialog: AI action button + streamed output ──
    //    (mirrors the skills-management share-run polling pattern)

    function ConflictDialog({ t, pending, onClose, onToast }) {
      const [job, setJob] = useState(null)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        if (job === null || job.status !== 'running') return
        const timer = setInterval(() => {
          getJson(API + '/conflict/run?id=' + encodeURIComponent(job.jobId))
            .then(d => setJob(prev => prev && { ...prev, status: d.status, output: d.output || '', code: d.code, sessionId: d.sessionId || prev.sessionId }))
            .catch(() => {})
        }, 2000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, [job && job.status])
      const doRun = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/conflict/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch: pending && pending.branch, prNumber: pending && pending.prNumber }),
          })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          setJob({ jobId: d.jobId, status: 'running', output: '', code: null })
        } catch (e) { onToast(t('runFailed') + ': ' + e.message) } finally { setBusy(false) }
      }
      const row = (label, value) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
        h('span', { className: 'sk-dir' }, label), h('span', { className: 'sk-hint', style: { wordBreak: 'break-all', textAlign: 'right' } }, value))
      return h(SkDialog, { title: t('conflictTitle'), onClose, wide: true },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 380 } },
          h('div', { className: 'sk-hint' }, t('conflictHint')),
          pending && h('div', null,
            row('PR', '#' + (pending.prNumber || '-')),
            row('Branch', pending.branch || '-')),
          job !== null && h('div', null,
            h('div', { className: 'sk-dir', style: { margin: '4px 0' } },
              t('outputLabel') + ' · ' + (job.status === 'running' ? t('running') : job.status === 'done' ? t('runDone') : t('runFailed') + (job.code != null ? ' (' + job.code + ')' : ''))),
            h('pre', { className: 'sk-card', style: { maxHeight: 220, margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, overflow: 'auto' } },
              job.output || '…')),
          h('div', { className: 'sk-dlg-foot', style: { marginTop: 0 } },
            job !== null && job.sessionId && sessionsSvc() && h(ButtonLite, { onClick: () => { if (openRunSession(job.sessionId)) onClose() } }, t('openChat')),
            h(ButtonLite, { primary: true, disabled: busy || (job !== null && job.status === 'running'), onClick: doRun },
              job !== null && job.status === 'running' ? t('running') : t('resolveBtn')))))
    }

    // ── Sync settings + status dialog ──

    function SyncSettingsDialog({ t, onClose, onToast, onSynced }) {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [repoUrl, setRepoUrl] = useState('')
      const [branch, setBranch] = useState('')
      const [token, setToken] = useState('')
      const [intervalMinutes, setIntervalMinutes] = useState(30)
      const [autoSync, setAutoSync] = useState(true)
      const [syncOnStartup, setSyncOnStartup] = useState(false)
      const [conflictMode, setConflictMode] = useState('ai')
      const [g, setG] = useState({ skills: true, sessions: false, settings: true, plugins: true })

      const refresh = () => getJson(API + '/status').then(d => {
        setStatus(d)
        setRepoUrl(d.repoUrl)
        setBranch(d.branch)
        setIntervalMinutes(d.intervalMinutes)
        setAutoSync(d.autoSync)
        setSyncOnStartup(d.syncOnStartup)
        setConflictMode(d.conflictMode)
        setG({ skills: d.syncSkills, sessions: d.syncSessions, settings: d.syncSettings, plugins: d.syncPlugins })
      }).catch(() => {})
      useEffect(() => { refresh() }, [])

      const doSync = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          onToast(t('syncDone'))
          onSynced && onSynced()
          refresh()
        } catch (e) { onToast(t('syncFailed') + ': ' + e.message) } finally { setBusy(false) }
      }
      const putSettings = async (patch) => {
        const r = await fetch(API + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
        return d
      }
      const doSave = async () => {
        try {
          const patch = { repoUrl, branch, intervalMinutes, autoSync, syncOnStartup, conflictMode, syncSkills: g.skills, syncSessions: g.sessions, syncSettings: g.settings, syncPlugins: g.plugins }
          if (token !== '') patch.token = token
          await putSettings(patch)
          setToken('')
          onToast(t('saved'))
          refresh()
        } catch (e) { onToast(e.message || t('operationFailed')) }
      }
      const doClearToken = async () => {
        try { await putSettings({ token: null }); onToast(t('saved')); refresh() }
        catch (e) { onToast(e.message || t('operationFailed')) }
      }

      const row = (label, value) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
        h('span', { className: 'sk-dir' }, label), h('span', { className: 'sk-hint', style: { wordBreak: 'break-all', textAlign: 'right' } }, value))
      const toggle = (key, label) => h('label', { key, className: 'sk-toggle' + (g[key] ? ' on' : '') },
        h('input', { type: 'checkbox', checked: g[key], onChange: e => setG(prev => ({ ...prev, [key]: e.target.checked })) }), label)

      return h(SkDialog, { title: t('settings'), onClose, wide: true },
        h('div', { style: { minWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 } },
          status === null
            ? h(Spinner, { label: '…' })
            : [
              status.gitAvailable === false && h('div', { className: 'sk-tag danger' }, t('gitMissing')),
              h('div', null,
                row(t('instanceLabel'), status.instanceId || '-'),
                row(t('repoUrlLabel'), status.repoUrl || '-'),
                row(t('branchLabel'), status.branch || '-'),
                row(t('dirLabel'), status.dir),
                row(t('lastSyncLabel'), status.lastSyncAt ? formatTime(status.lastSyncAt) : t('repoMissing'))),
              h('div', { className: 'sk-meta' },
                h('div', null, h('div', { className: 'sk-dir' }, t('toggleSkills')), h('div', { className: 'sk-hint' }, g.skills ? '✓' : '✗')),
                h('div', null, h('div', { className: 'sk-dir' }, t('toggleSessions')), h('div', { className: 'sk-hint' }, g.sessions ? '✓' : '✗')),
                h('div', null, h('div', { className: 'sk-dir' }, t('toggleSettings')), h('div', { className: 'sk-hint' }, g.settings ? '✓' : '✗')),
                h('div', null, h('div', { className: 'sk-dir' }, t('togglePlugins')), h('div', { className: 'sk-hint' }, g.plugins ? '✓' : '✗'))),
              h('div', null,
                h('div', { className: 'sk-dir', style: { margin: '4px 0' } }, t('groupHint')),
                h('div', { className: 'sk-toggles' },
                  toggle('skills', t('toggleSkills')), toggle('sessions', t('toggleSessions')),
                  toggle('settings', t('toggleSettings')), toggle('plugins', t('togglePlugins')))),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  h('input', { type: 'checkbox', checked: autoSync, onChange: e => setAutoSync(e.target.checked) }), t('autoSyncLabel')),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  h('input', { type: 'checkbox', checked: syncOnStartup, onChange: e => setSyncOnStartup(e.target.checked) }), t('syncOnStartupLabel')),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  t('intervalLabel'), h('input', { className: 'sk-input', type: 'number', min: 5, value: intervalMinutes, onChange: e => setIntervalMinutes(Math.max(1, Number(e.target.value) || 30)), style: { width: 80 } }))),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('input', { className: 'sk-input', value: repoUrl, onChange: e => setRepoUrl(e.target.value), placeholder: t('repoUrlPlaceholder'), style: { width: '100%' } }),
                h('input', { className: 'sk-input', value: branch, onChange: e => setBranch(e.target.value), placeholder: t('branchLabel'), style: { width: '100%' } }),
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', { className: 'sk-input', type: 'password', value: token, onChange: e => setToken(e.target.value),
                    placeholder: status && status.hasToken ? `${t('tokenLabel')} · ${t('tokenConfigured')}` : t('tokenLabel'), style: { flex: 1 } }),
                  status && status.hasToken && h(ButtonLite, { onClick: doClearToken }, t('clearToken'))),
                h('div', { className: 'sk-dir' }, t('tokenHint'))),
              h('div', null,
                h('div', { className: 'sk-dir', style: { margin: '4px 0' } }, t('conflictModeLabel')),
                h('div', { className: 'sk-toggles' },
                  h('label', { className: 'sk-toggle' + (conflictMode === 'ai' ? ' on' : '') },
                    h('input', { type: 'radio', checked: conflictMode === 'ai', onChange: () => setConflictMode('ai') }), t('conflictModeAi')),
                  h('label', { className: 'sk-toggle' + (conflictMode === 'manual' ? ' on' : '') },
                    h('input', { type: 'radio', checked: conflictMode === 'manual', onChange: () => setConflictMode('manual') }), t('conflictModeManual'))),
                h('div', { className: 'sk-dir', style: { marginTop: 4 } }, t('conflictModeHint'))),
              h('div', { className: 'sk-dlg-foot', style: { marginTop: 4 } },
                h(ButtonLite, { onClick: doSave }, t('save')),
                h(ButtonLite, { primary: true, onClick: doSync }, busy ? t('syncing') : t('syncNow')))]))
    }

    // ── App root ─────────────────────────────────────────────────────────────

    function SyncPage({ t, onClose, embedded }) {
      const [status, setStatus] = useState(null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [conflictOpen, setConflictOpen] = useState(false)
      const [toastText, setToastText] = useState(null)
      const [busy, setBusy] = useState(false)
      const refresh = () => getJson(API + '/status').then(setStatus).catch(() => {})
      useEffect(() => { refresh(); const timer = setInterval(refresh, 15000); if (typeof timer.unref === 'function') timer.unref(); return () => clearInterval(timer) }, [])

      const doSync = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          setToastText(t('syncDone'))
          setTimeout(() => setToastText(null), 2600)
        } catch (e) { setToastText(t('syncFailed') + ': ' + e.message); setTimeout(() => setToastText(null), 4000) }
        finally { setBusy(false); refresh() }
      }

      let body
      try {
        const row = (label, value) => h('div', null, h('div', { className: 'sk-dir' }, label), h('div', { className: 'sk-hint', style: { wordBreak: 'break-all' } }, value))
        body = status === null
          ? h(Spinner, { label: '…' })
          : h('div', { className: 'sk-body' },
              status.gitAvailable === false && h('div', { className: 'sk-tag danger' }, t('gitMissing')),
              (!status.repoUrl || !status.hasToken) && h('div', { className: 'sk-tag accent' }, t('notConfigured')),
              status.pendingConflict && h('div', { className: 'sk-card', style: { borderColor: 'var(--dsw-alias-state-error-primary)' } },
                h('div', { className: 'sk-head' },
                  h(Tag, { tone: 'danger' }, t('conflictPending')),
                  h('span', { className: 'sk-spacer' }),
                  h(ButtonLite, { primary: true, small: true, onClick: () => setConflictOpen(true) }, t('resolveBtn'))),
                h('div', { className: 'sk-hint' }, t('conflictHint'))),
              h('div', { className: 'sk-card' },
                h('div', { className: 'sk-head' },
                  h('span', { className: 'sk-dir' }, t('instanceLabel')),
                  h('span', { className: 'sk-hint' }, status.instanceId || '-'),
                  h('span', { className: 'sk-spacer' }),
                  status.syncing && h(Tag, { tone: 'accent' }, t('syncing'))),
                h('div', { className: 'sk-meta' },
                  row(t('repoUrlLabel'), status.repoUrl || '-'),
                  row(t('branchLabel'), status.branch || '-'),
                  row(t('dirLabel'), status.dir),
                  row(t('lastSyncLabel'), status.lastSyncAt ? formatTime(status.lastSyncAt) : t('repoMissing'))),
                h('div', { className: 'sk-toggles', style: { marginTop: 4 } },
                  h('span', { className: 'sk-toggle' + (status.syncSkills ? ' on' : '') }, t('toggleSkills')),
                  h('span', { className: 'sk-toggle' + (status.syncSessions ? ' on' : '') }, t('toggleSessions')),
                  h('span', { className: 'sk-toggle' + (status.syncSettings ? ' on' : '') }, t('toggleSettings')),
                  h('span', { className: 'sk-toggle' + (status.syncPlugins ? ' on' : '') }, t('togglePlugins')))),
              h('div', { className: 'sk-toolbar' },
                h(ButtonLite, { onClick: () => setSettingsOpen(true) }, t('settings')),
                h('span', { className: 'sk-spacer' }),
                h(ButtonLite, { primary: true, disabled: busy || status.syncing, onClick: doSync }, busy ? t('syncing') : t('syncNow'))))
      } catch (renderErr) {
        ;(globalThis.__skErrors = globalThis.__skErrors || []).push('body: ' + (renderErr && renderErr.message))
        body = h('div', { className: 'sk-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } },
          '\u26A0\uFE0F ' + String((renderErr && renderErr.message) || renderErr))
      }

      return h('div', { className: 'sk-page' + (embedded ? '' : ' sk-overlay') },
        !embedded && h('div', { className: 'sk-head' },
          h('span', { className: 'sk-dir', style: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h('span', { className: 'sk-spacer' }),
          h(ButtonLite, { onClick: () => onClose && onClose() }, t('close'))),
        h('div', { className: 'sk-body' }, body),
        settingsOpen && h(SyncSettingsDialog, {
          t, onClose: () => setSettingsOpen(false),
          onToast: (text) => { setToastText(text); setTimeout(() => setToastText(null), 3000) },
          onSynced: () => refresh(),
        }),
        conflictOpen && status && status.pendingConflict && h(ConflictDialog, {
          t, pending: status.pendingConflict,
          onClose: () => setConflictOpen(false),
          onToast: (text) => { setToastText(text); setTimeout(() => setToastText(null), 3000) },
        }),
        toastText && h(InToast, { text: toastText }),
      )
    }

    // ── Slot entries ─────────────────────────────────────────────────────────

    function footerStyle() {
      return { display: 'inline-flex', alignItems: 'center', gap: 6, margin: '4px 10px', padding: '8px 10px',
        border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit', fontSize: 13, cursor: 'pointer', width: 'calc(100% - 20px)', textAlign: 'left' }
    }

    /** Panel state lives OUTSIDE React: sidebar churn remounts slot entries,
     *  and any state kept in them is torn down with them. */
    const panelStore = {
      open: false,
      listeners: new Set(),
      set(v) { panelStore.open = v; for (const fn of panelStore.listeners) fn(v) },
      subscribe(fn) { panelStore.listeners.add(fn); return () => panelStore.listeners.delete(fn) },
    }

    function openRunSession(sessionId) {
      try {
        const svc = sessionsSvc()
        if (svc && typeof svc.open === 'function') svc.open(sessionId)
      } catch {}
      panelStore.set(false)
      return true
    }

    function FooterSlotComponent(props) {
      const [open, setOpen] = useState(panelStore.open)
      useEffect(() => panelStore.subscribe(setOpen), [])
      useEffect(ensureStyles, [])
      const t = props.__t
      const labelText = t ? t('title') : 'Sync'
      const wide = props.wide !== false
      return h('span', { style: { display: 'contents' } },
        h('button', { title: labelText, 'aria-label': labelText, onClick: () => panelStore.set(!panelStore.open), style: footerStyle() },
          '\u{1F504}',
          wide ? ' ' + labelText : ''),
        open && (() => {
          const page = h(SyncPage, { t, embedded: false, onClose: () => panelStore.set(false) })
          if (RDP && typeof RDP.createPortal === 'function' && typeof document !== 'undefined') {
            return RDP.createPortal(page, document.body)
          }
          return page
        })())
    }

    function SettingsSlotComponent(props) {
      useEffect(ensureStyles, [])
      return h(SyncPage, { t: props.__t, embedded: true })
    }

    // ── Plugin plane contract ────────────────────────────────────────────────

    const CLIENT_NAME = 'dsh-plugin-dsh-sync'

    module.exports = {
      name: CLIENT_NAME,
      inject: ['slots', 'locale'],
      __internals: { NS, ZH, EN, substituteParams, formatTime },
      __boot(container, opts = {}) {
        ensureStyles()
        let t = opts.t || ((key, vars) => {
          let out = EN[key] ?? key
          if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
          return out
        })
        const root = require('react-dom/client').createRoot(container)
        root.render(h(SyncPage, { t, embedded: !!opts.embedded }))
        return root
      },
      apply(ctx) {
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['sessions'], (scope) => {
              const svc = scope && scope.sessions
              if (svc && typeof svc.open === 'function') sessionsApi = svc
            })
          }
        } catch {}
        let t = (key, vars) => {
          let out = EN[key] ?? key
          if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
          return out
        }
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, 'zh', ZH)
            ctx.locale.register(NS, 'en', EN)
            const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
            if (bound) {
              t = (key, vars) => {
                let out = bound(key) || key
                if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
                return out
              }
              globalThis.__dshSyncLocaleLive = true
            }
          }
        } catch (e) { try { console.error('[dsh-sync] locale init:', e) } catch {} }
        ctx.effect(() => {
          try {
            ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
              name: 'sidebar.footer.action',
              id: CLIENT_NAME,
              order: 60,
              locale: NS,
              label: () => t('title'),
              inject: () => ({ t }),
            }, function FooterSlot(apiProps) {
              return h(FooterSlotComponent, { __t: t, wide: apiProps && apiProps.wide })
            }))
          } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('footer:' + (e && e.message)); throw e }
        }, 'dsh-sync: sidebar footer action')
        ctx.effect(() => {
          try {
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 95,
              locale: NS,
              label: () => t('title'),
              inject: () => ({}),
            }, function SettingsSectionSlot() {
              return h(SettingsSlotComponent, { __t: t })
            }))
          } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('settings:' + (e && e.message)); throw e }
        }, 'dsh-sync: settings section')
      },
    }

    return module.exports
  }
})
