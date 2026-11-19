/*
 * Service worker do Guard no navegador. Só ele fala com a plataforma: o content script do site
 * de IA nunca vê a credencial. A credencial fica em chrome.storage.local.
 */
importScripts('logic.js')
var L = self.AiubyGuardLogic

var TIMEOUT_MS = 8000
var CONFIG_MAX_AGE_MS = 5 * 60 * 1000
var EXTRA_SCRIPT_ID = 'aiuby-guard-extra'

function readSettings() {
  return chrome.storage.local.get(['platform', 'token', 'config', 'configAt'])
}

async function call(settings, path, init) {
  var controller = new AbortController()
  var timer = setTimeout(function () {
    controller.abort()
  }, TIMEOUT_MS)
  try {
    var headers = Object.assign({ authorization: 'Bearer ' + settings.token }, (init && init.headers) || {})
    var response = await fetch(settings.platform + path, Object.assign({}, init, { headers: headers, signal: controller.signal, credentials: 'omit', cache: 'no-store' }))
    var body = null
    try {
      body = await response.json()
    } catch (e) {
      body = null
    }
    return { status: response.status, body: body }
  } catch (e) {
    return { status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

async function refreshConfig(settings) {
  var result = await call(settings, '/api/guard/v1/config')
  if (result.status !== 200 || !result.body) return { ok: false, status: result.status, message: errorMessage(result) }
  await chrome.storage.local.set({ config: result.body, configAt: Date.now() })
  return { ok: true, config: result.body }
}

function errorMessage(result) {
  var message = result.body && result.body.error && result.body.error.message
  return typeof message === 'string' && message.length <= 400 ? message : null
}

function failMode(settings) {
  return settings.config && settings.config.failMode === 'open' ? 'open' : 'closed'
}

async function decide(message) {
  var settings = await readSettings()
  if (!settings.platform || !settings.token) return { ok: false, failure: 'not_configured' }
  if (!settings.configAt || Date.now() - settings.configAt > CONFIG_MAX_AGE_MS) {
    await refreshConfig(settings)
    settings = await readSettings()
  }
  var body = { destination: String(message.destination || ''), action: message.action, text: String(message.text || '') }
  if (message.approval) body.approval = { id: message.approval.id, secret: message.approval.secret }
  var result = await call(settings, '/api/guard/v1/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (result.status === 200 && result.body) return { ok: true, data: result.body }
  if (L.isFailureStatus(result.status)) return { ok: false, failure: 'unreachable', failMode: failMode(settings), status: result.status }
  return { ok: false, failure: 'refused', message: errorMessage(result), status: result.status }
}

async function poll(message) {
  var settings = await readSettings()
  if (!settings.platform || !settings.token) return { ok: false }
  var result = await call(settings, '/api/guard/v1/approvals/' + encodeURIComponent(String(message.id || '')))
  if (result.status !== 200 || !result.body) return { ok: false, status: result.status }
  return { ok: true, data: result.body }
}

/** Liga o content script nos destinos extras do workspace que já têm permissão do site. */
async function syncExtraScripts() {
  var settings = await readSettings()
  var hosts = L.extraDestinations(settings.config)
  var granted = []
  for (var i = 0; i < hosts.length; i++) {
    var patterns = L.patternsFor([hosts[i]])
    if (await chrome.permissions.contains({ origins: patterns })) granted = granted.concat(patterns)
  }
  var existing = await chrome.scripting.getRegisteredContentScripts({ ids: [EXTRA_SCRIPT_ID] })
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [EXTRA_SCRIPT_ID] })
  if (granted.length === 0) return { hosts: 0 }
  await chrome.scripting.registerContentScripts([
    { id: EXTRA_SCRIPT_ID, matches: granted, js: ['logic.js', 'content.js'], runAt: 'document_start', persistAcrossSessions: true },
  ])
  return { hosts: granted.length / 2 }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // Só as páginas da própria extensão e os content scripts dela mandam mensagens.
  if (!message || sender.id !== chrome.runtime.id) return false
  var job
  if (message.type === 'decide') job = decide(message)
  else if (message.type === 'poll') job = poll(message)
  else if (message.type === 'test') job = readSettings().then(refreshConfig)
  else if (message.type === 'sync') job = syncExtraScripts()
  else return false
  job.then(sendResponse, function () {
    sendResponse({ ok: false, failure: 'unreachable', failMode: 'closed' })
  })
  return true
})

chrome.permissions.onRemoved.addListener(function () {
  syncExtraScripts().catch(function () {})
})
