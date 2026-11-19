# AIUBY Guard no navegador

Extensão para Chrome (Manifest V3) do **AIUBY Guard**. Confere o que a equipe cola, envia ou anexa em sites de IA de terceiros (ChatGPT, Gemini, Claude.ai, Copilot, DeepSeek, Perplexity e os destinos que o workspace cadastrar) e aplica a política definida na plataforma AIUBY: liberar, mascarar, pedir aprovação ou bloquear.

## Como funciona

- **Colar, enviar e anexar:** a extensão lê o texto no momento em que ele sai do seu controle. De arquivos anexados, só o **nome**.
- **Decisão na plataforma:** o texto vai para a API do workspace com uma credencial de escopo `guard:decide`, que só serve para conferir textos e ler a política.
- **A credencial fica isolada:** ela é guardada em `chrome.storage.local` e só o service worker a usa. O script que roda dentro do site de IA nunca a vê.
- **Fora do ar:** se a plataforma não responder, vale o modo de falha da política (seguir ou bloquear).

Não cobre aplicativos de desktop ou celular, outros navegadores nem o conteúdo de arquivos. Não é proxy de rede.

## Instalação

1. Na plataforma, em **Guard › Navegador**, crie uma credencial (uma por pessoa ou computador).
2. Baixe o pacote da [última versão](https://github.com/aiuby-ai/guard-extension/releases/latest) ou da própria plataforma e carregue-o em `chrome://extensions` (modo de desenvolvedor) ou distribua pela política de extensões do Chrome gerenciado.
3. Nas opções da extensão, informe o endereço da plataforma (`https://aiuby.com`) e a credencial.

## Desenvolvimento

```sh
npm install
npm test          # regras do content script, seletores dos sites e manifesto
npm run package   # gera dist/aiuby-guard-navegador.zip a partir de src/
```

Uma tag `v*` gera a versão com o pacote anexado.

## Segurança

Encontrou uma falha? Use [Report a vulnerability](https://github.com/aiuby-ai/guard-extension/security/advisories/new) (privado) em vez de abrir uma issue pública.

## Licença

Apache 2.0. Veja [LICENSE](LICENSE).
