'use strict'

/**
 * dsh-plugin-dsh-sync — zero-dependency WebDAV client.
 *
 * Backup target #2: any WebDAV endpoint (Nextcloud / 坚果云 / Alist /
 * InfiniCloud …) reached with plain HTTP verbs — MKCOL to create ancestor
 * dirs, PUT/GET for file bytes, PROPFIND Depth:1 for listings, DELETE for
 * mirror deletions. Auth is Basic; requests carry a per-call timeout via
 * AbortSignal. No XML dependency: the 207 multistatus body is parsed with a
 * namespace-tolerant regex (handles `D:`, `d:`, and prefix-free servers).
 *
 * All wire methods take paths relative to the DAV root (basePath included);
 * `fetchImpl` is injectable so the contract tests drive a real in-process
 * HTTP server without touching the network.
 */

const fsP = require('node:fs/promises')
const { join } = require('node:path')
const { walkFiles, hashTree, planTreeSync } = require('./backup.js')

const encSeg = (s) => encodeURIComponent(s)

/** Join a base URL with a posix-style rel path, encoding each segment. */
function joinUrl(base, rel) {
  const b = String(base || '').replace(/\/+$/, '')
  const parts = String(rel || '').split('/').filter(Boolean)
  if (!b) return parts.length ? '/' + parts.map(encSeg).join('/') : '/'
  return b + (parts.length ? '/' + parts.map(encSeg).join('/') : '')
}

/** Join two root-relative paths (no encoding — both sides are already
 *  root-relative wire paths). */
function relJoin(a, b) {
  const left = String(a || '').replace(/\/+$/, '')
  const right = String(b || '').replace(/^\/+|\/+$/g, '')
  return left && right ? `${left}/${right}` : (left || right)
}

function basicAuth(username, password) {
  if (!username && !password) return null
  return 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')
}

function decodeTry(s) { try { return decodeURIComponent(s || '') } catch { return s || '' } }

const rxBlock = /<(?:[A-Za-z][A-Za-z0-9.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z][A-Za-z0-9.-]*:)?response>/gi
const rxLocal = (local) => new RegExp(`<(?:[A-Za-z][A-Za-z0-9.-]*:)?${local}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z][A-Za-z0-9.-]*:)?${local}>`, 'i')
const rxCollection = /<(?:[A-Za-z][A-Za-z0-9.-]*:)?collection(?:\s[^>]*)?\/?>/i

/** Parse a 207 multistatus body → [{ href(decoded), dir, size }]. */
function parseMultistatus(xml) {
  const out = []
  for (const m of String(xml || '').matchAll(rxBlock)) {
    const block = m[1]
    const hrefM = block.match(rxLocal('href'))
    if (!hrefM) continue
    let href = hrefM[1].trim()
    if (href.includes('://')) { try { href = new URL(href).pathname } catch {} }
    const decoded = decodeTry(href)
    const lenM = block.match(rxLocal('getcontentlength'))
    out.push({ href: decoded, dir: rxCollection.test(block) || /\/$/.test(decoded), size: lenM ? parseInt(lenM[1], 10) : 0 })
  }
  return out
}

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'

function createWebdavClient({ url, username = '', password = '', basePath = '', fetchImpl, timeoutMs = 60 * 1000, concurrency = 6 }) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis)
  const root = joinUrl(url, basePath)
  const baseDir = decodeTry((() => { try { return new URL(root).pathname } catch { return '' } })())
  const auth = basicAuth(username, password)
  const ok2xx = (r) => r.status >= 200 && r.status < 300
  const drain = (r) => r.arrayBuffer().catch(() => {})

  async function request(method, rel, { headers = {}, body, depth, abs } = {}) {
    const hdrs = { ...headers }
    if (auth) hdrs.authorization = auth
    if (depth !== undefined) hdrs.depth = String(depth)
    if (body !== undefined && !hdrs['content-type']) hdrs['content-type'] = 'application/octet-stream'
    return doFetch(abs !== undefined ? abs : joinUrl(root, rel), { method, headers: hdrs, body, signal: AbortSignal.timeout(timeoutMs) })
  }

  /** MKCOL the configured basePath itself, segment by segment, under the DAV
   *  root (NOT under <root>, which already contains it). mkdirs() only creates
   *  rel paths *below* <root>, so a basePath that doesn't exist yet makes the
   *  first MKCOL <root>/backup return 409 (RFC 4918: parent collection missing;
   *  坚果云实测). 405 (already exists) / 301 tolerated; cached after first
   *  success. basePath 为空时循环零次，零请求。 */
  let baseReady = false
  async function ensureBase() {
    if (baseReady) return true
    const davRoot = String(url || '').replace(/\/+$/, '')
    const done = []
    for (const part of String(basePath || '').split('/').filter(Boolean)) {
      done.push(part)
      const r = await request('MKCOL', '', { abs: joinUrl(davRoot, done.join('/')) })
      await drain(r)
      if (!ok2xx(r) && r.status !== 405 && r.status !== 301) throw new Error(`MKCOL ${done.join('/')}: HTTP ${r.status}`)
    }
    baseReady = true
    return true
  }

  /** PROPFIND Depth:0 on the DAV root — the connection test. 404 counts as
   *  reachable+authenticated with a baseMissing note: the base dir usually
   *  only materializes on the first backup (ensureBase), and a missing path
   *  must not read as "server down". */
  async function probe() {
    const r = await request('PROPFIND', '', { depth: 0, headers: { 'content-type': 'application/xml' }, body: PROPFIND_BODY })
    await drain(r)
    if (r.status === 404) return { ok: true, baseMissing: true }
    if (!ok2xx(r)) return { ok: false, error: `PROPFIND HTTP ${r.status}` }
    return { ok: true }
  }

  /** MKCOL each ancestor in turn; 405 (already exists) / 301 tolerated. */
  async function mkdirs(rel) {
    await ensureBase()
    const parts = String(rel || '').split('/').filter(Boolean)
    let cum = ''
    for (const part of parts) {
      cum = cum ? `${cum}/${part}` : part
      const r = await request('MKCOL', cum)
      await drain(r)
      if (!ok2xx(r) && r.status !== 405 && r.status !== 301) throw new Error(`MKCOL ${cum}: HTTP ${r.status}`)
    }
    return true
  }

  async function putFile(rel, content) {
    const r = await request('PUT', rel, { body: content })
    await drain(r)
    if (!ok2xx(r)) throw new Error(`PUT ${rel}: HTTP ${r.status}`)
    return true
  }

  /** GET a file → Buffer; 404 → null. */
  async function getFile(rel) {
    const r = await request('GET', rel)
    if (r.status === 404) { await drain(r); return null }
    if (!ok2xx(r)) { await drain(r); throw new Error(`GET ${rel}: HTTP ${r.status}`) }
    return Buffer.from(await r.arrayBuffer())
  }

  async function exists(rel) {
    try {
      const buf = await getFile(rel)
      return buf !== null
    } catch { return false }
  }

  async function deletePath(rel) {
    const r = await request('DELETE', rel)
    await drain(r)
    if (ok2xx(r) || r.status === 404) return true
    throw new Error(`DELETE ${rel}: HTTP ${r.status}`)
  }

  /** PROPFIND Depth:1 → [{ name, dir, size }] with the collection itself
   *  excluded; 404 → null. Hrefs are matched against the configured base
   *  path so both absolute-path and full-URL hrefs work. */
  async function listDir(rel) {
    const r = await request('PROPFIND', rel, { depth: 1, headers: { 'content-type': 'application/xml' }, body: PROPFIND_BODY })
    if (r.status === 404) { await drain(r); return null }
    if (!ok2xx(r)) { await drain(r); throw new Error(`PROPFIND ${rel}: HTTP ${r.status}`) }
    const xml = await r.text()
    const relNorm = '/' + String(rel || '').replace(/^\/+|\/+$/g, '')
    const out = []
    for (const entry of parseMultistatus(xml)) {
      let p = entry.href.split('?')[0]
      if (p.startsWith(baseDir)) p = p.slice(baseDir.length)
      p = '/' + p.replace(/^\/+|\/+$/g, '')
      if (p === relNorm) continue
      const name = p.split('/').filter(Boolean).pop()
      if (!name) continue
      out.push({ name, dir: entry.dir, size: entry.size })
    }
    return out
  }

  /** Bounded parallel runner. */
  async function pool(items, worker) {
    const queue = [...items]
    const n = Math.max(1, Math.min(concurrency, queue.length))
    await Promise.all(Array.from({ length: n }, async () => {
      while (queue.length) await worker(queue.shift())
    }))
  }

  /** Upload a local directory tree under relDest (no manifest — used for
   *  snapshot promotion; re-promoting the same name overwrites in place).
   *  Returns the uploaded file count. */
  async function uploadDirTree(localDir, relDest) {
    const files = await walkFiles(localDir)
    await mkdirs(relDest)
    const parents = [...new Set(files.map(f => f.rel.split('/').slice(0, -1).join('/')))].filter(Boolean)
    for (const parent of parents) await mkdirs(relJoin(relDest, parent))
    await pool(files, async (f) => { await putFile(relJoin(relDest, f.rel), await fsP.readFile(f.abs)) })
    return files.length
  }

  /** Incremental mirror of a staged local dir onto <root>/<relDest> against
   *  a sha1 manifest: PUT new/changed, DELETE vanished. `newManifest` is only
   *  the caller's to persist after full success — a failed run leaves it
   *  untouched so the next run retries the same set. */
  async function syncTreeFromDir(localDir, relDest, { manifest = {}, force = false } = {}) {
    const files = await walkFiles(localDir)
    const hashes = await hashTree(files)
    const plan = planTreeSync(files, hashes, manifest, { force })
    const byRel = new Map(files.map(f => [f.rel, f]))
    if (plan.uploads.length) await mkdirs(relDest)
    const parents = [...new Set(plan.uploads.map(rel => rel.split('/').slice(0, -1).join('/')))].filter(Boolean)
    for (const parent of parents) await mkdirs(relJoin(relDest, parent))
    const failed = []
    await pool(plan.uploads, async (rel) => {
      try { await putFile(relJoin(relDest, rel), await fsP.readFile(byRel.get(rel).abs)) }
      catch (e) { failed.push(`${rel}: ${e && e.message}`) }
    })
    await pool(plan.deletes, async (rel) => {
      try { await deletePath(relJoin(relDest, rel)) }
      catch (e) { failed.push(`${rel}: ${e && e.message}`) }
    })
    if (failed.length) throw new Error(`WebDAV 同步 ${failed.length} 个文件失败: ${failed.slice(0, 3).join(' | ')}`)
    const newManifest = {}
    for (const [rel, sha] of hashes) newManifest[rel] = sha
    return { uploaded: plan.uploads, deleted: plan.deletes, unchanged: plan.unchanged.length, newManifest }
  }

  /** Recursively download <root>/<relSrc> into destDir (snapshot restore).
   *  404 anywhere → throws 'not found' so callers can fall through to the
   *  next protocol. */
  async function downloadTreeInto(relSrc, destDir, depth = 0) {
    if (depth > 24) throw new Error('目录嵌套过深，放弃下载')
    const items = await listDir(relSrc)
    if (items === null) throw new Error('not found: ' + relSrc)
    await fsP.mkdir(destDir, { recursive: true })
    for (const item of items) {
      const childRel = relJoin(relSrc, item.name)
      const childAbs = join(destDir, item.name)
      if (item.dir) await downloadTreeInto(childRel, childAbs, depth + 1)
      else {
        const buf = await getFile(childRel)
        if (buf === null) throw new Error('not found: ' + childRel)
        await fsP.writeFile(childAbs, buf)
      }
    }
    return true
  }

  return { probe, mkdirs, putFile, getFile, exists, deletePath, listDir, uploadDirTree, syncTreeFromDir, downloadTreeInto, __root: root }
}

module.exports = { createWebdavClient, joinUrl, relJoin, basicAuth, parseMultistatus }
