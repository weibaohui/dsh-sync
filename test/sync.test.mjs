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
  const spec = I.syncSpec({ syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'union' }, roots)
  await I.mirrorLiveToShadow(spec, shadow)
  assert.equal(fs.readFileSync(join(shadow, 'skills', 'dsh', 'foo', 'SKILL.md'), 'utf8'), '# foo')
  assert.equal(fs.readFileSync(join(shadow, 'settings', 'settings.yaml'), 'utf8'), 'k: v')
  // backup 策略：写入 backup/<instanceId>/ 前缀，strategyForPath 可查
  const bspec = I.syncSpec({ syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'backup', skillsStrategy: 'backup' }, roots, 'inst-9')
  assert.equal(bspec[0].strategy, 'backup')
  assert.equal(bspec[1].sources[0].to, 'backup/inst-9/settings/settings.yaml')
  assert.equal(I.strategyForPath(bspec, 'backup/inst-9/skills/dsh/foo/SKILL.md'), 'backup')
  assert.equal(I.strategyForPath(spec, 'skills/dsh/foo/SKILL.md'), 'union')
  assert.equal(I.strategyForPath(spec, 'outside/path'), undefined)
  const bshadow = join(tmp, 'bshadow')
  await I.mirrorLiveToShadow(bspec, bshadow)
  assert.equal(fs.readFileSync(join(bshadow, 'backup', 'inst-9', 'settings', 'settings.yaml'), 'utf8'), 'k: v')
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
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'union', token: '' }
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
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'union', token: '' }
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


// ── bothModified preserve: push must NOT clobber the remote version ─────

test('runPush preserve: both-modified files keep the remote version on the branch', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  await fsp.mkdir(join(live, '.dsh', 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'foo', 'SKILL.md'), '# foo local')
  await fsp.writeFile(join(live, '.dsh', 'settings.yaml'), 'provider: local-edit\n')
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'union', token: '' }
  const state = { instanceId: 'testhost-pres' }
  try {
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    // peer edits settings on remote main
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.mkdir(join(peer, 'settings'), { recursive: true })
    await fsp.writeFile(join(peer, 'settings', 'settings.yaml'), 'provider: peer-edit\n')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer edits settings'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    // local edits settings too → bothModified; push WITH preserve
    const push = await I.runPush('git', eff, {
      repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots,
      preserve: ['settings/settings.yaml'],
    })
    assert.equal(push.pushed, true)
    const onBranch = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:settings/settings.yaml`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.equal(onBranch, 'provider: peer-edit\n', 'remote version stays on the push branch (no silent clobber)')
    const skill = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:skills/dsh/foo/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.ok(skill.includes('# foo local'), 'uncontested local edits still push')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── First join = union: remote-only files survive the snapshot push ─────

test('runPush first join: remote-only files kept, differing settings.yaml protected', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  // remote main already has peer content: a skill + a settings file
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const peer = join(tmp, 'peer')
  await sh(['clone', bareRepo, peer])
  await fsp.mkdir(join(peer, 'skills', 'dsh', 'bar'), { recursive: true })
  await fsp.mkdir(join(peer, 'settings'), { recursive: true })
  await fsp.writeFile(join(peer, '.gitattributes'), '*.jsonl merge=union\n')
  await fsp.writeFile(join(peer, 'skills', 'dsh', 'bar', 'SKILL.md'), '# bar only on peer')
  await fsp.writeFile(join(peer, 'settings', 'settings.yaml'), 'provider: peer-provider\npeerKey: 1\n')
  await gitNoUser(['add', '-A'], peer)
  await gitNoUser(['commit', '-m', 'peer seeds'], peer)
  await sh(['push', bareRepo, 'main'], peer)
  // joining machine has its own skill + its own settings, never synced before
  await fsp.mkdir(join(live, '.dsh', 'skills', 'foo'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'foo', 'SKILL.md'), '# foo only local')
  await fsp.writeFile(join(live, '.dsh', 'settings.yaml'), 'provider: joiner-provider\njoinerKey: 1\n')
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, settingsStrategy: 'union', token: '' }
  const state = { instanceId: 'testhost-join' }   // no lastSyncedCommit → first join
  try {
    const push = await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots })
    assert.equal(push.pushed, true)
    assert.equal(push.settingsPreserved, true, 'join-time settings divergence reported')
    const show = (path) => new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:${path}`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.ok((await show('skills/dsh/bar/SKILL.md')).includes('# bar only on peer'), 'peer-only skill survives first join (union)')
    assert.ok((await show('skills/dsh/foo/SKILL.md')).includes('# foo only local'), 'local skill pushed')
    assert.equal(await show('settings/settings.yaml'), 'provider: peer-provider\npeerKey: 1\n', 'remote settings.yaml wins on join (no clobber)')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── apiproxy wire format (dsh 0.1.2-rc.1): cookie + slash endpoint + args ──

test('apiproxy: BrowserAuth cookie dance, slash endpoint, args envelope, legacy fallback', async () => {
  const orig = globalThis.fetch
  I.__resetApiproxyCache()
  I.__setConnection({ authenticatedUrl: (base) => base + '/?token=launch-token' })
  const calls = []
  let authAttempts = 0
  const mk = (status, result) => ({ status, headers: { getSetCookie: () => [] }, json: async () => result === undefined ? {} : { result } })
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method || 'GET').toUpperCase()
    if (u.endsWith('/?token=launch-token') && method === 'GET') {
      authAttempts++
      return { status: 303, headers: { getSetCookie: () => ['dsh-auth-abc=cookie-value; Path=/; HttpOnly'] } }
    }
    const m = u.match(/\/api\/(session[./][a-z]+)$/)
    if (m && method === 'POST') {
      const body = JSON.parse(init.body)
      calls.push({ endpoint: m[1], method: body.method, payload: body.payload, cookie: init.headers && init.headers.Cookie })
      if (authAttempts === 0) return mk(401)
      if (m[1] === 'session/create') return mk(200, { ok: true, value: { sessionId: 'session-1', agentPreset: 'standard' } })
      if (m[1] === 'session.list') return mk(200, { ok: true, value: { sessionId: 'session-legacy' } })
      return mk(404)   // slash endpoint the host does not know → legacy fallback
    }
    return mk(404)
  }
  try {
    // 1. bare 401 → mint cookie → retry with Cookie header
    const value = await I.apiproxy('session/create', { cwd: '/tmp' })
    assert.equal(value.sessionId, 'session-1')
    assert.equal(calls[0].cookie, undefined, 'first attempt has no cookie')
    assert.equal(calls[1].cookie, 'dsh-auth-abc=cookie-value', 'retry carries minted cookie')
    assert.equal(calls[1].method, 'session/create', 'slash endpoint in envelope method')
    assert.deepEqual(calls[1].payload, { args: { request: { cwd: '/tmp' } } }, 'payload wrapped in args.request')
    // 2. legacy fallback: slash endpoint 404s → dotted + flat payload
    const legacy = await I.apiproxy('session/list', {})
    assert.equal(legacy.sessionId, 'session-legacy')
    assert.equal(calls[2].method, 'session/list', 'slash tried first')
    assert.equal(calls[3].endpoint, 'session.list', 'legacy dotted endpoint retried')
    assert.deepEqual(calls[3].payload, {}, 'legacy payload stays flat')
  } finally {
    globalThis.fetch = orig
    I.__resetApiproxyCache()
    I.__setConnection(null)
  }
})

// ── Machine-owned plugin manifests: pull/reconcile never overwrite existing ──

test('reconcileRemote: existing plugin manifest kept, new plugin files applied', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  // live: own web profile manifest + own skill
  await fsp.mkdir(join(live, '.dsh', 'skills', 'foo'), { recursive: true })
  await fsp.mkdir(join(live, '.dsh', 'profiles', 'web'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'foo', 'SKILL.md'), '# foo')
  await fsp.writeFile(join(live, '.dsh', 'profiles', 'web', 'package.json'), '{"bundles":["ours"]}')
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.nope-settings'),
    profiles: join(live, '.dsh', 'profiles'),
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: true, pluginsStrategy: 'union', token: '' }
  const state = { instanceId: 'testhost-plug' }
  try {
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    // peer (old plugin version) replaced web/package.json AND added a new profile dir
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.mkdir(join(peer, 'plugins', 'web'), { recursive: true })
    await fsp.mkdir(join(peer, 'plugins', 'their-extra'), { recursive: true })
    await fsp.writeFile(join(peer, 'plugins', 'web', 'package.json'), '{"bundles":["theirs","dsh-at-file"]}')
    await fsp.writeFile(join(peer, 'plugins', 'their-extra', 'package.json'), '{"bundles":["theirs-extra"]}')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer swaps manifests'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    const rec = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots })
    assert.equal(rec.reconciled, true)
    assert.ok(rec.localKept.includes('plugins/web/package.json'), 'existing manifest reported as localKept: ' + JSON.stringify(rec.localKept))
    assert.equal(fs.readFileSync(join(live, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'), '{"bundles":["ours"]}', 'existing manifest NOT overwritten (boot safety)')
    assert.equal(fs.readFileSync(join(live, '.dsh', 'profiles', 'their-extra', 'package.json'), 'utf8'), '{"bundles":["theirs-extra"]}', 'new profile manifests still arrive (union)')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── Pending-both baseline bookkeeping: unresolved files keep their base ──

test('reconcile keeps per-file baseline for unresolved bothModified across syncs', async () => {
  const tmp = await mkdtemp()
  const bareRepo = join(tmp, 'remote.git')
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await fsp.mkdir(join(seed, 'skills', 'dsh', 'x'), { recursive: true })
  await fsp.writeFile(join(seed, 'skills', 'dsh', 'x', 'SKILL.md'), 'base\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.nope-settings'),
    profiles: join(live, '.nope-p'),
  }
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, token: '' }
  const state = { instanceId: 'testhost-base' }
  try {
    // establish baseline B0
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    const b0 = state.lastSyncedCommit
    // local edits X, peer edits X on main
    await fsp.mkdir(join(live, '.dsh', 'skills', 'x'), { recursive: true })
    await fsp.writeFile(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'base\nlocal edit\n')
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.writeFile(join(peer, 'skills', 'dsh', 'x', 'SKILL.md'), 'base\nremote edit\n')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer edits x'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    // sync 1: detect bothModified, preserve, baseline must NOT swallow the file
    const rec1 = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots })
    assert.equal(rec1.bothModified.length, 1)
    assert.equal(rec1.bothModified[0].baseCommit, b0, 'bothModified carries its true base commit')
    await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots, preserve: ['skills/dsh/x/SKILL.md'] })
    assert.notEqual(state.lastSyncedCommit, b0, 'global baseline advanced')
    assert.equal(state.pendingBoth['skills/dsh/x/SKILL.md'], b0, 'unresolved file base kept in pendingBoth')
    // sync 2 (no new remote changes): fresh bothModified empty, pending survives
    const rec2 = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots })
    assert.equal(rec2.bothModified.length, 0)
    assert.equal(state.pendingBoth['skills/dsh/x/SKILL.md'], b0, 'pending survives unchanged remote')
    // align resolves: live = semantic merge, pending cleared → next push propagates
    await fsp.writeFile(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'base\nlocal edit\nremote edit\n')
    delete state.pendingBoth['skills/dsh/x/SKILL.md']
    await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots })
    const merged = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:skills/dsh/x/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.equal(merged, 'base\nlocal edit\nremote edit\n', 'merged version reaches the push branch')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── Per-group strategies: local / remote / backup behavior ──────────────

const STRAT_ROOTS = (live) => ({
  dshSkills: join(live, '.dsh', 'skills'),
  agentsSkills: join(live, '.nope-agents'),
  agentsLock: join(live, '.nope-lock'),
  sessions: join(live, '.nope-s'),
  settingsFile: join(live, '.nope-settings'),
  profiles: join(live, '.nope-p'),
})
const mkRepo = async (tmp) => {
  const bareRepo = join(tmp, 'remote.git')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(seed, { recursive: true })
  await fsp.writeFile(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await fsp.mkdir(join(seed, 'skills', 'dsh', 'x'), { recursive: true })
  await fsp.writeFile(join(seed, 'skills', 'dsh', 'x', 'SKILL.md'), 'base\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  return bareRepo
}

test('strategy local: remote changes never touch live, no conflict bookkeeping', async () => {
  const tmp = await mkdtemp()
  const bareRepo = await mkRepo(tmp)
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await fsp.mkdir(join(live, '.dsh', 'skills', 'x'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'base\nlocal edit\n')
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, skillsStrategy: 'local', token: '' }
  const state = { instanceId: 'testhost-loc' }
  try {
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.writeFile(join(peer, 'skills', 'dsh', 'x', 'SKILL.md'), 'base\nremote edit\n')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer edits x'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    const rec = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots: STRAT_ROOTS(live) })
    assert.equal(rec.bothModified.length, 0, 'local strategy: no bothModified')
    assert.equal(rec.applied.length, 0, 'local strategy: nothing applied')
    assert.equal(fs.readFileSync(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'utf8'), 'base\nlocal edit\n', 'live untouched')
    assert.equal(JSON.stringify(state.pendingBoth), '{}', 'no conflict bookkeeping for local-wins')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('strategy remote: local edits overwritten, deletions mirrored, group not pushed', async () => {
  const tmp = await mkdtemp()
  const bareRepo = await mkRepo(tmp)
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await fsp.mkdir(join(live, '.dsh', 'skills', 'x'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'base\nlocal edit wins? no\n')
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, skillsStrategy: 'remote', token: '' }
  const state = { instanceId: 'testhost-rem' }
  try {
    await I.ensureShadowRepo('git', eff, repoDir)
    await sh(['fetch', bareRepo, 'main'], repoDir)
    await sh(['checkout', 'main'], repoDir).catch(() => {})
    await sh(['reset', '--hard', 'FETCH_HEAD'], repoDir)
    state.lastSyncedCommit = await I.gitCurrentCommit('git', repoDir)
    // peer edits x AND deletes it, in two commits; also add y for the not-pushed check
    const peer = join(tmp, 'peer')
    await sh(['clone', bareRepo, peer])
    await fsp.writeFile(join(peer, 'skills', 'dsh', 'x', 'SKILL.md'), 'base\nremote edit\n')
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer edits x'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    const rec1 = await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots: STRAT_ROOTS(live) })
    assert.equal(rec1.applied.length, 1, 'remote strategy overwrites local edit')
    assert.equal(fs.readFileSync(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'utf8'), 'base\nremote edit\n', 'remote wins')
    // push must NOT carry the group (local is a read-only mirror)
    await fsp.writeFile(join(live, '.dsh', 'skills', 'x', 'SKILL.md'), 'base\nlocal should not push\n')
    const push = await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots: STRAT_ROOTS(live) })
    assert.equal(push.nothingToCommit, true, 'remote-strategy group content is never pushed (nothing else to commit)')
    // peer deletes x → live file removed too
    await fsp.rm(join(peer, 'skills', 'dsh', 'x', 'SKILL.md'))
    await gitNoUser(['add', '-A'], peer)
    await gitNoUser(['commit', '-m', 'peer deletes x'], peer)
    await sh(['push', bareRepo, 'main'], peer)
    await I.reconcileRemote('git', eff, { repoDir, state, logger: { warn: () => {} }, roots: STRAT_ROOTS(live) })
    assert.ok(!fs.existsSync(join(live, '.dsh', 'skills', 'x', 'SKILL.md')), 'deletion mirrored under remote-wins')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

test('strategy backup: push lands in backup/<instanceId>/, never overwrites shared tree', async () => {
  const tmp = await mkdtemp()
  const bareRepo = await mkRepo(tmp)
  const repoDir = join(tmp, 'repo')
  const live = join(tmp, 'live')
  await fsp.mkdir(join(live, '.dsh', 'skills', 'own'), { recursive: true })
  await fsp.writeFile(join(live, '.dsh', 'skills', 'own', 'SKILL.md'), '# my own skill\n')
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, skillsStrategy: 'backup', token: '' }
  const state = { instanceId: 'testhost-bk' }
  try {
    const push = await I.runPush('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} }, roots: STRAT_ROOTS(live) })
    assert.equal(push.pushed, true)
    const blob = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:backup/testhost-bk/skills/dsh/own/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.ok(blob.includes('# my own skill'), 'own backup lands under backup/<instanceId>/')
    // shared tree untouched: base file x still at its original content
    const shared = await new Promise((res, rej) => execFile('git', ['show', `${state.lastPushedBranch}:skills/dsh/x/SKILL.md`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.equal(shared, 'base\n', 'shared tree not overwritten by backup strategy')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

// ── Snapshots: local-first, cloud on explicit opt-in ─────────────────────

test('snapshotMirrorSpec + sanitizeSnapshotName', () => {
  const roots = { dshSkills: '/dsh', agentsSkills: '/a', agentsLock: '/l', sessions: '/s', settingsFile: '/st', profiles: '/p' }
  const spec = I.snapshotMirrorSpec({ syncSkills: true, syncSessions: true, syncSettings: true, syncPlugins: true, snapshotSkills: false }, roots, 'inst-1', 'auto-2026-09-09')
  const names = spec.map(g => g.name).sort().join(',')
  assert.equal(names, 'plugins,settings', 'sessions excluded, skills excluded by default')
  const settingsSrc = spec.find(g => g.name === 'settings').sources[0]
  assert.equal(settingsSrc.to, 'snapshots/auto-2026-09-09/settings/settings.yaml', 'snapshots/<name>/ prefix')
  const withSkills = I.snapshotMirrorSpec({ syncSkills: true, syncSessions: true, syncSettings: true, syncPlugins: true, snapshotSkills: true }, roots, 'inst-1', 'x')
  assert.ok(withSkills.some(g => g.name === 'skills'), 'skills included when opted in')
  assert.ok(!withSkills.some(g => g.name === 'sessions'), 'sessions always excluded')
  assert.equal(I.sanitizeSnapshotName('  发版前 <ok>:v1? '), '发版前-ok-v1')
  assert.equal(I.sanitizeSnapshotName('///'), '')
})

test('pruneLocalSnapshots: rolling window, manual-unclouded exempt', async () => {
  const tmp = await mkdtemp()
  const dir = join(tmp, 'snapshots')
  const mk = async (name) => { await fsp.mkdir(join(dir, name), { recursive: true }); await fsp.writeFile(join(dir, name, 'f.txt'), name) }
  for (const n of ['auto-2026-01-0' + 1, 'auto-2026-01-02', 'manual-my-keep', 'manual-not-in-cloud', 'pre-restore-x']) await mk(n)
  const removed = await I.pruneLocalSnapshots(dir, 3, ['manual-my-keep'])
  // sorted desc: manual-not-in-cloud, pre-restore-x, manual-my-keep, auto-02, auto-01 → keep 3, prune 2 oldest
  assert.deepEqual(removed.sort(), ['auto-2026-01-01', 'auto-2026-01-02'], 'oldest auto/prerestore pruned')
  assert.ok(fs.existsSync(join(dir, 'manual-not-in-cloud')), 'manual unclouded never auto-pruned')
  assert.deepEqual(await I.pruneLocalSnapshots(dir, 10, []), [], 'keep above count prunes nothing')
})

test('promoteSnapshotToCloud: bare remote gets snapshot tree on pushed branch', async () => {
  const tmp = await mkdtemp()
  const bareRepo = await mkRepo(tmp)
  const repoDir = join(tmp, 'repo')
  const srcDir = join(tmp, 'snap', 'manual-v1')
  await fsp.mkdir(join(srcDir, 'settings'), { recursive: true })
  await fsp.writeFile(join(srcDir, 'settings', 'settings.yaml'), 'provider: snap\n')
  const eff = { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', token: '' }
  const state = { instanceId: 'testhost-snap' }
  try {
    await I.ensureShadowRepo('git', { repoUrl: bareRepo, branch: 'main', gitBinary: 'git', token: '' }, repoDir)
    const r = await I.promoteSnapshotToCloud('git', eff, { repoDir, instanceId: state.instanceId, state, logger: { warn: () => {} } }, 'manual-v1', srcDir)
    assert.equal(r.promoted, true)
    assert.equal(r.prSkipped, true, 'non-GitCode remote pushes branch directly')
    const blob = await new Promise((res, rej) => execFile('git', ['show', `${r.branch}:backup/testhost-snap/snapshots/manual-v1/settings/settings.yaml`], { cwd: repoDir }, (e, o) => e ? rej(e) : res(String(o))))
    assert.equal(blob, 'provider: snap\n', 'snapshot content landed under backup/<id>/snapshots/<name>/')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
