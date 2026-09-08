/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: "@weibaohui/dsh-sync",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
    /**
     * dsh-plugin-dsh-sync - Browser half.
     *
     * Single surface: the host settings page section. (The sidebar footer entry
     * was removed by user decision — settings is the only entrance.) All
     * interactive controls are host primitives (@deepseek-ai/dsh-client-ui-
     * primitives); all colors come from the ui-theme `--dsw-*` token layers so
     * light/dark follows the shell; all copy comes from the locale registry
     * (`zh`/`en`). The client never sees the access token in cleartext — only
     * `hasToken`.
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

    // NOTE: no class components in this module. A `class X extends
    // React.Component` error boundary defined here silently killed rendering in
    // the plugin loader — render-time crashes are handled by the try/catch inside
    // SettingsSection and recorded into globalThis.__skErrors instead.

    /** Idempotent stylesheet injection. */
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
      syncNow: '立即同步',
      syncing: '同步中，可能需要一分钟…',
      syncDone: '同步完成',
      syncFailed: '同步失败',
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
      groupHint: '勾选要同步的类别，再为每类选策略',
      strategyBackup: '备份 · 各机独立',
      strategyUnion: '并集 · 冲突交 AI',
      strategyRemote: '覆盖 · 远端为准',
      strategyLocal: '覆盖 · 本地为准',
      strategyHint: '备份=云上各存各的（backup/实例ID/），本地永不被覆盖；并集=新增都收、双方改动交 AI；远端为准=本地只读镜像；本地为准=只推不拉',
      snapshotTitle: '快照',
      snapshotNow: '立即快照',
      snapshotNamePlaceholder: '快照名（可选）',
      snapshotCloud: '上传到云端 git',
      snapshotAutoLabel: '每天自动快照',
      snapshotSkillsLabel: '快照含技能',
      snapshotKeepLabel: '本地保留份数',
      snapshotHint: '快照优先存本地：滚动保留、超窗真删除真释放；勾了云端的才会写进 git 永久存档；恢复前会自动把当前状态再拍一份。',
      snapshotEmpty: '还没有快照',
      snapshotInCloud: '已上云',
      snapshotLocalOnly: '仅本地',
      snapshotRestore: '恢复',
      snapshotBusy: '快照处理中…',
      restoreDone: '已恢复（当前状态已先拍快照），同步已触发',
      conflictTitle: '解决同步冲突',
      conflictHint: '检测到未合并的同步 PR（两台机器改了同一文件）。点击下方按钮，AI 会读取本机令牌、分析两边改动、解决冲突并合并 PR。',
      conflictPending: '有未解决的冲突 PR',
      resolveBtn: 'AI 解决冲突',
      alignBtn: 'AI 智能对齐',
      alignTitle: 'AI 智能对齐',
      alignHint: '先自动拉回远端新增内容（不覆盖本机改动），再由 AI 语义合并两边都改过的文件；动手前自动备份本机文件，合并后自动推送，仍冲突的 PR 会顺手解掉。',
      alignFiles: '待语义合并文件',
      alignNoFiles: '无双方改动——确定性同步已处理全部差异',
      alignBackup: '备份目录',
      reconcileLine: '远端回填 {applied} 项 · 待 AI 对齐 {both} 项',
      openChat: '打开对话',
      running: '执行中…（可能需要几分钟）',
      runDone: '解决完成',
      runFailed: '执行失败',
      outputLabel: '输出',
      repoUrlPlaceholder: 'https://gitcode.com/<owner>/<repo>.git',
      operationFailed: '操作失败',
    }

    const EN = {
      title: 'Sync',
      syncNow: 'Sync now',
      syncing: 'Syncing, may take a minute…',
      syncDone: 'Sync complete',
      syncFailed: 'Sync failed',
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
      groupHint: 'Toggle a category, then pick its strategy',
      strategyBackup: 'Backup · per-machine',
      strategyUnion: 'Union · AI resolves',
      strategyRemote: 'Overwrite · remote wins',
      strategyLocal: 'Overwrite · local wins',
      strategyHint: 'Backup = each machine stores its own (backup/<id>/), local never overwritten; Union = collect all adds, both-side edits go to AI; remote wins = local read-only mirror; local wins = push-only',
      snapshotTitle: 'Snapshots',
      snapshotNow: 'Snapshot now',
      snapshotNamePlaceholder: 'snapshot name (optional)',
      snapshotCloud: 'Upload to cloud git',
      snapshotAutoLabel: 'Daily auto snapshot',
      snapshotSkillsLabel: 'Include skills',
      snapshotKeepLabel: 'Local keep count',
      snapshotHint: 'Snapshots are local-first: rolling window, over-window ones are truly deleted; only checked ones are written to git as permanent archive; the current state is snapshotted automatically before any restore.',
      snapshotEmpty: 'No snapshots yet',
      snapshotInCloud: 'in cloud',
      snapshotLocalOnly: 'local',
      snapshotRestore: 'Restore',
      snapshotBusy: 'Working…',
      restoreDone: 'Restored (current state snapshotted first); sync triggered',
      conflictTitle: 'Resolve sync conflict',
      conflictHint: 'An unmerged sync PR exists (two machines edited the same file). Click below: the AI reads the local token, analyzes both sides, resolves the conflict and merges the PR.',
      conflictPending: 'Unresolved conflict PR',
      resolveBtn: 'AI resolve conflict',
      alignBtn: 'AI align',
      alignTitle: 'AI smart align',
      alignHint: 'Pulls remote-only changes first (never overwrites local edits), then the AI semantically merges files both sides changed; live files are backed up before merging, the result is pushed automatically, and any still-conflicting PR is resolved in the same run.',
      alignFiles: 'Files to semantically merge',
      alignNoFiles: 'No both-side changes — deterministic sync handled everything',
      alignBackup: 'Backup dir',
      reconcileLine: 'pulled {applied} remote items · {both} awaiting AI align',
      openChat: 'Open chat',
      running: 'Running… (may take minutes)',
      runDone: 'Resolved',
      runFailed: 'Run failed',
      outputLabel: 'Output',
      repoUrlPlaceholder: 'https://gitcode.com/<owner>/<repo>.git',
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
    .sk-body{display:flex;flex-direction:column;gap:14px}
    .sk-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .sk-spacer{flex:1}
    .sk-hint{color:var(--dsw-alias-label-secondary)}
    .sk-dir{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13,12px)}
    .sk-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
    .sk-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
    .sk-tag.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
    .sk-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
    .sk-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .sk-toggles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
    .sk-gcard{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
    .sk-gcard.on{border-color:var(--dsw-alias-state-business-primary)}
    .sk-select{min-height:30px;width:100%;font-size:12.5px;padding:4px 8px}
    .sk-toggle{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}
    .sk-toggle.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
    .sk-spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));animation:dshspin .7s linear infinite}
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

    function ButtonLite({ primary, danger, small, children, ...rest }) {
      const cls = 'sk-btn' + (primary ? ' sk-btn-primary' : '') + (danger ? ' sk-btn-primary' : '') + (small ? ' sk-btn-sm' : '')
      if (prim('Button')) {
        return h(P.Button, { variant: primary || danger ? 'primary' : 'outline', size: small ? 'sm' : 'md', className: cls, ...rest }, children)
      }
      return h('button', { className: cls, ...rest }, children)
    }

    /** In-page dialog: fixed backdrop inside the settings page stacking context. */
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

    // ── Agent-run dialog: action-button pattern for two modes ──
    //    conflict: user opens it, then clicks run (needs pending PR info)
    //    align:    parent already POSTed (which ran a deterministic sync first),
    //              dialog opens with the job streaming and the both-modified list
    //    Both poll the same shape of job endpoint and can open the agent session.

    function AgentRunDialog({ t, mode, pending, initial, onClose, onToast }) {
      const align = mode === 'align'
      const endpoint = align ? API + '/align/run' : API + '/conflict/run'
      const [job, setJob] = useState(initial && initial.jobId ? { jobId: initial.jobId, status: 'running', output: '', code: null } : null)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        if (job === null || job.status !== 'running') return
        const timer = setInterval(() => {
          getJson(endpoint + '?id=' + encodeURIComponent(job.jobId))
            .then(d => setJob(prev => prev && { ...prev, status: d.status, output: d.output || '', code: d.code, sessionId: d.sessionId || prev.sessionId }))
            .catch(() => {})
        }, 2000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, [job && job.status, endpoint])
      const doRun = async () => {
        setBusy(true)
        try {
          const r = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(align ? {} : { branch: pending && pending.branch, prNumber: pending && pending.prNumber }),
          })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          setJob({ jobId: d.jobId, status: 'running', output: '', code: null })
        } catch (e) { onToast(t('runFailed') + ': ' + e.message) } finally { setBusy(false) }
      }
      const openChat = () => {
        try {
          const svc = sessionsSvc()
          if (svc && typeof svc.open === 'function' && job && job.sessionId) svc.open(job.sessionId)
        } catch {}
      }
      const row = (label, value) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
        h('span', { className: 'sk-dir' }, label), h('span', { className: 'sk-hint', style: { wordBreak: 'break-all', textAlign: 'right' } }, value))
      const files = initial && Array.isArray(initial.bothModified) ? initial.bothModified : null
      return h(SkDialog, { title: align ? t('alignTitle') : t('conflictTitle'), onClose, wide: true },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 380 } },
          h('div', { className: 'sk-hint' }, align ? t('alignHint') : t('conflictHint')),
          !align && pending && h('div', null,
            row('PR', '#' + (pending.prNumber || '-')),
            row('Branch', pending.branch || '-')),
          align && h('div', { className: 'sk-card' },
            h('div', { className: 'sk-dir', style: { marginBottom: 4 } }, t('alignFiles')),
            files && files.length
              ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 120, overflow: 'auto' } }, files.join('\n'))
              : h('div', { className: 'sk-hint' }, t('alignNoFiles')),
            initial && initial.backupDir && row(t('alignBackup'), initial.backupDir)),
          job !== null && h('div', null,
            h('div', { className: 'sk-dir', style: { margin: '4px 0' } },
              t('outputLabel') + ' · ' + (job.status === 'running' ? t('running') : job.status === 'done' ? t('runDone') : t('runFailed') + (job.code != null ? ' (' + job.code + ')' : ''))),
            h('pre', { className: 'sk-card', style: { maxHeight: 220, margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, overflow: 'auto' } },
              job.output || '…')),
          h('div', { className: 'sk-dlg-foot', style: { marginTop: 0 } },
            job !== null && job.sessionId && sessionsSvc() && h(ButtonLite, { onClick: openChat }, t('openChat')),
            !align && h(ButtonLite, { primary: true, disabled: busy || (job !== null && job.status === 'running'), onClick: doRun },
              job !== null && job.status === 'running' ? t('running') : t('resolveBtn')))))
    }

    // ── Settings section: the single entrance (host settings page section) ──

    function SettingsSection({ t }) {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [alignBusy, setAlignBusy] = useState(false)
      const [conflictOpen, setConflictOpen] = useState(false)
      const [alignOpen, setAlignOpen] = useState(false)
      const [alignInitial, setAlignInitial] = useState(null)
      const [toastText, setToastText] = useState(null)
      const [repoUrl, setRepoUrl] = useState('')
      const [branch, setBranch] = useState('')
      const [token, setToken] = useState('')
      const [intervalMinutes, setIntervalMinutes] = useState(30)
      const [autoSync, setAutoSync] = useState(true)
      const [syncOnStartup, setSyncOnStartup] = useState(false)
      const [conflictMode, setConflictMode] = useState('ai')
      const [g, setG] = useState({ skills: true, sessions: false, settings: true, plugins: true })
      const [gs, setGs] = useState({ skills: 'union', sessions: 'backup', settings: 'backup', plugins: 'backup' })
      const [snapCfg, setSnapCfg] = useState({ auto: true, skills: false, localKeep: 30 })
      const [snapList, setSnapList] = useState(null)
      const [snapName, setSnapName] = useState('')
      const [snapCloud, setSnapCloud] = useState(false)
      const [snapBusy, setSnapBusy] = useState(false)

      const onToast = (text, ms = 3000) => { setToastText(text); setTimeout(() => setToastText(null), ms) }
      const refresh = () => getJson(API + '/status').then(d => {
        setStatus(d)
        setRepoUrl(d.repoUrl)
        setBranch(d.branch)
        setIntervalMinutes(d.intervalMinutes)
        setAutoSync(d.autoSync)
        setSyncOnStartup(d.syncOnStartup)
        setConflictMode(d.conflictMode)
        setG({ skills: d.syncSkills, sessions: d.syncSessions, settings: d.syncSettings, plugins: d.syncPlugins })
        if (d.strategies) setGs(d.strategies)
        if (d.snapshot) setSnapCfg(d.snapshot)
        getJson(API + '/snapshot/list').then(l => setSnapList(l)).catch(() => {})
      }).catch(() => {})
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 15000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, [])

      const doSync = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          onToast(t('syncDone'), 2600)
        } catch (e) { onToast(t('syncFailed') + ': ' + e.message, 4000) }
        finally { setBusy(false); refresh() }
      }
      // AI smart align: POST runs a deterministic sync first (remote-only files
      // pulled back), then streams the semantic-merge agent run; dialog opens
      // already running with the both-modified file list.
      const doAlign = async () => {
        setAlignBusy(true)
        try {
          const r = await fetch(API + '/align/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          setAlignInitial({ jobId: d.jobId, bothModified: d.bothModified || [], backupDir: d.backupDir })
          setAlignOpen(true)
        } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
        finally { setAlignBusy(false); refresh() }
      }
      const putSettings = async (patch) => {
        const r = await fetch(API + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
        return d
      }
      const doSave = async () => {
        try {
          const patch = { repoUrl, branch, intervalMinutes, autoSync, syncOnStartup, conflictMode, syncSkills: g.skills, syncSessions: g.sessions, syncSettings: g.settings, syncPlugins: g.plugins, skillsStrategy: gs.skills, sessionsStrategy: gs.sessions, settingsStrategy: gs.settings, pluginsStrategy: gs.plugins, snapshotAuto: snapCfg.auto, snapshotSkills: snapCfg.skills, snapshotLocalKeep: snapCfg.localKeep }
          if (token !== '') patch.token = token
          await putSettings(patch)
          setToken('')
          onToast(t('saved'), 2200)
          refresh()
        } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
      }
      const doSnapshot = async () => {
        setSnapBusy(true)
        try {
          const r = await fetch(API + '/snapshot/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: snapName || undefined, cloud: snapCloud }) })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          setSnapName('')
          onToast(t('restoreDone') === '' ? '' : t('saved'), 2200)
          refresh()
        } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
        finally { setSnapBusy(false) }
      }
      const doRestore = async (name) => {
        setSnapBusy(true)
        try {
          const r = await fetch(API + '/snapshot/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          onToast(t('restoreDone'), 3000)
          refresh()
        } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
        finally { setSnapBusy(false) }
      }
      const doClearToken = async () => {
        try { await putSettings({ token: null }); onToast(t('saved'), 2200); refresh() }
        catch (e) { onToast(e.message || t('operationFailed'), 4000) }
      }

      let body
      try {
        const row = (label, value) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
          h('span', { className: 'sk-dir' }, label), h('span', { className: 'sk-hint', style: { wordBreak: 'break-all', textAlign: 'right' } }, value))
        const STRATS = ['backup', 'union', 'remote', 'local']
        const cap = (v) => v[0].toUpperCase() + v.slice(1)
        const groupCard = (key, label) => h('div', { key, className: 'sk-gcard' + (g[key] ? ' on' : '') },
          h('label', { className: 'sk-toggle' + (g[key] ? ' on' : ''), style: { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: g[key], onChange: e => setG(prev => ({ ...prev, [key]: e.target.checked })) }), label),
          g[key] && h('select', { className: 'sk-input sk-select', value: gs[key] || 'backup',
            onChange: e => setGs(prev => ({ ...prev, [key]: e.target.value })) },
            STRATS.map(v => h('option', { key: v, value: v }, t('strategy' + cap(v))))))
        body = status === null
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
              h('div', { className: 'sk-spin' }), '…')
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
                row(t('repoUrlLabel'), status.repoUrl || '-'),
                row(t('branchLabel'), status.branch || '-'),
                row(t('dirLabel'), status.dir),
                row(t('lastSyncLabel'), status.lastSyncAt ? formatTime(status.lastSyncAt) : t('repoMissing'))),
              (() => {
                const rec = status.lastResult && status.lastResult.reconcile
                const applied = rec && Array.isArray(rec.applied) ? rec.applied.length : 0
                const both = rec && Array.isArray(rec.bothModified) ? rec.bothModified.length : 0
                if (!rec || (!applied && !both)) return null
                return h(Tag, { tone: both ? 'danger' : 'accent' }, t('reconcileLine', { applied, both }))
              })(),
              h('div', null,
                h('div', { className: 'sk-dir', style: { margin: '4px 0' } }, t('groupHint')),
                h('div', { className: 'sk-toggles' },
                  groupCard('skills', t('toggleSkills')), groupCard('sessions', t('toggleSessions')),
                  groupCard('settings', t('toggleSettings')), groupCard('plugins', t('togglePlugins'))),
                h('div', { className: 'sk-dir' }, t('strategyHint'))),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  h('input', { type: 'checkbox', checked: autoSync, onChange: e => setAutoSync(e.target.checked) }), t('autoSyncLabel')),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  h('input', { type: 'checkbox', checked: syncOnStartup, onChange: e => setSyncOnStartup(e.target.checked) }), t('syncOnStartupLabel')),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  t('intervalLabel'), h('input', { className: 'sk-input', type: 'number', min: 5, value: intervalMinutes, onChange: e => setIntervalMinutes(Math.max(1, Number(e.target.value) || 30)), style: { width: 80 } }))),
              h('div', { className: 'sk-card' },
                h('div', { className: 'sk-head' },
                  h('span', { className: 'sk-dir' }, t('snapshotTitle')),
                  h('span', { className: 'sk-spacer' }),
                  snapBusy && h(Tag, { tone: 'accent' }, t('snapshotBusy')),
                  h('input', { className: 'sk-input', value: snapName, onChange: e => setSnapName(e.target.value), placeholder: t('snapshotNamePlaceholder'), style: { width: 180 } }),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5 } },
                    h('input', { type: 'checkbox', checked: snapCloud, onChange: e => setSnapCloud(e.target.checked) }), t('snapshotCloud')),
                  h(ButtonLite, { primary: true, small: true, disabled: snapBusy, onClick: doSnapshot }, t('snapshotNow'))),
                h('div', { className: 'sk-hint' }, t('snapshotHint')),
                h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('input', { type: 'checkbox', checked: snapCfg.auto, onChange: e => setSnapCfg(p => ({ ...p, auto: e.target.checked })) }), t('snapshotAutoLabel')),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('input', { type: 'checkbox', checked: snapCfg.skills, onChange: e => setSnapCfg(p => ({ ...p, skills: e.target.checked })) }), t('snapshotSkillsLabel')),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    t('snapshotKeepLabel'),
                    h('input', { className: 'sk-input', type: 'number', min: 1, value: snapCfg.localKeep, onChange: e => setSnapCfg(p => ({ ...p, localKeep: Math.max(1, Number(e.target.value) || 30) })), style: { width: 64 } }))),
                snapList === null
                  ? null
                  : (snapList.local.length === 0
                    ? h('div', { className: 'sk-hint' }, t('snapshotEmpty'))
                    : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                        snapList.local.map(s => h('div', { key: s.name, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 } },
                          h('span', { style: { fontSize: 12.5 } }, s.name),
                          h(Tag, { tone: s.inCloud ? 'accent' : undefined }, s.inCloud ? t('snapshotInCloud') : t('snapshotLocalOnly')),
                          h('span', { className: 'sk-spacer' }),
                          h(ButtonLite, { small: true, disabled: snapBusy, onClick: () => doRestore(s.name) }, t('snapshotRestore'))))))),
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
              h('div', { className: 'sk-toolbar' },
                h(ButtonLite, { onClick: doSave }, t('save')),
                h('span', { className: 'sk-spacer' }),
                h(ButtonLite, {
                  disabled: alignBusy || status.syncing || !status.repoUrl || !status.hasToken,
                  title: !status.repoUrl || !status.hasToken ? t('notConfigured') : undefined,
                  onClick: doAlign,
                }, alignBusy ? t('running') : t('alignBtn')),
                h(ButtonLite, { primary: true, disabled: busy || status.syncing || alignBusy, onClick: doSync }, busy ? t('syncing') : t('syncNow'))))
      } catch (renderErr) {
        ;(globalThis.__skErrors = globalThis.__skErrors || []).push('body: ' + (renderErr && renderErr.message))
        body = h('div', { className: 'sk-card', style: { color: 'var(--dsw-alias-state-error-primary)' } },
          '\u26A0\uFE0F ' + String((renderErr && renderErr.message) || renderErr))
      }

      return h('div', { className: 'sk-page' },
        h('div', { className: 'sk-body' }, body),
        conflictOpen && status && status.pendingConflict && h(AgentRunDialog, {
          t, mode: 'conflict', pending: status.pendingConflict, onClose: () => setConflictOpen(false), onToast,
        }),
        alignOpen && h(AgentRunDialog, {
          t, mode: 'align', initial: alignInitial, onClose: () => setAlignOpen(false), onToast,
        }),
        toastText && h(InToast, { text: toastText }),
      )
    }

    function SettingsSlotComponent(props) {
      useEffect(ensureStyles, [])
      return h(SettingsSection, { t: props.__t })
    }

    // ── Plugin plane contract ────────────────────────────────────────────────

    const CLIENT_NAME = '@weibaohui/dsh-sync'

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
        root.render(h(SettingsSection, { t }))
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
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 95,
              locale: NS,
              // resolveSlotLabel 调用 label() 不传参；官方模式是自带绑定翻译的闭包
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
