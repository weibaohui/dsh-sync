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
