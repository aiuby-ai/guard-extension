/**
 * Extensão Guard no navegador: regras puras do content script (o que fazer com cada resposta)
 * e o pacote de download em dia com o código da extensão.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = join(__dirname, '..')
const L = createRequire(import.meta.url)(join(ROOT, 'src/logic.js'))
const DEFAULT_DESTINATIONS: string[] = L.DEFAULT_DESTINATIONS
const ok = (data: Record<string, unknown>) => ({ ok: true, data })

describe('planAction', () => {
  test('liberado segue; mascarado cola ou troca o campo; bloqueado só avisa', () => {
    expect(L.planAction(ok({ decision: 'allow', reason: 'x' }), 'send')).toEqual({ kind: 'proceed', notice: null })
    expect(L.planAction(ok({ decision: 'mask', maskedText: 'CPF [CPF_1]', reason: 'r' }), 'paste')).toMatchObject({ kind: 'insert', text: 'CPF [CPF_1]' })
    expect(L.planAction(ok({ decision: 'mask', maskedText: 'CPF [CPF_1]', reason: 'r' }), 'send')).toMatchObject({ kind: 'replace', text: 'CPF [CPF_1]' })
    expect(L.planAction(ok({ decision: 'block', reason: 'não pode' }), 'send')).toEqual({ kind: 'block', message: 'não pode' })
  })

  test('aprovação: espera no envio; ao colar, deixa colar e avisa', () => {
    const approval = { id: 'a', secret: 's', expiresAt: '2026-11-11T00:00:00Z', pollIntervalSeconds: 5 }
    expect(L.planAction(ok({ decision: 'require_approval', approval, reason: 'r' }), 'send')).toMatchObject({ kind: 'wait', approval })
    expect(L.planAction(ok({ decision: 'require_approval', approval: null, reason: 'r' }), 'paste')).toMatchObject({ kind: 'proceed', notice: 'r' })
  })

  test('plataforma fora do ar segue o modo de falha; sem configuração só avisa', () => {
    expect(L.planAction({ ok: false, failure: 'unreachable', failMode: 'closed' }, 'send').kind).toBe('block')
    expect(L.planAction({ ok: false, failure: 'unreachable' }, 'send').kind).toBe('block')
    expect(L.planAction({ ok: false, failure: 'unreachable', failMode: 'open' }, 'send').kind).toBe('proceed')
    expect(L.planAction({ ok: false, failure: 'not_configured' }, 'send').kind).toBe('proceed')
    expect(L.planAction(ok({ decision: 'desconhecida' }), 'send').kind).toBe('block')
    expect([401, 403, 429, 503, 0].every(L.isFailureStatus)).toBe(true)
    expect([400, 409, 413].some(L.isFailureStatus)).toBe(false)
  })
})

describe('endereços e botões', () => {
  test('plataforma só em HTTPS; destinos extras pedem permissão', () => {
    expect(L.normalizePlatform('aiuby.com/plataforma')).toBe('https://aiuby.com')
    expect(L.normalizePlatform('http://aiuby.com')).toBeNull()
    expect(L.normalizePlatform('http://localhost:3010')).toBe('http://localhost:3010')
    expect(L.extraDestinations({ destinations: { allowed: ['chatgpt.com', 'chat.mistral.ai'], blocked: ['x.claude.ai', 'poe.com'] } })).toEqual(['chat.mistral.ai', 'poe.com'])
    expect(L.looksLikeSendButton({ testId: 'send-button' })).toBe(true)
    expect(L.looksLikeSendButton({ ariaLabel: 'Enviar mensagem' })).toBe(true)
    expect(L.looksLikeSendButton({ ariaLabel: 'Send feedback' })).toBe(false)
  })

  test('manifesto: hosts padrão iguais aos da plataforma e permissões mínimas', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'src/manifest.json'), 'utf8'))
    const hosts = DEFAULT_DESTINATIONS.map((h) => `https://${h}/*`)
    expect(L.DEFAULT_DESTINATIONS).toEqual([...DEFAULT_DESTINATIONS])
    expect(manifest.content_scripts[0].matches).toEqual(hosts)
    expect(manifest.host_permissions).toEqual(['https://aiuby.com/*', ...hosts])
    expect(manifest.permissions).toEqual(['storage', 'scripting'])
  })
})

/**
 * Elementos simulados (sem jsdom): só tagName, getAttribute e parentElement, que é o que as
 * funções de DOM do logic.js usam. As estruturas seguem o que é público de cada site.
 */
type FakeEl = { tagName: string; nodeType: number; parentElement: FakeEl | null; getAttribute: (n: string) => string | null; children: FakeEl[] }
function h(tag: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  const el: FakeEl = { tagName: tag.toUpperCase(), nodeType: 1, parentElement: null, getAttribute: (n) => (Object.hasOwn(attrs, n) ? attrs[n] : null), children }
  for (const c of children) c.parentElement = el
  return el
}

describe('campos e botões dos sites de IA', () => {
  test('ChatGPT: ProseMirror com <p> dentro; botão send-button com rótulo em pt ou en', () => {
    const p = h('p')
    const editor = h('div', { id: 'prompt-textarea', class: 'ProseMirror', contenteditable: 'true' }, [p])
    const svg = h('svg')
    const send = h('button', { id: 'composer-submit-button', 'data-testid': 'send-button', 'aria-label': 'Enviar prompt' }, [svg])
    h('form', {}, [h('div', {}, [editor]), send])
    expect(L.editableHost(p)).toBe(editor)
    expect(L.isSendClick(svg)).toBe(send)
    expect(L.isSendClick(h('button', { 'aria-label': 'Send prompt' }))).not.toBeNull()
  })

  test('Claude: chip contenteditable=false dentro do editor conta como o editor', () => {
    const chip = h('span', { contenteditable: 'false' })
    const editor = h('div', { class: 'ProseMirror', contenteditable: 'true', role: 'textbox' }, [h('p', {}, [chip])])
    h('fieldset', {}, [editor])
    expect(L.editableHost(chip)).toBe(editor)
    expect(L.isSendClick(h('button', { 'aria-label': 'Send message' }))).not.toBeNull()
  })

  test('Gemini: Quill dentro de rich-textarea; botão pela classe send-button', () => {
    const editor = h('div', { class: 'ql-editor textarea', contenteditable: 'true', role: 'textbox' }, [h('p')])
    h('rich-textarea', {}, [editor])
    expect(L.editableHost(editor.children[0])).toBe(editor)
    const icon = h('mat-icon')
    const send = h('button', { class: 'mat-mdc-icon-button send-button submit', 'aria-label': 'Enviar mensagem' }, [icon])
    expect(L.isSendClick(icon)).toBe(send)
  })

  test('Copilot, DeepSeek e Perplexity: textarea, Lexical plaintext e botões Submit', () => {
    const textarea = h('textarea', { id: 'userInput' })
    expect(L.editableHost(textarea)).toBe(textarea)
    const lexical = h('div', { id: 'ask-input', contenteditable: 'PLAINTEXT-ONLY', 'data-lexical-editor': 'true' }, [h('p', {}, [h('span')])])
    expect(L.editableHost(lexical.children[0].children[0])).toBe(lexical)
    expect(L.isSendClick(h('button', { 'aria-label': 'Submit message' }))).not.toBeNull()
    expect(L.isSendClick(h('button', { 'data-testid': 'submit-button', 'aria-label': 'Submit' }))).not.toBeNull()
    expect(L.isSendClick(h('div', { role: 'button', title: 'Enviar' }, [h('svg')]).children[0])).not.toBeNull()
    expect(L.isSendClick(h('input', { type: 'submit', value: 'Enviar' }))).not.toBeNull()
  })

  test('não confunde: campos que não são de texto, editor desligado, botão desabilitado ou outro rótulo', () => {
    expect(L.editableHost(h('input', { type: 'checkbox' }))).toBeNull()
    expect(L.editableHost(h('input', { type: 'password' }))).toBeNull()
    expect(L.editableHost(h('div', { contenteditable: 'false' }, [h('p')]).children[0])).toBeNull()
    expect(L.editableHost(h('div'))).toBeNull()
    expect(L.isSendClick(h('button', { 'data-testid': 'send-button', disabled: '' }))).toBeNull()
    expect(L.isSendClick(h('button', { 'aria-label': 'Send feedback' }))).toBeNull()
    expect(L.isSendClick(h('button', { 'aria-label': 'Enviar arquivo' }))).toBeNull()
    expect(L.isSendClick(h('a', { 'aria-label': 'Enviar' }))).toBeNull()
  })
})
