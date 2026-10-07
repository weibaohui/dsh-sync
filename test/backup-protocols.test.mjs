/**
 * dsh-sync multi-protocol backup tests.
 *
 * 纯备份协议（webdav / local）：协议解析矩阵、备份布局 staging、增量上传
 * （sha1 清单）、本地 tmp-swap 镜像、快照上云与按协议回退恢复。WebDAV 用
 * in-process http 服务器仿真（PROPFIND/MKCOL/PUT/GET/DELETE/HEAD 全部真
 * 走 HTTP wire），不发外网请求。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
// ⚠️ 必须在加载插件前隔离 DSH_HOME：插件会在 apply 时读取
// $DSH_HOME/settings.yaml.imported 做设置迁移，宿主 runSync 也会写
// $DSH_HOME/dsh-sync/state.json。不隔离的话，测试会在开发机上触发真实
// 同步（真机实证过一次：harness 迁移到了真实 repoUrl 并跑了一轮备份）。
process.env.DSH_HOME = fs.mkdtempSync(join(tmpdir(), 'dshsync-home-'))
const ISO_HOME = process.env.DSH_HOME
const I = require('../src/index.js').__internals
const W = require('../src/webdav.js')
const B = require('../src/backup.js')

const mkdtemp = async () => fsp.mkdtemp(join(tmpdir(), 'dshsync-bp-'))
const write = async (p, s) => { await fsp.mkdir(join(p, '..'), { recursive: true }); await fsp.writeFile(p, s) }
/** 一个"已关闭"的真实端口：连接立刻被 RST（写死 127.0.0.1:1 这类低端口在
 *  CI runner 上的防火墙行为不可控，曾让 wire 测试在 GitHub Actions 挂死）。 */
async function mkDeadUrl() {
  const s = createServer(() => {})
  await new Promise((fulfil) => s.listen(0, '127.0.0.1', fulfil))
  const url = 'http://127.0.0.1:' + s.address().port
  await new Promise((fulfil) => s.close(fulfil))
  return url
}

// ── 伪 WebDAV 服务器：内存树 + 真 HTTP ───────────────────────────────────

async function mkDavServer({ auth = null } = {}) {
  const tree = new Map()   // decoded posix path ('/a/b') → { dir:true } | { buf:Buffer }
  const treeSet = (p, v) => tree.set(p, v)
  const log = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/+$/, '') || '/'
      log.push({ method: req.method, path: p })
      if (auth) {
        const expect = 'Basic ' + Buffer.from(auth).toString('base64')
        if (req.headers.authorization !== expect) { res.writeHead(401); res.end(); return }
      }
      const ensureParents = (path) => {
        const parts = path.split('/').filter(Boolean)
        for (let i = 1; i < parts.length; i++) {
          const anc = '/' + parts.slice(0, i).join('/')
          if (!tree.has(anc)) tree.set(anc, { dir: true })
        }
      }
      const entry = tree.get(p)
      if (req.method === 'OPTIONS') { res.writeHead(200, { DAV: '1,2' }); res.end(); return }
      if (req.method === 'MKCOL') {
        if (entry) { res.writeHead(405); res.end(); return }
        ensureParents(p)
        tree.set(p, { dir: true })
        res.writeHead(201); res.end(); return
      }
      if (req.method === 'PUT') {
        if (entry && entry.dir) { res.writeHead(409); res.end(); return }
        ensureParents(p)
        tree.set(p, { buf: body })
        res.writeHead(201); res.end(); return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!entry || entry.dir) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Length': entry.buf.length })
        res.end(req.method === 'GET' ? entry.buf : undefined); return
      }
      if (req.method === 'DELETE') {
        if (!entry) { res.writeHead(404); res.end(); return }
        for (const k of [...tree.keys()]) if (k === p || k.startsWith(p + '/')) tree.delete(k)
        res.writeHead(204); res.end(); return
      }
      if (req.method === 'PROPFIND') {
        if (!entry) { res.writeHead(404); res.end(); return }
        const depth = req.headers.depth === undefined ? 'infinity' : String(req.headers.depth)
        const base = p === '/' ? '' : p
        const items = [p]
        if (depth === '1') {
          for (const k of tree.keys()) {
            // 必须是 base 的真子节点（startsWith(base + '/')）——简单的
            // k.slice(base.length) 会让同前缀兄弟（skills vs settings）漏进来
            if (base && !k.startsWith(base + '/')) continue
            const rel = base ? k.slice(base.length + 1) : k.slice(1)
            if (!rel || rel.includes('/')) continue
            items.push(k)
          }
        }
        const xml = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
          items.map((k) => {
            const e = tree.get(k)
            const href = k === '/' ? '/' : k + (e.dir ? '/' : '')
            return '<D:response><D:href>' + encodeURI(href) + '</D:href><D:propstat><D:prop>' +
              (e.dir
                ? '<D:resourcetype><D:collection/></D:resourcetype>'
                : '<D:resourcetype/><D:getcontentlength>' + e.buf.length + '</D:getcontentlength>') +
              '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
          }).join('') + '</D:multistatus>'
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        res.end(xml); return
      }
      res.writeHead(405); res.end()
    })
  })
  await new Promise((fulfil) => server.listen(0, '127.0.0.1', fulfil))
  const url = 'http://127.0.0.1:' + server.address().port
  return {
    server, tree, treeSet, log, url,
    // undici 的全局连接池会 keep-alive 复用 TCP 连接，server.close() 要等连接
    // 断开才回调——CI 上有 keep-alive 残留时最多挂 5s/台，极端情况永续。
    // closeAllConnections 立刻掐掉所有连接，close() 立即返回。
    close: () => new Promise((f) => {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      server.close(() => f())
    }),
  }
}

// ── WebDAV client wire tests ─────────────────────────────────────────────

test('joinUrl / basicAuth / parseMultistatus', () => {
  assert.equal(W.joinUrl('https://dav.example.com/dav/', 'backup/x'), 'https://dav.example.com/dav/backup/x')
  assert.equal(W.joinUrl('https://dav.example.com', ''), 'https://dav.example.com')
  assert.equal(W.joinUrl('https://dav.example.com', 'a b/中文.txt'), 'https://dav.example.com/a%20b/%E4%B8%AD%E6%96%87.txt')
  assert.equal(W.basicAuth('u', 'p'), 'Basic ' + Buffer.from('u:p').toString('base64'))
  assert.equal(W.basicAuth('', ''), null)
  const withPrefix = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
    '<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>' +
    '<D:response><D:href>/dav/a.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>' +
    '</D:multistatus>'
  const parsed = W.parseMultistatus(withPrefix)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], { href: '/dav/', dir: true, size: 0 })
  assert.deepEqual(parsed[1], { href: '/dav/a.txt', dir: false, size: 3 })
  // 无前缀命名空间 + 全 URL href 同样解析
  const noPrefix = '<multistatus xmlns="DAV:">' +
    '<response><href>https://dav.example.com/dav/dir/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
    '</multistatus>'
  const parsed2 = W.parseMultistatus(noPrefix)
  assert.equal(parsed2.length, 1)
  assert.equal(parsed2[0].dir, true)
  assert.equal(parsed2[0].href, '/dav/dir/')
})

test('webdav client: auth enforced, probe/mkdirs/put/get/list/delete roundtrip', async () => {
  const srv = await mkDavServer({ auth: 'u:p' })
  try {
    const bad = W.createWebdavClient({ url: srv.url, username: 'u', password: 'wrong', basePath: 'sync' })
    const badProbe = await bad.probe()
    assert.equal(badProbe.ok, false, 'wrong password refused')
    const c = W.createWebdavClient({ url: srv.url, username: 'u', password: 'p', basePath: 'sync' })
    assert.equal((await c.probe()).ok, true)
    await c.mkdirs('backup/inst-1/skills')
    await c.putFile('backup/inst-1/skills/SKILL.md', Buffer.from('# hi'))
    const buf = await c.getFile('backup/inst-1/skills/SKILL.md')
    assert.equal(buf.toString('utf8'), '# hi')
    assert.equal(await c.getFile('backup/inst-1/nope'), null)
    const items = await c.listDir('backup/inst-1')
    assert.equal(items.length, 1, 'self excluded from depth-1 listing')
    assert.deepEqual(items[0], { name: 'skills', dir: true, size: 0 })
    const missing = await c.listDir('backup/nowhere')
    assert.equal(missing, null, 'missing dir → null')
    assert.equal(await c.deletePath('backup/inst-1/skills/SKILL.md'), true)
    assert.equal(await c.deletePath('backup/inst-1/skills/SKILL.md'), true, '404 tolerated as deleted')
    assert.equal(await c.getFile('backup/inst-1/skills/SKILL.md'), null)
  } finally { await srv.close() }
})

test('webdav syncTreeFromDir: incremental against sha1 manifest + delete propagation', async () => {
  const srv = await mkDavServer()
  try {
    const tmp = await mkdtemp()
    const stage = join(tmp, 'stage')
    await write(join(stage, 'a', 'SKILL.md'), 'alpha')
    await write(join(stage, 'b', 'c.txt'), 'ccc')
    const c = W.createWebdavClient({ url: srv.url, basePath: 'dav' })
    let manifest = {}
    const r1 = await c.syncTreeFromDir(stage, 'backup/i1', { manifest })
    assert.equal(r1.uploaded.length, 2)
    assert.equal(r1.unchanged, 0)
    manifest = r1.newManifest
    const putsAfterR1 = srv.log.filter((e) => e.method === 'PUT').length
    // 第二轮全不变：零 PUT
    const r2 = await c.syncTreeFromDir(stage, 'backup/i1', { manifest })
    assert.equal(r2.uploaded.length, 0)
    assert.equal(r2.unchanged, 2)
    assert.equal(srv.log.filter((e) => e.method === 'PUT').length, putsAfterR1, 'no PUTs when unchanged')
    // 改一个 + 加一个 + 删一个 → 2 PUT + 1 DELETE
    await write(join(stage, 'a', 'SKILL.md'), 'alpha v2')
    await write(join(stage, 'd.txt'), 'ddd')
    await fsp.rm(join(stage, 'b'), { recursive: true, force: true })
    const r3 = await c.syncTreeFromDir(stage, 'backup/i1', { manifest })
    assert.equal(r3.uploaded.length, 2)
    assert.deepEqual(r3.deleted, ['b/c.txt'])
    assert.equal((await c.getFile('backup/i1/a/SKILL.md')).toString(), 'alpha v2')
    assert.equal(await c.getFile('backup/i1/b/c.txt'), null, 'remote deletion propagated')
    // force=true 全量重传
    const r4 = await c.syncTreeFromDir(stage, 'backup/i1', { manifest: r3.newManifest, force: true })
    assert.equal(r4.uploaded.length, 2)
    // 远端不可达且有待传文件时报错（失败不清 manifest，下一轮自动重试）
    await write(join(stage, 'e.txt'), 'eee')
    await srv.close()
    await assert.rejects(c.syncTreeFromDir(stage, 'backup/i1', { manifest: r3.newManifest }))
  } finally { await srv.close().catch(() => {}) }
})

test('webdav downloadTreeInto restores a full tree', async () => {
  const srv = await mkDavServer()
  try {
    const tmp = await mkdtemp()
    const c = W.createWebdavClient({ url: srv.url, basePath: 'dav' })
    const snap = join(tmp, 'snap')
    await write(join(snap, 'settings', 'settings.yaml'), 'k: v\n')
    await write(join(snap, 'skills', 'dsh', 'x', 'SKILL.md'), '# x')
    await c.uploadDirTree(snap, 'backup/i1/snapshots/snap-a')
    const dest = join(tmp, 'restored')
    await c.downloadTreeInto('backup/i1/snapshots/snap-a', dest)
    assert.equal(fs.readFileSync(join(dest, 'settings', 'settings.yaml'), 'utf8'), 'k: v\n')
    assert.equal(fs.readFileSync(join(dest, 'skills', 'dsh', 'x', 'SKILL.md'), 'utf8'), '# x')
    await assert.rejects(c.downloadTreeInto('backup/i1/snapshots/missing', join(tmp, 'nope')), /not found/)
  } finally { await srv.close() }
})

// ── 备份 tree helpers（backup.js）──

test('backup.js: walkFiles/hashTree/planTreeSync/localMirrorSwap', async () => {
  const tmp = await mkdtemp()
  const src = join(tmp, 'src')
  await write(join(src, 'a.txt'), 'aaa')
  await write(join(src, 'n', 'b.txt'), 'bbb')
  const files = await B.walkFiles(src)
  assert.equal(files.length, 2)
  assert.deepEqual(files.map((f) => f.rel).sort(), ['a.txt', 'n/b.txt'])
  const hashes = await B.hashTree(files)
  const plan0 = B.planTreeSync(files, hashes, {}, {})
  assert.equal(plan0.uploads.length, 2)
  const manifest = { 'a.txt': hashes.get('a.txt'), 'n/b.txt': hashes.get('n/b.txt') }
  const planSame = B.planTreeSync(files, hashes, manifest, {})
  assert.equal(planSame.uploads.length, 0)
  assert.equal(planSame.unchanged.length, 2)
  const changed = new Map(hashes); changed.set('a.txt', 'deadbeef')
  const planDiff = B.planTreeSync(files, changed, manifest, {})
  assert.deepEqual(planDiff.uploads, ['a.txt'])
  assert.equal(planDiff.deletes.length, 0)
  const planGone = B.planTreeSync(files.filter((f) => f.rel !== 'n/b.txt'), changed, manifest, {})
  assert.deepEqual(planGone.deletes, ['n/b.txt'])
  const planForce = B.planTreeSync(files, hashes, manifest, { force: true })
  assert.equal(planForce.uploads.length, 2)
  // localMirrorSwap：覆盖 + 删除传播 + 原子（目标要么旧要么新）
  const dest = join(tmp, 'dest')
  await write(join(dest, 'stale', 'old.txt'), 'old')
  const r = await B.localMirrorSwap(src, dest)
  assert.equal(r.count, 2)
  assert.ok(fs.existsSync(join(dest, 'a.txt')))
  assert.ok(!fs.existsSync(join(dest, 'stale')), 'stale tree replaced (delete propagation)')
  await assert.rejects(B.localMirrorSwap(join(tmp, 'missing-src'), join(tmp, 'd2')), /ENOENT|no such/i)
})

// ── 协议解析与 staging ───────────────────────────────────────────────────

test('resolveBackupProtocols / gitProtocolOn matrix', () => {
  assert.deepEqual(I.resolveBackupProtocols({}), [])
  assert.equal(I.gitProtocolOn({ repoUrl: 'https://x', token: 't' }), true)
  assert.equal(I.gitProtocolOn({ repoUrl: 'https://x', token: 't', gitEnabled: false }), false)
  assert.equal(I.gitProtocolOn({ repoUrl: 'https://x' }), false)
  assert.equal(I.gitProtocolOn({ token: 't' }), false)
  const wd = I.resolveBackupProtocols({ webdavEnabled: true, webdavUrl: 'https://x/dav', webdavUsername: 'u', webdavPassword: 'p', webdavDir: 'sub' })
  assert.deepEqual(wd, [{ kind: 'webdav', url: 'https://x/dav', username: 'u', password: 'p', basePath: 'sub' }])
  const wdNoDir = I.resolveBackupProtocols({ webdavEnabled: true, webdavUrl: 'https://x/dav' })
  assert.equal(wdNoDir[0].basePath, 'dsh-sync', 'default basePath')
  assert.equal(I.resolveBackupProtocols({ webdavEnabled: true }).length, 0, 'enabled without url → skipped')
  const lo = I.resolveBackupProtocols({ localEnabled: true, localDir: '~/dsh-backups' })
  assert.equal(lo.length, 1)
  assert.equal(lo[0].kind, 'local')
  assert.equal(lo[0].dir, join(homedir(), 'dsh-backups'), 'tilde expanded')
})

test('stageBackupTree mirrors enabled groups into the git backup layout', async () => {
  const tmp = await mkdtemp()
  const live = join(tmp, 'live')
  await write(join(live, 'skills', 'foo', 'SKILL.md'), '# foo')
  await write(join(live, 'agents-home', 'bar', 'SKILL.md'), '# bar')
  await write(join(live, 'settings.yaml'), 'k: v\n')
  const roots = {
    dshSkills: join(live, 'skills'), agentsSkills: join(live, 'nope-agents'),
    agentsLock: join(live, 'nope-lock'), homeAgentsSkills: join(live, 'agents-home'),
    sessions: join(live, 'nope-s'),
    settingsFile: join(live, 'settings.yaml'), profiles: join(live, 'nope-p'),
  }
  // 策略故意用 union：纯备份协议一律强制 backup 布局
  const eff = { syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false, skillsStrategy: 'union', settingsStrategy: 'union' }
  const root = await I.stageBackupTree(eff, roots, 'inst-7', join(tmp, 'staging'))
  assert.equal(root, join(tmp, 'staging', 'backup', 'inst-7'))
  assert.equal(fs.readFileSync(join(root, 'skills', 'dsh', 'foo', 'SKILL.md'), 'utf8'), '# foo')
  assert.equal(fs.readFileSync(join(root, 'skills', 'agents-home', 'bar', 'SKILL.md'), 'utf8'), '# bar')
  assert.equal(fs.readFileSync(join(root, 'settings', 'settings.yaml'), 'utf8'), 'k: v\n')
  const bspec = I.backupLayoutSpec(eff, roots, 'inst-7')
  assert.equal(I.strategyForPath(bspec, 'backup/inst-7/skills/dsh/foo/SKILL.md'), 'backup')
})

// ── uploadBackupToOne / runBackupUpload 集成 ────────────────────────────

test('uploadBackupToOne: webdav increments via manifest, local swaps atomically', async () => {
  const srv = await mkDavServer()
  try {
    const tmp = await mkdtemp()
    const stage = join(tmp, 'stage')
    await write(join(stage, 'skills', 'dsh', 'foo', 'SKILL.md'), '# foo')
    await write(join(stage, 'settings', 'settings.yaml'), 'k: v\n')
    const syncDir = join(tmp, 'syncdir')
    const wproto = { kind: 'webdav', url: srv.url, username: '', password: '', basePath: 'sync' }
    const r1 = await I.uploadBackupToOne(wproto, stage, { instanceId: 'inst-9', syncDir })
    assert.equal(r1.ok, true)
    assert.equal(r1.uploaded, 2)
    const r2 = await I.uploadBackupToOne(wproto, stage, { instanceId: 'inst-9', syncDir })
    assert.equal(r2.uploaded, 0)
    assert.equal(r2.unchanged, 2, 'second run fully unchanged')
    await write(join(stage, 'skills', 'dsh', 'foo', 'SKILL.md'), '# foo v2')
    await fsp.rm(join(stage, 'settings'), { recursive: true, force: true })
    const r3 = await I.uploadBackupToOne(wproto, stage, { instanceId: 'inst-9', syncDir })
    assert.equal(r3.uploaded, 1)
    assert.equal(r3.deleted, 1)
    assert.equal((await (W.createWebdavClient({ url: srv.url, basePath: 'sync' })).getFile('backup/inst-9/skills/dsh/foo/SKILL.md')).toString(), '# foo v2')
    // local：镜像 + 删除传播
    const localTarget = join(tmp, 'localtarget')
    const lproto = { kind: 'local', dir: localTarget }
    const l1 = await I.uploadBackupToOne(lproto, stage, { instanceId: 'inst-9' })
    assert.equal(l1.ok, true)
    assert.equal(l1.count, 1)
    assert.equal(fs.readFileSync(join(localTarget, 'backup', 'inst-9', 'skills', 'dsh', 'foo', 'SKILL.md'), 'utf8'), '# foo v2')
    await write(join(stage, 'new.txt'), 'n')
    const l2 = await I.uploadBackupToOne(lproto, stage, { instanceId: 'inst-9' })
    assert.equal(l2.count, 2)
    assert.ok(fs.existsSync(join(localTarget, 'backup', 'inst-9', 'new.txt')))
  } finally { await srv.close() }
})

test('runBackupUpload: single protocol failure does not affect the other', async () => {
  const srv = await mkDavServer()
  try {
    const tmp = await mkdtemp()
    const live = join(tmp, 'live')
    await write(join(live, 'settings.yaml'), 'k: v\n')
    const roots = {
      dshSkills: join(live, 'nope-skills'), agentsSkills: join(live, 'nope-a'),
      agentsLock: join(live, 'nope-l'), homeAgentsSkills: join(live, 'nope-ha'),
      sessions: join(live, 'nope-s'), settingsFile: join(live, 'settings.yaml'), profiles: join(live, 'nope-p'),
    }
    const eff = { syncSkills: true, syncSessions: false, syncSettings: true, syncPlugins: false }
    // webdav 指向已关闭端口 → 失败；local 指向 tmp → 成功
    const deadUrl = await mkDeadUrl()
    const effWd = { ...eff, webdavEnabled: true, webdavUrl: deadUrl, localEnabled: true, localDir: join(tmp, 'lt') }
    const out = await I.runBackupUpload(effWd, { instanceId: 'inst-3', syncDir: join(tmp, 'sd'), roots })
    assert.equal(out.local.ok, true)
    assert.equal(out.webdav.ok, false)
    assert.ok(out.webdav.error, 'webdav error recorded')
    // 全部成功路径
    const effOk = { ...eff, webdavEnabled: true, webdavUrl: srv.url, localEnabled: true, localDir: join(tmp, 'lt2') }
    const out2 = await I.runBackupUpload(effOk, { instanceId: 'inst-3', syncDir: join(tmp, 'sd2'), roots })
    assert.equal(out2.webdav.ok, true)
    assert.equal(out2.local.ok, true)
    assert.ok(fs.existsSync(join(tmp, 'lt2', 'backup', 'inst-3', 'settings', 'settings.yaml')))
  } finally { await srv.close() }
})

// ── 快照上云 / 恢复回退 ──────────────────────────────────────────────────

test('snapshot promote + fetch roundtrip via webdav and local', async () => {
  const srv = await mkDavServer()
  try {
    const tmp = await mkdtemp()
    const snap = join(tmp, 'snap-a')
    await write(join(snap, 'settings', 'settings.yaml'), 'owner: me\n')
    await write(join(snap, 'skills', 'dsh', 'x', 'SKILL.md'), '# x')
    const wproto = { kind: 'webdav', url: srv.url, username: '', password: '', basePath: 'sync' }
    const lproto = { kind: 'local', dir: join(tmp, 'lt') }
    const pw = await I.promoteSnapshotToProtocol(wproto, snap, { instanceId: 'inst-5', snapName: 'snap-a' })
    assert.equal(pw.ok, true)
    assert.equal(pw.uploaded, 2)
    await I.promoteSnapshotToProtocol(lproto, snap, { instanceId: 'inst-5', snapName: 'snap-a' })
    assert.ok(fs.existsSync(join(tmp, 'lt', 'backup', 'inst-5', 'snapshots', 'snap-a', 'settings', 'settings.yaml')))
    // 从 webdav 下载
    const dest1 = join(tmp, 'd1')
    await I.fetchSnapshotFromProtocol(wproto, { instanceId: 'inst-5', snapName: 'snap-a' }, dest1)
    assert.equal(fs.readFileSync(join(dest1, 'skills', 'dsh', 'x', 'SKILL.md'), 'utf8'), '# x')
    // 从 local 下载
    const dest2 = join(tmp, 'd2')
    await I.fetchSnapshotFromProtocol(lproto, { instanceId: 'inst-5', snapName: 'snap-a' }, dest2)
    assert.equal(fs.readFileSync(join(dest2, 'settings', 'settings.yaml'), 'utf8'), 'owner: me\n')
    // 没有的快照 → 抛错（供调用方继续回退）
    await assert.rejects(I.fetchSnapshotFromProtocol(wproto, { instanceId: 'inst-5', snapName: 'nope' }, join(tmp, 'd3')), /not found/)
  } finally { await srv.close() }
})

// ── HTTP API：设置白名单 / 协议测试 / 状态投影 ───────────────────────────

function makeHarness(config = {}, { keepSettingsFile = false } = {}) {
  const routes = []
  // 默认关掉调度器：apply() 会 fire startup auto-sync，与测试自身的 POST /sync
  // 抢同一把锁/同一个 syncRun，在 CI 上制造过 20 分钟的测试间卡死（真机实证）。
  // 需要验证调度行为的用例显式传 autoSync 覆盖。
  //
  // 自持 settings.json（0.4.3 起的跨重启持久化层）默认清掉：多数用例只想验证
  // 「传入的 config → 行为」这一段，不该被同一 DSH_HOME 下前一个用例保存的值
  // 污染。专门验证持久化的用例传 keepSettingsFile: true。
  if (!keepSettingsFile) {
    try { fs.rmSync(join(ISO_HOME, 'dsh-sync', 'settings.json'), { force: true }) } catch {}
  }
  const doc = { sync: { autoSync: false, syncOnStartup: false, ...JSON.parse(JSON.stringify(config)) } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: {
      describe: () => [{ ns: 'dsh-sync', value: JSON.parse(JSON.stringify(doc)), user: {} }],
      update: async (ns, patch) => { Object.assign(doc.sync, patch.sync || {}) },
      mutate: async (ns, ops) => {
        for (const op of ops) if (op.op === 'unset') delete doc.sync[op.path[op.path.length - 1]]
      },
    },
    connection: { requestRejection: () => undefined },
    effect: (f) => f(),
    on: () => () => {},
    get: () => undefined,
    sessions: {},
    inject: () => {},
    webServer: { register: (route) => routes.push(route) },
  }
  const plugin = require('../src/index.js')
  plugin.apply(ctx, { sync: config })
  const call = async (method, path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method, url: path, headers: {},
      on(ev, cb) { if (ev === 'data') chunks.forEach((c) => cb(c)); if (ev === 'end') cb() },
    }
    const res = { statusCode: null, body: null }
    res.writeHead = (s, h) => { res.statusCode = s; res.headers = h }
    res.end = (payload) => { res.body = payload }
    await routes[0].handler(req, res)
    let json = null
    try { json = JSON.parse(res.body) } catch {}
    return { status: res.statusCode, json }
  }
  return { routes, doc, call, home: ISO_HOME }
}

test('PUT settings: protocol fields whitelisted, webdavPassword never echoed', async () => {
  const h = makeHarness({})
  const put = await h.call('PUT', '/dsh-sync/api/settings', {
    gitEnabled: false, webdavEnabled: true, webdavUrl: 'https://dav.x/dav', webdavUsername: 'u',
    webdavPassword: 'sekret', webdavDir: 'mysub', localEnabled: true, localDir: '~/bt', token: 'tok',
  })
  assert.equal(put.status, 200)
  assert.equal(put.json.settings.webdavEnabled, true)
  assert.equal(put.json.settings.webdavUrl, 'https://dav.x/dav')
  assert.equal(put.json.settings.localDir, '~/bt')
  assert.equal(put.json.settings.webdavPassword, undefined, 'password never echoed')
  assert.equal(put.json.settings.token, undefined, 'token never echoed')
  assert.equal(put.json.settings.gitEnabled, false)
  // 空串密码不覆盖已存值
  const put2 = await h.call('PUT', '/dsh-sync/api/settings', { webdavPassword: '' })
  assert.equal(h.doc.sync.webdavPassword, 'sekret')
  // null 显式清除
  await h.call('PUT', '/dsh-sync/api/settings', { webdavPassword: null })
  assert.equal(h.doc.sync.webdavPassword, undefined)
  void put2
})

test('status reflects protocol state; sync without any protocol is refused', async () => {
  const h = makeHarness({ webdavEnabled: true, webdavUrl: 'https://dav.x/dav', webdavDir: 'sub', syncSkills: false })
  const st = await h.call('GET', '/dsh-sync/api/status')
  assert.equal(st.status, 200)
  assert.equal(st.json.protocols.git.configured, false)
  assert.equal(st.json.protocols.webdav.enabled, true)
  assert.equal(st.json.protocols.webdav.configured, true)
  assert.equal(st.json.protocols.webdav.dir, 'sub')
  assert.equal(st.json.protocols.local.enabled, false)
  assert.equal(st.json.hasPassword, undefined, 'no password leak on status')
  // 什么协议都没配 → 拒绝同步
  const hEmpty = makeHarness({})
  const sync = await hEmpty.call('POST', '/dsh-sync/api/sync', {})
  assert.equal(sync.status, 400, 'no protocol at all → refused: ' + JSON.stringify(sync.json && sync.json.error))
  assert.ok(/未启用任何/.test(sync.json.error))
  // 只配了 webdav（无 git）→ sync 不再因缺 git 仓库而被拒（仓库不可达记为该协议备份失败）
  // staging 里放一个 settings 文件，确保确有内容要上传（空树会零请求"成功"）
  await write(join(ISO_HOME, 'settings.yaml'), 'k: v\n')
  const h2 = makeHarness({ webdavEnabled: true, webdavUrl: (await mkDeadUrl()) + '/dav', gitEnabled: false, autoSync: false, syncSkills: false })
  const sync2 = await h2.call('POST', '/dsh-sync/api/sync', {})
  assert.equal(sync2.status, 200, JSON.stringify(sync2.json && sync2.json.error))
  assert.equal(sync2.json.backup.webdav.ok, false, 'unreachable webdav recorded as failed backup')
})

// 回归 m00001「点保存配置 → 重启 dsh 后回到默认」：宿主 settings 写回失败（线上日志
// No configurable plugin entry "dsh-sync"）时，保存必须靠自持 settings.json 跨重启生效。
test('保存的设置跨重启保留：自持 settings.json 托住宿主写回失败', async () => {
  const h = makeHarness({})
  const put = await h.call('PUT', '/dsh-sync/api/settings', {
    repoUrl: 'https://gitcode.com/me/private.git', intervalMinutes: 45, autoSync: false, skillsStrategy: 'union',
  })
  assert.equal(put.status, 200)
  assert.equal(put.json.persist.fileOk, true, 'settings.json 未写成功: ' + JSON.stringify(put.json.persist))
  // 模拟重启 dsh：同一 DSH_HOME、全新 apply，且 config 为空（= 宿主写回失败后的真实状态）
  const reborn = makeHarness({}, { keepSettingsFile: true })
  const st = await reborn.call('GET', '/dsh-sync/api/status')
  assert.equal(st.json.intervalMinutes, 45, '重启后回到默认值 ⟹ 本 bug 未修好')
  assert.equal(st.json.repoUrl, 'https://gitcode.com/me/private.git')
  assert.equal(st.json.strategies.skills, 'union', '策略也要跨重启保留')
  const diag = await reborn.call('GET', '/dsh-sync/api/diag')
  assert.ok(diag.json.fileSettingsKeys.includes('intervalMinutes'), JSON.stringify(diag.json.fileSettingsKeys))
  assert.equal(diag.json.schemaKind === 'none', false, 'Config 必须已导出（宿主据此判定可配置）')
})

test('token/webdavPassword 进自持文件但不回显，null 可清除', async () => {
  // 干净起点：带上一个已存在的 repoUrl 会让 token 触发私仓硬校验（外网调用）
  const h = makeHarness({})
  const put = await h.call('PUT', '/dsh-sync/api/settings', { token: 'ghp_secret', webdavPassword: 'dav_secret' })
  assert.equal(put.status, 200)
  assert.equal(put.json.settings.token, undefined, 'token never echoed')
  assert.equal(put.json.settings.webdavPassword, undefined, 'password never echoed')
  const raw = fs.readFileSync(join(h.home, 'dsh-sync', 'settings.json'), 'utf8')
  assert.ok(raw.includes('ghp_secret') && raw.includes('dav_secret'), '凭据必须随其它设置一起跨重启保留')
  const st = await h.call('GET', '/dsh-sync/api/status')
  assert.equal(st.json.token, undefined)
  assert.equal(st.json.webdavPassword, undefined)
  await h.call('PUT', '/dsh-sync/api/settings', { token: null, webdavPassword: null })
  const raw2 = fs.readFileSync(join(h.home, 'dsh-sync', 'settings.json'), 'utf8')
  assert.equal(raw2.includes('ghp_secret'), false, 'null 清除后文件里不应再有旧 token')
  assert.equal(raw2.includes('dav_secret'), false)
})

test('POST protocol/test: local ok, webdav against fake server, unknown kind refused', async () => {
  const srv = await mkDavServer({ auth: 'u:p' })
  try {
    const tmp = await mkdtemp()
    const h = makeHarness({})
    const local = await h.call('POST', '/dsh-sync/api/protocol/test', { protocol: 'local', dir: tmp })
    assert.equal(local.json.ok, true, 'local probe failed: ' + (local.json && local.json.error))
    // 坏路径用「文件下面的目录」（ENOTDIR 秒失败）——/proc 这类虚拟文件系统上的
    // 递归 mkdir 在 Linux 上会挂住不返回（真机实证：CI 卡死 120s 的根因）
    const blocker = join(tmp, 'blocker')
    await fsp.writeFile(blocker, 'x')
    const localBad = await h.call('POST', '/dsh-sync/api/protocol/test', { protocol: 'local', dir: join(blocker, 'child') })
    assert.equal(localBad.json.ok, false)
    const wd = await h.call('POST', '/dsh-sync/api/protocol/test', { protocol: 'webdav', url: srv.url, username: 'u', password: 'p', dir: 'sub' })
    assert.equal(wd.json.ok, true, 'webdav probe failed: ' + (wd.json && wd.json.error))
    const wdBad = await h.call('POST', '/dsh-sync/api/protocol/test', { protocol: 'webdav', url: srv.url, username: 'u', password: 'nope', dir: 'sub' })
    assert.equal(wdBad.json.ok, false)
    const unknown = await h.call('POST', '/dsh-sync/api/protocol/test', { protocol: 'carrier-pigeon' })
    assert.equal(unknown.status, 400)
  } finally { await srv.close() }
})

// 0.4.4 保存语义：'' = 保持不变（旧客户端整表单提交），null = 显式清除；
// 响应回传 applied/ignored，面板才能区分"保存成功"和"什么都没保存"。
test('SETTINGS semantics: null clears, empty string keeps, applied/ignored reported', async () => {
  const h = makeHarness({ repoUrl: 'https://gitcode.com/me/private.git', branch: 'main' })
  const put1 = await h.call('PUT', '/dsh-sync/api/settings', { repoUrl: '', branch: 'dev', intervalMinutes: 12 })
  assert.equal(put1.status, 200)
  assert.equal(h.doc.sync.repoUrl, 'https://gitcode.com/me/private.git', '空串不得清掉已存仓库地址')
  assert.equal(put1.json.ignored.includes('repoUrl'), true, JSON.stringify(put1.json.ignored))
  assert.deepEqual([...put1.json.applied].sort(), ['branch', 'intervalMinutes'])
  // null = 清除：内存 overrides、自持文件、宿主文档三处都要删，否则重启会被 doc 层带回来
  const put2 = await h.call('PUT', '/dsh-sync/api/settings', { repoUrl: null })
  assert.equal(put2.status, 200)
  assert.equal(h.doc.sync.repoUrl, undefined, '宿主文档未清除')
  assert.equal(put2.json.settings.repoUrl, '', '清除后状态里应为默认空值')
  assert.ok(put2.json.cleared.includes('repoUrl'))
  assert.ok(put2.json.applied.includes('repoUrl'))
  const fileJson = JSON.parse(fs.readFileSync(join(ISO_HOME, 'dsh-sync', 'settings.json'), 'utf8'))
  assert.equal('repoUrl' in fileJson, false, '自持文件必须同步清除')
  // 模拟重启「且宿主写回失败」：config 层（cordis.patch.yml 的 config.sync）仍留着旧
  // repoUrl，墓碑必须把它压回默认值，否则"清除"在重启后复活
  const reborn = makeHarness({ repoUrl: 'https://gitcode.com/me/private.git' }, { keepSettingsFile: true })
  const st = await reborn.call('GET', '/dsh-sync/api/status')
  assert.equal(st.json.repoUrl, '', '重启后应仍是空')
  // gitAvailable 走 60s 缓存：连续两次 status 都必须是布尔且不抛
  const st2 = await reborn.call('GET', '/dsh-sync/api/status')
  assert.equal(typeof st2.json.gitAvailable, 'boolean')
})

test('SETTINGS semantics: nothing-applied save is reported as such', async () => {
  const h = makeHarness({})
  const put = await h.call('PUT', '/dsh-sync/api/settings', { repoUrl: '', branch: '' })
  assert.equal(put.status, 200)
  assert.deepEqual(put.json.applied, [], '空表单不应报告写了任何键: ' + JSON.stringify(put.json.applied))
  assert.ok(put.json.ignored.includes('repoUrl') && put.json.ignored.includes('branch'))
})

// 0.4.5：托管方支持 —— 已知 provider 自动查私有性，自建/未知主机判不了 ⇒
// 400 UNVERIFIED_REPO（needConfirm），客户端确认后带 allowUnverifiedRepo 重发。
test('PUT settings: provider 私有性判定与 UNVERIFIED_REPO 二次确认', async () => {
  const orig = globalThis.fetch
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(String(url) + ' ' + JSON.stringify((init && init.headers) || {}))
    if (String(url).includes('api.github.com/repos/me/public-repo')) return mk({ private: false })
    if (String(url).includes('api.github.com/repos/me/private-repo')) return mk({ private: true, default_branch: 'main' })
    return mk({ message: 'not found' }, 404)
  }
  try {
    // 公共 GitHub 仓库 → 拒绝，并给出 isPublic 供面板提示
    const h1 = makeHarness({})
    const pub = await h1.call('PUT', '/dsh-sync/api/settings', { repoUrl: 'https://github.com/me/public-repo.git', token: 'tok' })
    assert.equal(pub.status, 400, JSON.stringify(pub.json))
    assert.equal(pub.json.isPublic, true)
    // 私有 GitHub 仓库 → 放行，状态里回显 provider
    const h2 = makeHarness({})
    const priv = await h2.call('PUT', '/dsh-sync/api/settings', { repoUrl: 'https://github.com/me/private-repo.git', token: 'tok' })
    assert.equal(priv.status, 200, JSON.stringify(priv.json && priv.json.error))
    const st2 = await h2.call('GET', '/dsh-sync/api/status')
    assert.equal(st2.json.provider.kind, 'github')
    assert.equal(st2.json.provider.unverified, false)
    // 自建主机：未确认 → 400 UNVERIFIED_REPO；确认后放行
    const h3 = makeHarness({})
    const un = await h3.call('PUT', '/dsh-sync/api/settings', { repoUrl: 'https://git.internal.corp/team/repo.git', token: 'tok' })
    assert.equal(un.status, 400, JSON.stringify(un.json))
    assert.equal(un.json.code, 'UNVERIFIED_REPO')
    assert.equal(un.json.needConfirm, true)
    assert.equal(un.json.host, 'git.internal.corp')
    assert.ok(/泄露/.test(un.json.error), '文案要说清泄露风险: ' + un.json.error)
    const ok = await h3.call('PUT', '/dsh-sync/api/settings', { repoUrl: 'https://git.internal.corp/team/repo.git', token: 'tok', allowUnverifiedRepo: true })
    assert.equal(ok.status, 200, JSON.stringify(ok.json && ok.json.error))
    assert.equal(ok.json.settings.repoUrl, 'https://git.internal.corp/team/repo.git')
    const st3 = await h3.call('GET', '/dsh-sync/api/status')
    assert.equal(st3.json.provider.kind, 'generic')
    assert.equal(st3.json.provider.unverified, true)
    assert.equal(st3.json.provider.host, 'git.internal.corp')
    // GitHub 走 Bearer header，token 不进 URL
    assert.ok(seen.some(s => s.includes('Bearer')), seen.join(' | '))
    // seen 条目是 "URL headers"，只看 URL 段（Bearer header 里当然有 tok）
    assert.ok(!seen.some(s => /github\.com\/repos.*tok/.test(s.split(' ')[0])), 'token 不得出现在 URL 里')
  } finally { globalThis.fetch = orig }
})

