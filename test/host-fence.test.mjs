/**
 * Host-plane test: the /{prefix}/api route must sit behind the connection
 * trust fence (Host/Origin + browser auth) — cross-site calls get refused
 * with the rejection status before reaching any endpoint logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')

function makeHarness({ rejection, config = '{}'} = {}) {
  const routes = []
  const disposables = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { register: (ns, schema, opts) => ({ get: () => ({ ...((opts && opts.base) || {}) }), update: async () => {}, watch: () => {} }) },
    connection: { requestRejection: () => rejection },
    effect: (factory) => { const d = factory(); if (typeof d === 'function') disposables.push(d); return d },
    on: () => () => {},
    get: () => undefined,
    sessions: {},
    webServer: { register: (route) => routes.push(route) },
  }
  plugin.apply(ctx, config)
  return routes
}

function fakeReq(url) { return { method: 'GET', url, headers: {} } }
function fakeRes() {
  const res = { statusCode: null, body: null }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (payload) => { res.body = payload }
  return res
}

test('plugin injects the connection service for the trust fence', () => {
  assert.ok(plugin.inject.includes('connection'))
})

test('every route sits behind the connection trust fence', () => {
  const routes = makeHarness({ rejection: 401 })
  assert.ok(routes.length >= 1)
  for (const route of routes) {
    const res = fakeRes()
    route.handler(fakeReq('/dsh-sync/api/status'), res)
    assert.equal(res.statusCode, 401, 'unauthenticated request must be refused')
  }
})

test('fenced route serves requests once the fence allows', () => {
  const routes = makeHarness({ rejection: undefined })
  const res = fakeRes()
  routes[0].handler(fakeReq('/dsh-sync/api/status'), res)
  assert.notEqual(res.statusCode, 401, 'allowed request must not be refused by the fence')
})
