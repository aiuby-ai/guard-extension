/*
 * Content script do Guard no navegador. Intercepta colar, enviar (Enter ou botão) e anexar nos
 * campos de texto do site de IA, pede a decisão ao service worker e aplica: segue, mascara no
 * campo, bloqueia com aviso ou espera aprovação. Não lê nada fora desses eventos.
 */
;(function () {
  'use strict'
  if (window.__aiubyGuardLoaded) return
  window.__aiubyGuardLoaded = true

  var L = globalThis.AiubyGuardLogic
  var host = location.hostname
  var bypass = false
  var busy = false
  var lastField = null
  /** Aprovações liberadas para anexo: a pessoa anexa o mesmo arquivo de novo. Só em memória. */
  var attachReleases = []

  // ---- campos ----

  /** Nó real do evento, mesmo dentro de shadow DOM aberto (o `target` no window é o host). */
  function eventNode(e) {
    var path = typeof e.composedPath === 'function' ? e.composedPath() : null
    return path && path.length ? path[0] : e.target
  }

  function editableFrom(node) {
    return L.editableHost(node)
  }

  var isValueField = function (el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
  }

  function fieldText(el) {
    return (isValueField(el) ? el.value : el.innerText || '').replace(/ /g, ' ')
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function insertText(el, text) {
    el.focus()
    if (isValueField(el)) {
      var start = el.selectionStart == null ? el.value.length : el.selectionStart
      var end = el.selectionEnd == null ? el.value.length : el.selectionEnd
      setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end))
      el.selectionStart = el.selectionEnd = start + text.length
      return
    }
    document.execCommand('insertText', false, text)
  }

  function replaceField(el, text) {
    el.focus()
    if (isValueField(el)) return setNativeValue(el, text)
    var selection = document.getSelection()
    selection.selectAllChildren(el)
    document.execCommand('insertText', false, text)
  }

  /** Botão de envio perto do campo (até o form ou 6 níveis acima). */
  function sendButtonNear(el) {
    var scope = el.parentElement
    for (var i = 0; scope && i < 6; i++, scope = scope.parentElement) {
      var list = scope.querySelectorAll('button, [role="button"], input[type="submit"]')
      for (var j = 0; j < list.length; j++) if (L.isSendClick(list[j])) return list[j]
      if (scope.tagName === 'FORM') break
    }
    return null
  }

  /**
   * Repete o envio original sem passar de novo pela conferência. Depois do Enter, prefere clicar
   * no botão de envio do site: alguns editores ignoram tecla sintética.
   */
  function submit(el, button, form) {
    if (!button && !form && el.isConnected) button = sendButtonNear(el)
    bypass = true
    try {
      if (button && button.isConnected) button.click()
      else if (form && form.isConnected) form.requestSubmit ? form.requestSubmit() : form.submit()
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    } finally {
      bypass = false
    }
  }

  // ---- aviso na tela ----

  var toastHost = null
  var toastBody = null
  var toastTimer = null

  function toast(text, tone, sticky) {
    if (!toastHost) {
      toastHost = document.createElement('div')
      var shadow = toastHost.attachShadow({ mode: 'closed' })
      var style = document.createElement('style')
      style.textContent =
        '.box{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;padding:12px 14px;background:#0A0C0D;color:#FFFFFF;' +
        'border:1px solid #171D1F;border-left:3px solid #12A8BE;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 4px 16px rgba(0,0,0,.5)}' +
        '.box.alert{border-left-color:#FFFFFF}.tag{display:block;color:#8A999C;font-size:11px;margin-bottom:4px;letter-spacing:.06em}' +
        'button{margin-top:8px;background:#000000;color:#FFFFFF;border:1px solid #006B7A;font:inherit;font-size:11px;padding:4px 10px;cursor:pointer}'
      toastBody = document.createElement('div')
      toastBody.className = 'box'
      shadow.appendChild(style)
      shadow.appendChild(toastBody)
      ;(document.body || document.documentElement).appendChild(toastHost)
    }
    clearTimeout(toastTimer)
    toastBody.className = tone === 'alert' ? 'box alert' : 'box'
    toastBody.setAttribute('role', tone === 'alert' ? 'alert' : 'status')
    toastBody.textContent = ''
    var tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = 'AIUBY GUARD'
    var message = document.createElement('span')
    message.textContent = text
    var close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Fechar'
    close.addEventListener('click', hideToast)
    toastBody.appendChild(tag)
    toastBody.appendChild(message)
    toastBody.appendChild(document.createElement('br'))
    toastBody.appendChild(close)
    toastHost.style.display = 'block'
    if (!sticky) toastTimer = setTimeout(hideToast, 9000)
  }

  function hideToast() {
    if (toastHost) toastHost.style.display = 'none'
  }

  // ---- conversa com o service worker ----

  function ask(action, text, approval) {
    return chrome.runtime
      .sendMessage({ type: 'decide', destination: host, action: action, text: text, approval: approval || null })
      .catch(function () {
        return { ok: false, failure: 'unreachable', failMode: 'closed' }
      })
  }

  function waitForApproval(approval, onFinal) {
    var interval = Math.max(2, Number(approval.pollIntervalSeconds) || 5) * 1000
    var deadline = Date.parse(approval.expiresAt) || Date.now() + 30 * 60 * 1000
    var tick = function () {
      if (Date.now() > deadline) return onFinal('expired')
      chrome.runtime
        .sendMessage({ type: 'poll', id: approval.id })
        .then(function (res) {
          var status = res && res.ok && res.data ? res.data.status : null
          if (status && L.isFinalStatus(status)) return onFinal(status)
          setTimeout(tick, interval)
        })
        .catch(function () {
          setTimeout(tick, interval)
        })
    }
    setTimeout(tick, interval)
  }

  // ---- enviar ----

  function handleSend(el, text, button, form) {
    if (busy) return
    busy = true
    toast('Conferindo o texto…', 'info', true)
    ask('send', text).then(function (res) {
      busy = false
      var plan = L.planAction(res, 'send')
      if (plan.kind === 'proceed') {
        if (plan.notice) toast(plan.notice, 'info')
        else hideToast()
        return submit(el, button, form)
      }
      if (plan.kind === 'replace') {
        replaceField(el, plan.text)
        return toast(plan.notice + ' Envie de novo quando estiver certo.', 'info', true)
      }
      if (plan.kind === 'block') return toast(plan.message, 'alert', true)
      toast(plan.notice + ' ' + L.approvalMessage('pending'), 'info', true)
      waitForApproval(plan.approval, function (status) {
        if (status !== 'approved') return toast(L.approvalMessage(status), 'alert', true)
        if (fieldText(el).trim() !== text) return toast('O texto do campo mudou depois do pedido. Envie de novo para pedir outra aprovação.', 'alert', true)
        ask('send', text, plan.approval).then(function (released) {
          var next = L.planAction(released, 'send')
          if (next.kind === 'proceed') {
            toast(L.approvalMessage('approved'), 'info')
            return submit(el, button, form)
          }
          if (next.kind === 'replace') {
            replaceField(el, next.text)
            return toast(next.notice + ' Envie de novo quando estiver certo.', 'info', true)
          }
          toast(next.message || L.approvalMessage('expired'), 'alert', true)
        })
      })
    })
  }

  window.addEventListener('focusin', function (e) {
    var field = editableFrom(eventNode(e))
    if (field) lastField = field
  }, true)

  window.addEventListener('keydown', function (e) {
    if (bypass || e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return
    var el = editableFrom(eventNode(e))
    if (!el) return
    var text = fieldText(el).trim()
    if (!text) return
    e.preventDefault()
    e.stopImmediatePropagation()
    handleSend(el, text, null)
  }, true)

  window.addEventListener('click', function (e) {
    if (bypass) return
    var button = L.isSendClick(eventNode(e))
    if (!button) return
    var el = lastField && lastField.isConnected ? lastField : editableFrom(document.activeElement)
    if (!el) return
    var text = fieldText(el).trim()
    if (!text) return
    e.preventDefault()
    e.stopImmediatePropagation()
    handleSend(el, text, button, null)
  }, true)

  // Envio por formulário (botão sem rótulo reconhecível, `type="submit"`): confere o campo do form.
  window.addEventListener('submit', function (e) {
    if (bypass) return
    var form = e.target
    if (!form || form.tagName !== 'FORM') return
    var el = lastField && lastField.isConnected && form.contains(lastField) ? lastField : null
    if (!el) return
    var text = fieldText(el).trim()
    if (!text) return
    e.preventDefault()
    e.stopImmediatePropagation()
    var submitter = e.submitter && e.submitter.isConnected ? e.submitter : null
    handleSend(el, text, submitter, form)
  }, true)

  // ---- colar ----

  window.addEventListener('paste', function (e) {
    if (bypass) return
    var el = editableFrom(eventNode(e))
    var data = e.clipboardData
    if (!el || !data) return
    var files = data.files && data.files.length ? Array.prototype.slice.call(data.files) : []
    var text = data.getData('text/plain')
    if (!text && files.length) return guardFiles(e, files, function () {
      var dt = new DataTransfer()
      files.forEach(function (f) { dt.items.add(f) })
      bypass = true
      try { el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) } finally { bypass = false }
    })
    if (!text) return
    e.preventDefault()
    e.stopImmediatePropagation()
    ask('paste', text).then(function (res) {
      var plan = L.planAction(res, 'paste')
      if (plan.kind === 'block') return toast(plan.message, 'alert', true)
      if (plan.kind === 'insert') {
        insertText(el, plan.text)
        return toast(plan.notice, 'info')
      }
      insertText(el, text)
      if (plan.notice) toast(plan.notice, 'info')
    })
  }, true)

  // ---- anexar (só o nome do arquivo é conferido) ----

  function guardFiles(e, files, replay) {
    var names = files.map(function (f) { return f.name }).join('\n')
    e.preventDefault()
    e.stopImmediatePropagation()
    var releaseIndex = attachReleases.findIndex(function (r) { return r.names === names && r.until > Date.now() })
    var release = releaseIndex >= 0 ? attachReleases.splice(releaseIndex, 1)[0] : null
    ask('attach', names, release ? release.approval : null).then(function (res) {
      var plan = L.planAction(res, 'attach')
      if (plan.kind === 'proceed') {
        if (plan.notice) toast(plan.notice, 'info')
        return replay()
      }
      if (plan.kind === 'block') return toast(plan.message + ' O arquivo não foi anexado.', 'alert', true)
      toast(plan.notice + ' ' + L.approvalMessage('pending'), 'info', true)
      waitForApproval(plan.approval, function (status) {
        if (status !== 'approved') return toast(L.approvalMessage(status), 'alert', true)
        attachReleases.push({ names: names, approval: plan.approval, until: Date.now() + 10 * 60 * 1000 })
        toast('Anexo aprovado. Anexe o mesmo arquivo de novo nos próximos 10 minutos.', 'info', true)
      })
    })
  }

  window.addEventListener('change', function (e) {
    if (bypass) return
    var input = e.target
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file' || !input.files || !input.files.length) return
    var files = Array.prototype.slice.call(input.files)
    var kept = new DataTransfer()
    files.forEach(function (f) { kept.items.add(f) })
    // Até a decisão, o arquivo sai do campo; volta só se liberado.
    input.value = ''
    guardFiles(e, files, function () {
      input.files = kept.files
      bypass = true
      try {
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } finally {
        bypass = false
      }
    })
  }, true)

  window.addEventListener('drop', function (e) {
    if (bypass || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return
    var target = e.target
    var files = Array.prototype.slice.call(e.dataTransfer.files)
    var init = { clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }
    guardFiles(e, files, function () {
      var dt = new DataTransfer()
      files.forEach(function (f) { dt.items.add(f) })
      bypass = true
      try { target.dispatchEvent(new DragEvent('drop', Object.assign({ dataTransfer: dt }, init))) } finally { bypass = false }
    })
  }, true)
})()
