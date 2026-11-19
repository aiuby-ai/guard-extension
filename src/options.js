/* Opções: endereço da plataforma e credencial, guardados só em chrome.storage.local. */
;(function () {
  'use strict'
  var L = globalThis.AiubyGuardLogic
  var form = document.getElementById('form')
  var platformInput = document.getElementById('platform')
  var tokenInput = document.getElementById('token')
  var statusEl = document.getElementById('status')

  function show(text) {
    statusEl.textContent = text
  }

  function describe(config) {
    var extra = L.extraDestinations(config)
    var lines = [
      'Conectado. Modo de falha: ' + (config.failMode === 'open' ? 'aberto (deixa passar com aviso).' : 'fechado (bloqueia até a plataforma responder).'),
      'Destinos permitidos: ' + ((config.destinations && config.destinations.allowed.length) ? config.destinations.allowed.join(', ') : 'nenhum cadastrado') + '.',
      'Destinos bloqueados: ' + ((config.destinations && config.destinations.blocked.length) ? config.destinations.blocked.join(', ') : 'nenhum') + '.',
    ]
    if (extra.length) lines.push('Fora da lista padrão (precisam de permissão): ' + extra.join(', ') + '.')
    return lines.join('\n')
  }

  chrome.storage.local.get(['platform', 'token']).then(function (s) {
    platformInput.value = s.platform || L.DEFAULT_PLATFORM
    if (s.token) tokenInput.placeholder = 'credencial salva (cole outra para trocar)'
    tokenInput.required = !s.token
  })

  form.addEventListener('submit', async function (e) {
    e.preventDefault()
    var platform = L.normalizePlatform(platformInput.value)
    if (!platform) return show('Endereço inválido: use https://, como https://aiuby.com.')
    var token = tokenInput.value.trim()
    var saved = await chrome.storage.local.get(['token'])
    if (token && !L.isToken(token)) return show('A credencial não está no formato da AIUBY (aiuby_...). Copie de novo da tela de credenciais.')
    if (!token && !saved.token) return show('Cole a credencial.')
    var pattern = L.originPattern(platform)
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
      var granted = await chrome.permissions.request({ origins: [pattern] })
      if (!granted) return show('Sem a permissão para falar com ' + platform + ', a extensão não consegue conferir.')
    }
    var next = { platform: platform, config: null, configAt: 0 }
    if (token) next.token = token
    await chrome.storage.local.set(next)
    tokenInput.value = ''
    tokenInput.required = false
    show('Testando…')
    var result = await chrome.runtime.sendMessage({ type: 'test' })
    if (result && result.ok) {
      await chrome.runtime.sendMessage({ type: 'sync' })
      return show(describe(result.config))
    }
    var reason = result && result.message ? result.message : result && result.status === 0 ? 'a plataforma não respondeu.' : 'a plataforma recusou (HTTP ' + (result && result.status) + ').'
    show('Configuração salva, mas o teste falhou: ' + reason)
  })

  document.getElementById('clear').addEventListener('click', async function () {
    await chrome.storage.local.remove(['token', 'config', 'configAt'])
    tokenInput.required = true
    tokenInput.placeholder = 'aiuby_...'
    show('Credencial removida deste navegador.')
  })

  document.getElementById('extra').addEventListener('click', async function () {
    var s = await chrome.storage.local.get(['config'])
    var hosts = L.extraDestinations(s.config)
    if (!hosts.length) return show('O workspace não tem destinos fora da lista padrão. Teste a conexão para atualizar a lista.')
    var granted = await chrome.permissions.request({ origins: L.patternsFor(hosts) })
    if (!granted) return show('Permissão não concedida. Os destinos extras ficam sem conferência neste navegador.')
    var result = await chrome.runtime.sendMessage({ type: 'sync' })
    show('Ativado em ' + (result && result.hosts) + ' destino(s): ' + hosts.join(', ') + '. Recarregue as abas abertas desses sites.')
  })
})()
