/**
 * dsh-sync contract tests.
 *
 * Pure-function + mirror/copy/lock checks run anywhere; the push-flow test
 * stands up a real local bare repo as the "remote", seeds an initial main
 * commit so clone works, mocks GitCode's REST surface (/user, /pulls, merge)
 * on globalThis.fetch, and drives the real runPush three-way path end to end.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals

const sh = (args, cwd) => new Promise((res, rej) => {
  execFile('git', args, { cwd }, (e, o, er) => e ? rej(new Error(`${args.join(' ')}: ${String(er || e.message).slice(-200)}`)) : res(String(o)))
})
const gitNoUser = (args, cwd) => sh(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
const mkdtemp = async () => {
  const d = await fsp.mkdtemp(join(tmpdir(), 'dshsync-'))
  return d
}

// ── Pure helpers ────────────────────────────────────────────────────────

test('parseRepoUrl handles gitcode urls', () => {
  assert.deepEqual(I.parseRepoUrl('https://gitcode.com/weibh/my-sync.git'), { owner: 'weibh', repo: 'my-sync' })
  assert.deepEqual(I.parseRepoUrl('https://gitcode.com/weibh/my-sync'), { owner: 'weibh', repo: 'my-sync' })
  assert.equal(I.parseRepoUrl('https://github.com/x/y'), null)
  assert.equal(I.parseRepoUrl('not a url'), null)
})

test('authedUrl embeds token, never persists to config', () => {
  assert.equal(I.authedUrl('https://gitcode.com/x/y.git', 'tok'), 'https://oauth2:tok@gitcode.com/x/y.git')
  assert.equal(I.authedUrl('https://gitcode.com/x/y.git', ''), 'https://gitcode.com/x/y.git')
  // existing user@info is replaced, not doubled
  assert.equal(I.authedUrl('https://user@host/x', 't'), 'https://oauth2:t@host/x')
})

test('syncSpec respects the four toggles', () => {
  const roots = { dshSkills: '/dsh', agentsSkills: '/a', agentsLock: '/l', sessions: '/s', settingsFile: '/st', profiles: '/p' }
  const all = I.syncSpec({ syncSkills: true, syncSessions: true, syncSettings: true, syncPlugins: true }, roots)
  assert.equal(all.length, 4)
  assert.equal(all.map(g => g.name).join(','), 'skills,sessions,settings,plugins')
  const onlySkills = I.syncSpec({ syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false }, roots)
  assert.equal(onlySkills.length, 1)
  assert.equal(onlySkills[0].name, 'skills')
  assert.equal(onlySkills[0].sources.length, 3)   // dsh + agents + lock
  // machine-specific python bytecode caches must never sync — they churn
  // "modified" on every run and differ per interpreter version (312 vs 314)
  for (const src of onlySkills[0].sources) {
    if (!src.file) assert.ok(src.excludeDirs && src.excludeDirs.has('__pycache__'), `__pycache__ excluded from ${src.to}`)
  }
})

// ── copyTree / mirror / resolve ─────────────────────────────────────────

test('copyTree honors includeFiles, excludeDirs, excludeNames, followSymlinks', async () => {
  const tmp = await mkdtemp()
  const live = join(tmp, 'profiles')
  await fsp.mkdir(join(live, 'web'), { recursive: true })
  await fsp.mkdir(join(live, 'web', 'node_modules'), { recursive: true })
  await fsp.writeFile(join(live, 'web', 'package.json'), '{}')
  await fsp.writeFile(join(live, 'web', 'cordis.yml'), 'prod')
  await fsp.writeFile(join(live, 'web', 'cordis.patch.yml'), '[]')
  await fsp.writeFile(join(live, 'web', 'node_modules', 'x.js'), 'x')
  const target = join(tmp, 'shadow', 'plugins')
  await I.copyTree(live, target, {
    includeFiles: new Set(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
    excludeDirs: new Set(['node_modules', '.dsh-market']),
    excludeNames: new Set(['cordis.yml']),
  })
  assert.ok(fs.existsSync(join(target, 'web', 'package.json')))
  assert.ok(fs.existsSync(join(target, 'web', 'cordis.patch.yml')))
  assert.ok(!fs.existsSync(join(target, 'web', 'cordis.yml')), 'cordis.yml (loader product) excluded')
  assert.ok(!fs.existsSync(join(target, 'web', 'node_modules')), 'node_modules excluded')
})

test('mirrorLiveToShadow + resolveLivePath round-trip', async () => {
  const tmp = await mkdtemp()
  const live = join(tmp, 'live')
  const shadow = join(tmp, 'shadow')
  // skills group
  await fsp.mkdir(join(live, 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, 'skills', 'foo', 'SKILL.md'), '# foo')
  await fsp.writeFile(join(live, 'settings.yaml'), 'k: v')
  const roots = {
    dshSkills: join(live, 'skills'), agentsSkills: join(live, 'nope-agents'),
    agentsLock: join(live, 'nope-lock'), sessions: join(live, 'nope-s'),
    settingsFile: join(live, 'settings.yaml'), profiles: join(live, 'nope-p'),
  }
  const spec = I.syncSpec({ syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false }, roots)
  await I.mirrorLiveToShadow(spec, shadow)
  assert.equal(fs.readFileSync(join(shadow, 'skills', 'dsh', 'foo', 'SKILL.md'), 'utf8'), '# foo')
  assert.equal(fs.readFileSync(join(shadow, 'settings', 'settings.yaml'), 'utf8'), 'k: v')
  // reverse-resolve
  assert.equal(I.resolveLivePath(spec, 'skills/dsh/foo/SKILL.md'), join(live, 'skills', 'foo', 'SKILL.md'))
  assert.equal(I.resolveLivePath(spec, 'settings/settings.yaml'), join(live, 'settings.yaml'))
  assert.equal(I.resolveLivePath(spec, 'unknown/path'), undefined)
})

// ── Lock ─────────────────────────────────────────────────────────────────

test('acquireLock: first wins, second denied, stale recovered', async () => {
  const tmp = await mkdtemp()
  const lock = join(tmp, '.lock')
  const r1 = await I.acquireLock(lock)
  assert.notEqual(r1, null)
  const r2 = await I.acquireLock(lock)
  assert.equal(r2, null, 'second concurrent acquire denied')
  // stale: write a dead pid, acquire should steal it
  await fsp.writeFile(lock, '999999')
  const r3 = await I.acquireLock(lock)
  assert.notEqual(r3, null, 'stale lock recovered')
  r3()
})

// ── Private-repo check (mock fetch) ─────────────────────────────────────

test('checkRepoPrivate: public repo refused, private ok', async () => {
  const orig = globalThis.fetch
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  globalThis.fetch = async (url) => {
    if (String(url).includes('/repos/weibh/private-repo')) return mk({ private: true, default_branch: 'main' })
    if (String(url).includes('/repos/weibh/public-repo')) return mk({ private: false })
    return mk({ message: 'not found' }, 404)
  }
  try {
    const priv = await I.checkRepoPrivate('tok', 'https://gitcode.com/weibh/private-repo.git')
    assert.equal(priv.ok, true)
    assert.equal(priv.owner, 'weibh')
    const pub = await I.checkRepoPrivate('tok', 'https://gitcode.com/weibh/public-repo.git')
    assert.equal(pub.ok, false)
    assert.equal(pub.isPublic, true)
    assert.ok(/私有仓库/.test(pub.error), 'error explains private requirement')
    const bad = await I.checkRepoPrivate('tok', 'not a gitcode url')
    assert.equal(bad.ok, false)
  } finally { globalThis.fetch = orig }
})

// ── Update detection: local classify + remote check ─────────────────────

/** Stand up a shadow repo with a baseline commit laid out like the real
 *  spec (skills/dsh/..., settings/settings.yaml) + live roots to diff. */
const setupDetection = async () => {
  const tmp = await mkdtemp()
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await fsp.mkdir(repoDir, { recursive: true })
  await sh(['init', '-q', '-b', 'main', repoDir])
  // baseline content committed inside the shadow tree
  await fsp.mkdir(join(repoDir, 'skills', 'dsh', 'foo'), { recursive: true })
  await fsp.mkdir(join(repoDir, 'settings'), { recursive: true })
  await fsp.writeFile(join(repoDir, 'skills', 'dsh', 'foo', 'SKILL.md'), '# foo v1')
  await fsp.writeFile(join(repoDir, 'skills', 'dsh', 'gone.md'), '# will be deleted live')
  await fsp.writeFile(join(repoDir, 'settings', 'settings.yaml'), 'k: v\n')
  await fsp.writeFile(join(repoDir, '.gitattributes'), '*.jsonl merge=union\n')
  await gitNoUser(['add', '-A'], repoDir)
  await gitNoUser(['commit', '-q', '-m', 'baseline'], repoDir)
  const head = (await sh(['rev-parse', 'HEAD'], repoDir)).trim()
  // live roots reflecting the baseline
  await fsp.mkdir(join(live, 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, 'skills', 'foo', 'SKILL.md'), '# foo v1')
  await fsp.writeFile(join(live, 'skills', 'gone.md'), '# will be deleted live')
  await fsp.writeFile(join(live, 'settings.yaml'), 'k: v\n')
  const roots = {
    dshSkills: join(live, 'skills'),
    agentsSkills: join(live, 'nope-agents'),
    agentsLock: join(live, 'nope-lock'),
    sessions: join(live, 'nope-s'),
    settingsFile: join(live, 'settings.yaml'),
    profiles: join(live, 'nope-p'),
  }
  const eff = { repoUrl: '', branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, token: '' }
  return { tmp, repoDir, live, roots, eff, head }
}

test('walkLiveFingerprint + fingerprintEqual gate open/close on real changes', async () => {
  const { tmp, live, roots, eff } = await setupDetection()
  try {
    const spec = I.syncSpec(eff, roots)
    const fp1 = await I.walkLiveFingerprint(spec)
    assert.ok(fp1.has('skills/dsh/foo/SKILL.md'))
    assert.ok(fp1.has('settings/settings.yaml'))
    assert.equal(fp1.get('settings/settings.yaml').live, join(live, 'settings.yaml'))
    const fp2 = await I.walkLiveFingerprint(spec)
    assert.equal(I.fingerprintEqual(fp1, fp2), true)
    // add a live file → gate opens
    await fsp.writeFile(join(live, 'skills', 'new.md'), '# new')
    const fp3 = await I.walkLiveFingerprint(spec)
    assert.equal(I.fingerprintEqual(fp1, fp3), false)
    // remove it again → gate closes
    await fsp.unlink(join(live, 'skills', 'new.md'))
    const fp4 = await I.walkLiveFingerprint(spec)
    assert.equal(I.fingerprintEqual(fp1, fp4), true)
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('classifyLocalChanges: A/M/D vs baseline, clean pass, no-baseline, out-of-spec ignored', async () => {
  const { tmp, repoDir, live, roots, eff, head } = await setupDetection()
  try {
    const clean = await I.classifyLocalChanges('git', eff, { repoDir, state: { lastSyncedCommit: head }, roots })
    assert.equal(clean.dirty, false, 'live == baseline → clean')
    assert.deepEqual(clean.counts, { added: 0, modified: 0, deleted: 0 })
    // mutate: modify one, add one, delete one
    await fsp.writeFile(join(live, 'skills', 'foo', 'SKILL.md'), '# foo v2 edited')
    await fsp.writeFile(join(live, 'skills', 'added.md'), '# added')
    await fsp.unlink(join(live, 'skills', 'gone.md'))
    const res = await I.classifyLocalChanges('git', eff, { repoDir, state: { lastSyncedCommit: head }, roots })
    assert.equal(res.dirty, true)
    const kinds = Object.fromEntries(res.files.map(f => [f.path, f.kind]))
    assert.equal(kinds['skills/dsh/foo/SKILL.md'], 'M')
    assert.equal(kinds['skills/dsh/added.md'], 'A')
    assert.equal(kinds['skills/dsh/gone.md'], 'D')
    // .gitattributes lives in the tree but outside the spec → never reported
    assert.equal(kinds['.gitattributes'], undefined)
    assert.deepEqual(res.counts, { added: 1, modified: 1, deleted: 1 })
    // no baseline → disabled, not an error
    const nb = await I.classifyLocalChanges('git', eff, { repoDir, state: {}, roots })
    assert.equal(nb.disabled, 'no-baseline')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('checkRemoteUpdates: counts commits behind a pushed remote', async () => {
  const { tmp, repoDir, eff, head } = await setupDetection()
  const bareRepo = join(tmp, 'remote.git')
  try {
    await sh(['init', '-q', '--bare', '-b', 'main', bareRepo])
    await sh(['push', '-q', bareRepo, 'main'], repoDir)
    // unchanged → behind 0
    const even = await I.checkRemoteUpdates('git', { ...eff, repoUrl: bareRepo }, { repoDir, state: { lastSyncedCommit: head } })
    assert.equal(even.behind, 0)
    // another machine pushes from a second clone
    const other = join(tmp, 'other')
    await sh(['clone', '-q', bareRepo, other])
    await fsp.writeFile(join(other, 'settings', 'settings.yaml'), 'changed by other\n')
    await fsp.mkdir(join(other, 'skills', 'dsh', 'bar'), { recursive: true })
    await fsp.writeFile(join(other, 'skills', 'dsh', 'bar', 'SKILL.md'), '# bar')
    await gitNoUser(['add', '-A'], other)
    await gitNoUser(['commit', '-q', '-m', 'other machine sync'], other)
    await sh(['push', '-q', 'origin', 'main'], other)
    const res = await I.checkRemoteUpdates('git', { ...eff, repoUrl: bareRepo }, { repoDir, state: { lastSyncedCommit: head } })
    assert.equal(res.behind, 1)
    const kinds = Object.fromEntries(res.files.map(f => [f.path, f.kind]))
    assert.equal(kinds['settings/settings.yaml'], 'M')
    assert.equal(kinds['skills/dsh/bar/SKILL.md'], 'A')
    assert.equal(res.commits.length, 1)
    assert.equal(res.commits[0].subject, 'other machine sync')
    // baseline commit that never existed → baseline-lost, not a crash
    const lost = await I.checkRemoteUpdates('git', { ...eff, repoUrl: bareRepo }, { repoDir, state: { lastSyncedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } })
    assert.equal(lost.disabled, 'baseline-lost')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('trimCheck caps file lists for the status payload', () => {
  const files = Array.from({ length: 60 }, (_, i) => ({ path: 'f' + i, kind: 'M' }))
  const t = I.trimCheck({ at: 'x', dirty: true, files, counts: { added: 0, modified: 60, deleted: 0 } })
  assert.equal(t.files.length, 50)
  assert.equal(t.filesTotal, 60)
  assert.equal(I.trimCheck(null), null)
})

// ── End-to-end push flow: real git + bare remote + mocked GitCode REST ──

test('runPush: mirrors live → branch → PR → merge (mocked REST)', async () => {
  const orig = globalThis.fetch
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  // 1. bare remote + seed an initial main commit so clone works
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  // 2. live roots
  await fsp.mkdir(join(live, '.dsh', 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n# foo')
  await fsp.writeFile(join(live, '.dsh', 'settings.yaml'), 'provider: zhanlu\n')
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  // 3. mock GitCode REST: /user → tester, /pulls → #1 (mergeable), merge → ok
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = (init.method || 'GET').toUpperCase()
    if (u.endsWith('/user')) return mk({ login: 'tester' })
    if (/\/pulls$/.test(u) && method === 'POST') return mk({ number: 1 }, 201)
    if (/\/pulls\/1$/.test(u) && method === 'GET') return mk({ number: 1, mergeable: true })
    if (/\/pulls\/1\/merge$/.test(u) && method === 'PUT') return mk({}, 200)
    return mk({ message: 'unmocked ' + u }, 404)
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, token: '' }
  const state = { instanceId: 'testhost-abc12345' }
  try {
    const result = await I.runPush('git', eff, {
      repoDir, instanceId: state.instanceId, state,
      logger: { warn: () => {}, info: () => {} }, roots,
    })
    // pushed (local non-GitCode remote → branch only, PR skipped)
    assert.equal(result.pushed, true)
    assert.equal(result.prSkipped, true)
    // branch name follows the instance-id pattern
    assert.ok(state.lastPushedBranch.startsWith('sync/testhost-abc12345/'), state.lastPushedBranch)
    // the branch was actually pushed to the bare remote
    const ls = await sh(['ls-remote', bareRepo], tmp)
    assert.ok(ls.includes('sync/testhost-abc12345/'), 'branch pushed to remote')
    // the live files landed in that branch's tree
    const blob = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:skills/dsh/foo/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.ok(blob.includes('# foo'), 'live skill content committed to branch')
    // settings.yaml mirrored too
    const stBlob = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:settings/settings.yaml`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.equal(stBlob, 'provider: zhanlu\n')
    // after merge the shadow advanced onto main; lastSyncedCommit recorded
    assert.ok(state.lastSyncedCommit, 'lastSyncedCommit recorded after merge')
  } finally {
    globalThis.fetch = orig
    // clean the test repo so lock/state don't leak across files
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── Pre-push reconcile: remote-only pull-back + both-modified reporting ──

test('reconcileRemote: pulls remote-only adds into live, never overwrites local edits', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  // seed remote main
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  // live: one local skill + a local settings file
  await fsp.mkdir(join(live, '.dsh', 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'foo', 'SKILL.md'), '# foo local')
  await fsp.writeFile(join(live, '.dsh', 'settings.yaml'), 'provider: local-only\n')
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, token: '' }
  const state = { instanceId: 'testhost-rec' }
  try {
    // 1. shadow clone + baseline = seed commit
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    // 2. machine B advances remote main: adds a new skill AND a settings file
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.mkdir(join(peer, 'skills', 'dsh', 'bar'), { recursive: true })
    await fsp.mkdir(join(peer, 'settings'), { recursive: true })
    await fsp.writeFile(join(peer, 'skills', 'dsh', 'bar', 'SKILL.md'), '# bar from peer')
    await fsp.writeFile(join(peer, 'settings', 'settings.yaml'), 'provider: peer-version\npeerKey: v2\n')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer adds'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    // 3. reconcile
    const rec = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots })
    assert.equal(rec.reconciled, true)
    // remote-only skill pulled back into live
    assert.ok(rec.applied.some(p => p === 'skills/dsh/bar/SKILL.md'), 'remote-only add applied: ' + JSON.stringify(rec.applied))
    assert.equal(fs.readFileSync(join(live, '.dsh', 'skills', 'bar', 'SKILL.md'), 'utf8'), '# bar from peer')
    // settings changed on both sides → reported, live NOT overwritten
    assert.ok(rec.bothModified.some(f => f.shadowPath === 'settings/settings.yaml'), 'both-modified reported')
    assert.equal(fs.readFileSync(join(live, '.dsh', 'settings.yaml'), 'utf8'), 'provider: local-only\n', 'local edit untouched')
    // 4. subsequent push must keep the peer's new file (no flap deletion)
    const push = await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots })
    assert.equal(push.pushed, true)
    const kept = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:skills/dsh/bar/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.ok(kept.includes('# bar from peer'), 'peer add preserved in push branch (no delete flap)')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── Client contract: locale key parity (ZH/EN must stay aligned) ────────

test('client locale: ZH and EN key sets are identical', () => {
  // client source is CommonJS and loadable under plain Node (React shimmed)
  const C = require('../client/index.js').__internals
  const zh = Object.keys(C.ZH).sort()
  const en = Object.keys(C.EN).sort()
  assert.deepEqual(zh, en, 'ZH/EN locale key sets must match')
})

// ── Per-machine .gitignore (core.excludesFile) — filter what gets synced ──

/** Run a helper with DSH_HOME pointed at a throwaway dir (ignoreFile() uses it). */
const withDshHome = async (fn) => {
  const prev = process.env.DSH_HOME
  const dsh = await mkdtemp()
  process.env.DSH_HOME = join(dsh, '.dsh')
  try { return await fn(dsh) }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; await fsp.rm(dsh, { recursive: true, force: true }).catch(() => {}) }
}

test('ensureIgnoreFile writes DEFAULT_IGNORE once, then keeps user edits', async () => {
  await withDshHome(async () => {
    const f = await I.ensureIgnoreFile()
    const first = fs.readFileSync(f, 'utf8')
    assert.ok(first.includes('.DS_Store'), 'default template present')
    fs.writeFileSync(f, first + '\nmy-skill/\n')
    const again = await I.ensureIgnoreFile()
    assert.ok(fs.readFileSync(again, 'utf8').includes('my-skill/'), 'user edits preserved')
    assert.equal(fs.readFileSync(again, 'utf8').split('my-skill/').length, 2, 'no duplicate rewrite')
  })
})

test('configureIgnore + collectIgnored: .gitignore paths reported ignored', async () => {
  await withDshHome(async (dsh) => {
    const repoDir = join(dsh, 'repo')
    await fsp.mkdir(repoDir, { recursive: true })
    await sh(['init', '-q', '-b', 'main', repoDir])
    await I.configureIgnore('git', repoDir)
    // user ignores *.tmp and c/skip.md
    await fsp.writeFile(I.ignoreFile(), '*.tmp\nc/skip.md\n')
    const ignored = await I.collectIgnored('git', repoDir, ['a/junk.tmp', 'c/skip.md', 'a/keep.txt', 'c/keep.md'])
    assert.deepEqual([...ignored].sort(), ['a/junk.tmp', 'c/skip.md'])
  })
})

test('classifyLocalChanges: ignored files are invisible (not A, not D-on-stale-baseline)', async () => {
  const { tmp, repoDir, live, roots, eff, head } = await setupDetection()
  await withDshHome(async () => {
    try {
      // ignore `skills/dsh/gone.md` (present in baseline) and a to-be-added file
      await I.configureIgnore('git', repoDir)                 // creates the dir + default file
      await fsp.writeFile(I.ignoreFile(), 'skills/dsh/gone.md\nskills/dsh/secret.md\n')
      // live: add a regular + an ignored file; gone.md stays (already in baseline)
      await fsp.writeFile(join(live, 'skills', 'added.md'), '# added')
      await fsp.writeFile(join(live, 'skills', 'secret.md'), '# secret')
      const ignored = await I.collectIgnored('git', repoDir, ['skills/dsh/gone.md', 'skills/dsh/secret.md', 'skills/dsh/added.md'])
      const res = await I.classifyLocalChanges('git', eff, { repoDir, state: { lastSyncedCommit: head }, roots, ignored })
      const kinds = Object.fromEntries(res.files.map(f => [f.path, f.kind]))
      assert.equal(kinds['skills/dsh/added.md'], 'A', 'non-ignored addition detected')
      assert.equal(kinds['skills/dsh/secret.md'], undefined, 'ignored addition invisible')
      assert.equal(kinds['skills/dsh/gone.md'], undefined, 'ignored baseline file NOT reported as deleted')
    } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  })
})

test('mirrorLiveToShadow: ignored files are not copied into the shadow tree', async () => {
  const { tmp, live, roots, eff } = await setupDetection()
  try {
    await fsp.writeFile(join(live, 'skills', 'keep.md'), '# keep')
    await fsp.writeFile(join(live, 'skills', 'skip.md'), '# skip')
    const shadow = join(tmp, 'shadow2')
    await fsp.mkdir(shadow, { recursive: true })
    await I.mirrorLiveToShadow(I.syncSpec(eff, roots), shadow, { ignored: new Set(['skills/dsh/skip.md']) })
    assert.ok(fs.existsSync(join(shadow, 'skills', 'dsh', 'keep.md')), 'kept copied')
    assert.ok(!fs.existsSync(join(shadow, 'skills', 'dsh', 'skip.md')), 'ignored not copied')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})
