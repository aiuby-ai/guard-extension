/*
 * Guard no navegador: regras puras, sem DOM nem chrome.*. Usadas pelo service worker, pelo
 * content script, pelas opções e pelos testes da plataforma.
 */
;(function (root) {
  'use strict'

  var DEFAULT_PLATFORM = 'https://aiuby.com'
  var DEFAULT_DESTINATIONS = [
    'chatgpt.com',
    'chat.openai.com',
    'gemini.google.com',
    'claude.ai',
    'copilot.microsoft.com',
    'chat.deepseek.com',
    'www.perplexity.ai',
  ]
  var TOKEN_FORMAT = /^aiuby_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/

  /** Endereço da plataforma: só HTTPS (ou localhost para teste), sem caminho. `null` se inválido. */
  function normalizePlatform(value) {
    var raw = String(value || '').trim()
    if (!raw) return null
    var parsed
    try {
      parsed = new URL(raw.indexOf('://') === -1 ? 'https://' + raw : raw)
    } catch (e) {
      return null
    }
    var local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null
    if (parsed.username || parsed.password) return null
    return parsed.origin
  }

  function isToken(value) {
    return TOKEN_FORMAT.test(String(value || '').trim())
  }

  /** Padrão de permissão do Chrome para um endereço. */
  function originPattern(origin) {
    return origin.replace(/\/$/, '') + '/*'
  }

  function hostMatches(host, destination) {
    return host === destination || host.slice(-(destination.length + 1)) === '.' + destination
  }

  function isDefaultDestination(host) {
    return DEFAULT_DESTINATIONS.some(function (d) {
      return hostMatches(host, d)
    })
  }

  /** Destinos do workspace fora da lista padrão: pedem permissão opcional do site. */
  function extraDestinations(config) {
    if (!config || !config.destinations) return []
    var all = [].concat(config.destinations.allowed || [], config.destinations.blocked || [])
    return all.filter(function (h, i) {
      return typeof h === 'string' && all.indexOf(h) === i && !isDefaultDestination(h)
    })
  }

  function patternsFor(hosts) {
    return hosts.reduce(function (acc, h) {
      return acc.concat(['https://' + h + '/*', 'https://*.' + h + '/*'])
    }, [])
  }

  /*
   * Botão de envio dos sites de IA, pelo que é público da estrutura de cada um (sem navegar
   * logado): ChatGPT `data-testid="send-button"` / `id="composer-submit-button"`, rótulo
   * "Send prompt"/"Enviar prompt"; Claude e Gemini "Send message"/"Enviar mensagem" (Gemini
   * também com a classe `send-button`); Copilot "Submit message"; Perplexity
   * `data-testid="submit-button"`, rótulo "Submit". Rótulos em inglês e português.
   */
  var SEND_LABEL = /^(send|submit|enviar)( (a |o |the )?(message|mensagem|prompt|query|consulta|pergunta))?$/i
  var SEND_TEST_IDS = ['send-button', 'composer-send-button', 'fruitjuice-send-button', 'submit-button']
  var SEND_IDS = ['composer-submit-button']

  function looksLikeSendButton(button) {
    if (!button) return false
    var testId = String(button.testId || '').toLowerCase()
    if (SEND_TEST_IDS.indexOf(testId) !== -1) return true
    if (SEND_IDS.indexOf(String(button.id || '').toLowerCase()) !== -1) return true
    var classes = String(button.className || '').toLowerCase().split(/\s+/)
    if (classes.indexOf('send-button') !== -1) return true
    var label = String(button.ariaLabel || button.title || '').trim().replace(/\s+/g, ' ')
    return SEND_LABEL.test(label)
  }

  // ---- DOM: só tagName, getAttribute e parentElement, para testar com elementos simulados ----

  var TEXT_INPUT_TYPES = ['', 'text', 'search']
  var EDITABLE_VALUES = ['', 'true', 'plaintext-only']

  function attr(el, name) {
    var v = el && el.getAttribute ? el.getAttribute(name) : null
    return v == null ? null : String(v)
  }

  function tagOf(el) {
    return String((el && el.tagName) || '').toUpperCase()
  }

  /** Raiz de edição explícita: contenteditable vazio, "true" ou "plaintext-only" (sem caixa). */
  function isEditingHost(el) {
    var ce = attr(el, 'contenteditable')
    return ce !== null && EDITABLE_VALUES.indexOf(ce.trim().toLowerCase()) !== -1
  }

  function isTextField(el) {
    var tag = tagOf(el)
    if (tag === 'TEXTAREA') return true
    if (tag !== 'INPUT') return false
    return TEXT_INPUT_TYPES.indexOf(String(attr(el, 'type') || '').toLowerCase()) !== -1
  }

  /**
   * Campo de texto a partir do nó do evento: textarea, input de texto, editor contenteditable
   * (ProseMirror, Quill, Lexical) ou `role="textbox"`. Num editor, devolve a raiz de edição mais
   * externa (o clique costuma cair num <p> ou num chip `contenteditable="false"` dentro dele).
   */
  function editableHost(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node
    var found = null
    var depth = 0
    for (; el && depth < 64; el = el.parentElement, depth++) {
      if (tagOf(el) === 'INPUT') {
        if (found) break
        return isTextField(el) ? el : null
      }
      if (isTextField(el)) return found || el
      if (isEditingHost(el)) found = el
      else if (found) break
      else if (attr(el, 'role') === 'textbox') return el
    }
    return found
  }

  /** Elemento clicável que contém o nó: <button>, `role="button"` ou input de envio. */
  function buttonFrom(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node
    for (var depth = 0; el && depth < 16; el = el.parentElement, depth++) {
      var tag = tagOf(el)
      if (tag === 'BUTTON' || attr(el, 'role') === 'button') return el
      if (tag === 'INPUT') return /^(submit|button)$/i.test(attr(el, 'type') || '') ? el : null
    }
    return null
  }

  function buttonInfo(el) {
    if (!el) return null
    return {
      testId: attr(el, 'data-testid'),
      ariaLabel: attr(el, 'aria-label') || (tagOf(el) === 'INPUT' ? attr(el, 'value') : null),
      title: attr(el, 'title'),
      className: attr(el, 'class'),
      id: attr(el, 'id'),
    }
  }

  /** O clique foi num botão de envio? Desabilitado não conta (o site não enviaria). */
  function isSendClick(node) {
    var button = buttonFrom(node)
    if (!button || attr(button, 'disabled') !== null || attr(button, 'aria-disabled') === 'true') return null
    return looksLikeSendButton(buttonInfo(button)) ? button : null
  }

  var NOT_CONFIGURED = 'A extensão do Guard ainda não está configurada: este texto não foi conferido. Abra as opções da extensão.'
  var UNREACHABLE_OPEN = 'Não foi possível falar com a plataforma AIUBY. A política da empresa deixa seguir, mas este envio não foi conferido.'
  var UNREACHABLE_CLOSED = 'Não foi possível falar com a plataforma AIUBY, e a política da empresa bloqueia o envio até ela responder. Tente de novo em instantes.'

  /**
   * O que o content script faz com a resposta do service worker.
   * `proceed`: segue com o texto original. `insert`: cola o texto mascarado. `replace`: troca o
   * campo pelo texto mascarado e espera a pessoa enviar de novo. `wait`: aguarda aprovação.
   * `block`: não faz nada além de avisar.
   */
  function planAction(response, action) {
    if (!response || response.ok !== true) {
      var failure = response && response.failure
      if (failure === 'not_configured') return { kind: 'proceed', notice: NOT_CONFIGURED }
      if (failure === 'refused') return { kind: 'block', message: response.message || 'A plataforma recusou a conferência.' }
      var open = response && response.failMode === 'open'
      return open ? { kind: 'proceed', notice: UNREACHABLE_OPEN } : { kind: 'block', message: UNREACHABLE_CLOSED }
    }
    var data = response.data || {}
    var reason = typeof data.reason === 'string' ? data.reason : ''
    switch (data.decision) {
      case 'allow':
        return { kind: 'proceed', notice: data.reasonCode === 'approved' ? reason : null }
      case 'mask':
        if (typeof data.maskedText !== 'string') return { kind: 'block', message: 'Resposta da plataforma incompleta. Tente de novo.' }
        if (action === 'attach') return { kind: 'proceed', notice: reason }
        return { kind: action === 'paste' ? 'insert' : 'replace', text: data.maskedText, notice: reason }
      case 'require_approval':
        if (!data.approval) return { kind: 'proceed', notice: reason }
        return { kind: 'wait', approval: data.approval, notice: reason }
      case 'block':
        return { kind: 'block', message: reason || 'Bloqueado pela política da empresa.' }
      default:
        return { kind: 'block', message: 'Resposta da plataforma não reconhecida. Tente de novo.' }
    }
  }

  var STATUS_MESSAGES = {
    approved: 'Envio aprovado. Liberando uma vez.',
    rejected: 'O pedido foi recusado por quem administra o Guard. O texto não foi enviado.',
    expired: 'O pedido venceu sem decisão. Envie de novo para pedir outra aprovação.',
    used: 'Este envio aprovado já foi usado.',
  }

  function approvalMessage(status) {
    return STATUS_MESSAGES[status] || 'Aguardando aprovação de quem administra o Guard…'
  }

  function isFinalStatus(status) {
    return status === 'approved' || status === 'rejected' || status === 'expired' || status === 'used'
  }

  /** Respostas que contam como "a plataforma não respondeu" e seguem o modo de falha. */
  function isFailureStatus(status) {
    return status === 0 || status === 401 || status === 403 || status === 404 || status === 429 || status >= 500
  }

  var api = {
    DEFAULT_PLATFORM: DEFAULT_PLATFORM,
    DEFAULT_DESTINATIONS: DEFAULT_DESTINATIONS,
    normalizePlatform: normalizePlatform,
    isToken: isToken,
    originPattern: originPattern,
    hostMatches: hostMatches,
    isDefaultDestination: isDefaultDestination,
    extraDestinations: extraDestinations,
    patternsFor: patternsFor,
    looksLikeSendButton: looksLikeSendButton,
    editableHost: editableHost,
    buttonFrom: buttonFrom,
    buttonInfo: buttonInfo,
    isSendClick: isSendClick,
    planAction: planAction,
    approvalMessage: approvalMessage,
    isFinalStatus: isFinalStatus,
    isFailureStatus: isFailureStatus,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.AiubyGuardLogic = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
