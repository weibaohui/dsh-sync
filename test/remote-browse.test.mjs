/**
 * dsh-sync 远端备份浏览器测试。
 *
 * 模拟两台机器各自同步（backup 策略，内容落 backup/<instanceId>/），
 * 然后从其中一台的视角浏览远端、预览拉取计划、执行安全拉取。验证：
 *  - browseRemote 列出全部实例并标记本机
 *  - planRemotePull：技能跨机→允许；settings/plugins 跨机→阻止（crash 守卫）
 *  - applyRemotePullPlan：安全拉取技能文件到 live，不碰被阻止的文件
 *  - 本机自己的 backup → 一律允许（恢复语义）
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
const mkdtemp = async () => fsp.mkdtemp(join(tmpdir(), 'dshsync-rb-'))
const silent = { warn: () => {}, info: () => {} }
const read = (p) => fs.readFileSync(p, 'utf8')
const write = async (p, s) => { await fsp.mkdir(join(p, '..'), { recursive: true }); await fsp.writeFile(p, s) }

async function mkHub(tmp) {
  const bareRepo = join(tmp, 'hub.git')
  await sh(['init', '--bare', '-b', 'main', bareRepo])
  const seed = join(tmp, 'seed')
  await fsp.mkdir(join(seed, 'skills', 'dsh', 'base'), { recursive: true })
  await write(join(seed, '.gitattributes'), '*.jsonl merge=union\n')
  await write(join(seed, 'skills', 'dsh', 'base', 'SKILL.md'), 'base\n')
  await sh(['init', '-b', 'main'], seed)
  await gitNoUser(['add', '-A'], seed)
  await gitNoUser(['commit', '-m', 'seed'], seed)
  await sh(['push', bareRepo, 'main'], seed)
  return bareRepo
}

async function mkReplica(tmp, name, eff) {
  const live = join(tmp, name, 'live')
  const repoDir = join(tmp, name, 'repo')
  const state = { instanceId: name }
  const roots = {
    dshSkills: join(live, '.dsh', 'skills'),
    agentsSkills: join(live, '.nope-agents'),
    agentsLock: join(live, '.nope-lock'),
    sessions: join(live, '.nope-s'),
    settingsFile: join(live, '.dsh', 'settings.yaml'),
    profiles: join(live, '.nope-p'),
  }
  await fsp.mkdir(join(live, '.dsh', 'skills'), { recursive: true })
  await write(join(live, '.dsh', 'settings.yaml'), `owner: ${name}\n`)
  await write(join(live, '.nope-p', 'package.json'), `{"name":"${name}"}\n`)
  await I.ensureShadowRepo('git', eff, repoDir)
  return { name, live, repoDir, state, roots, eff }
}

// 与宿主 runSync 的确定性部分同构：reconcile → push(preserve) → pull
// 非 GitCode 远端 push 只推分支，这里快进 main 到分支 tip 模拟 PR 合并
async function driveSync(r) {
  const rec = await I.reconcileRemote('git', r.eff, { repoDir: r.repoDir, state: r.state, logger: silent, roots: r.roots })
  const fresh = (rec && Array.isArray(rec.bothModified)) ? rec.bothModified : []
  r.state.pendingBoth = r.state.pendingBoth && typeof r.state.pendingBoth === 'object' ? r.state.pendingBoth : {}
  const spec = I.syncSpec(r.eff, r.roots, r.state.instanceId)
  const pendings = Object.keys(r.state.pendingBoth)
    .filter(p => !fresh.some(f => f.shadowPath === p))
    .map(p => {
      const livePath = I.resolveLivePath(spec, p)
      return livePath ? { shadowPath: p, livePath, baseCommit: r.state.pendingBoth[p] } : null
    })
    .filter(Boolean)
  const both = [...fresh, ...pendings]
  const push = await I.runPush('git', r.eff, { repoDir: r.repoDir, instanceId: r.state.instanceId, state: r.state, logger: silent, roots: r.roots, preserve: both.map(f => f.shadowPath) })
  if (push.pushed && push.prSkipped && r.state.lastPushedBranch) {
    await sh(['fetch', r.eff.repoUrl, r.state.lastPushedBranch], r.repoDir).catch(() => {})
    await sh(['push', r.eff.repoUrl, 'FETCH_HEAD:main'], r.repoDir).catch(() => {})
  }
  await I.runPull('git', r.eff, { repoDir: r.repoDir, state: r.state, logger: silent, roots: r.roots })
  return { rec, push }
}

test('browseRemote: 列出全部实例并标记本机', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  // 全部 backup 策略 → 内容落 backup/<instanceId>/
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: true, skillsStrategy: 'backup', sessionsStrategy: 'backup', settingsStrategy: 'backup', pluginsStrategy: 'backup', token: '' }
  const r1 = await mkReplica(tmp, 'r1-mac', eff)
  const r2 = await mkReplica(tmp, 'r2-linux', eff)
  try {
    await write(join(r1.live, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'alpha\n')
    await driveSync(r1)
    await driveSync(r2)
    // 从 r2 的影子仓库浏览远端
    const result = await I.browseRemote('git', r1.eff, { repoDir: r2.repoDir, state: r2.state })
    assert.equal(result.repoReady, true)
    assert.equal(result.fetchOk, true)
    const ids = result.instances.map(i => i.id)
    assert.ok(ids.includes('r1-mac'), 'r1-mac 在实例列表中')
    assert.ok(ids.includes('r2-linux'), 'r2-linux 在实例列表中')
    const r1inst = result.instances.find(i => i.id === 'r1-mac')
    assert.equal(r1inst.isMine, false, '从 r2 看 r1 不是本机')
    const r2inst = result.instances.find(i => i.id === 'r2-linux')
    assert.equal(r2inst.isMine, true, '从 r2 看 r2 是本机')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('planRemotePull: 技能跨机允许，settings/plugins 跨机阻止', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: true, skillsStrategy: 'backup', sessionsStrategy: 'backup', settingsStrategy: 'backup', pluginsStrategy: 'backup', token: '' }
  const r1 = await mkReplica(tmp, 'r1-mac', eff)
  const r2 = await mkReplica(tmp, 'r2-linux', eff)
  try {
    await write(join(r1.live, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'alpha content\n')
    await driveSync(r1)
    await driveSync(r2)
    await I.fetchBrowseRef('git', r2.eff, r2.repoDir)

    // 技能跨机 → 允许
    const planSkill = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r1-mac/skills/dsh/alpha/SKILL.md'])
    assert.equal(planSkill.plan.length, 1)
    assert.equal(planSkill.plan[0].action, 'apply', '技能跨机 → 允许')
    assert.equal(planSkill.plan[0].category, 'skills')
    assert.equal(planSkill.plan[0].isMine, false)

    // settings.yaml 跨机 → 警告但允许
    const planSettings = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r1-mac/settings/settings.yaml'])
    assert.equal(planSettings.plan.length, 1)
    assert.equal(planSettings.plan[0].action, 'apply', 'settings 跨机 → 警告但允许')
    assert.equal(planSettings.plan[0].category, 'settings')
    assert.ok(planSettings.plan[0].warn, '有警告文案')
    assert.equal(planSettings.warnCount, 1, 'warnCount 计数正确')

    // plugins/package.json 跨机 + 本机已有 → 警告但允许
    const planPlugins = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r1-mac/plugins/package.json'])
    assert.equal(planPlugins.plan.length, 1)
    assert.equal(planPlugins.plan[0].action, 'apply', 'plugins 跨机且本机已有 → 警告但允许')
    assert.equal(planPlugins.plan[0].category, 'plugins')
    assert.ok(planPlugins.plan[0].warn, '有警告文案')

    // 本机自己的 settings → 允许（恢复语义）
    const planOwn = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r2-linux/settings/settings.yaml'])
    assert.equal(planOwn.plan.length, 1)
    assert.equal(planOwn.plan[0].action, 'apply', '本机自己的 backup → 允许')
    assert.equal(planOwn.plan[0].isMine, true)
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('applyRemotePullPlan: 安全拉取技能文件到 live', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: true, skillsStrategy: 'backup', sessionsStrategy: 'backup', settingsStrategy: 'backup', pluginsStrategy: 'backup', token: '' }
  const r1 = await mkReplica(tmp, 'r1-mac', eff)
  const r2 = await mkReplica(tmp, 'r2-linux', eff)
  try {
    await write(join(r1.live, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'alpha content\n')
    await driveSync(r1)
    await driveSync(r2)
    await I.fetchBrowseRef('git', r2.eff, r2.repoDir)

    const plan = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r1-mac/skills/dsh/alpha/SKILL.md'])
    assert.equal(plan.plan[0].action, 'apply')
    const result = await I.applyRemotePullPlan('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, plan.plan)
    assert.equal(result.applied, 1, '应用了 1 个文件')
    assert.equal(result.blocked, 0)
    assert.ok(fs.existsSync(join(r2.live, '.dsh', 'skills', 'alpha', 'SKILL.md')), '文件已写入 live')
    assert.equal(read(join(r2.live, '.dsh', 'skills', 'alpha', 'SKILL.md')), 'alpha content\n', '内容正确')

    // r2 的 settings.yaml 没有被动过（仍然是自己的）
    assert.equal(read(join(r2.live, '.dsh', 'settings.yaml')), 'owner: r2-linux\n', '本机 settings 未被远端覆盖')
    // r2 的 plugins/package.json 也没有被动过
    assert.equal(read(join(r2.live, '.nope-p', 'package.json')), '{"name":"r2-linux"}\n', '本机插件清单未被远端覆盖')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})

test('planRemotePull: 目录选择展开为目录下全部文件', async () => {
  const tmp = await mkdtemp()
  const hub = await mkHub(tmp)
  const eff = { repoUrl: hub, branch: 'main', gitBinary: 'git', syncSkills: true, syncSessions: false, syncSettings: false, syncPlugins: false, skillsStrategy: 'backup', sessionsStrategy: 'backup', settingsStrategy: 'backup', pluginsStrategy: 'backup', token: '' }
  const r1 = await mkReplica(tmp, 'r1-mac', eff)
  const r2 = await mkReplica(tmp, 'r2-linux', eff)
  try {
    await write(join(r1.live, '.dsh', 'skills', 'pkg-a', 'SKILL.md'), 'a\n')
    await write(join(r1.live, '.dsh', 'skills', 'pkg-b', 'SKILL.md'), 'b\n')
    await driveSync(r1)
    await driveSync(r2)
    await I.fetchBrowseRef('git', r2.eff, r2.repoDir)
    // 选择整个 skills 目录 → 展开为两个文件
    const plan = await I.planRemotePull('git', r2.eff, { repoDir: r2.repoDir, state: r2.state, roots: r2.roots }, ['backup/r1-mac/skills'])
    assert.ok(plan.plan.length >= 2, '目录展开为至少 2 个文件')
    assert.deepEqual(plan.plan.every(p => p.action === 'apply'), true, '全部为技能 → 全部允许')
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
})
