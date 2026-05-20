# Análise Completa do Bot WhatsApp — 20/05/2026

## 1. Stack Atual

### Aplicação
- **Linguagem:** Node.js
- **Framework web:** Express (porta 10000)
- **WhatsApp API:** `@wppconnect-team/wppconnect` v1.32.2 (desatualizado — v2.2.0 disponível)
- **Agendamento:** `node-cron` v3.0.3 (fuso Brasília)
- **Banco:** Supabase Storage (sessão ZIP + config JSON + predefinidas JSON)
- **QR/Pairing:** qrcode v1.5.3 (não utilizado no backend)
- **Utilitários:** archiver v7.0.1, unzipper v0.12.3

### Infraestrutura
- **Plataforma:** Render — Web Service, plano **Free**
- **Região:** Virginia (EUA)
- **Build:** `rm -rf node_modules package-lock.json && npm install` (~10s)
- **Start:** `node index.js`
- **URL:** https://bot-whatsapp-odll.onrender.com
- **Service ID:** `srv-d83scgbtqb8s73eo9n7g`
- **Live deploy:** `dep-d86kk5crp5ls739fp9g0` (commit `28c40cc`)
- **Chrome:** Puppeteer Chromium 148.0.7778.97 em `/opt/render/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome`

### Versionamento (Git)
- **Branch:** `main`
- **HEAD:** `28c40cc` — Fix onStateChange/onQRCode nas opções do create() (wppconnect)
- **Histórico relevante:**
  - Commits `c9b2bae` → `b9d0b19`: Implementação Baileys completa (pairing code, 515 fix)
  - Commit `c31df78`: Rewrite de Baileys → wppconnect ("Chromium real, conexao estável")
  - Commits `f2c7f4d` → `0c1b737` → `28c40cc`: Fixes Chrome + QR no wppconnect

---

## 2. Logs Completos (Render)

### Sequência de inicialização (deploy D, instância srv-...-8drht)
```
05:45:48 — Running 'node index.js'
05:45:53 — Servidor porta 10000, MCP /mcp (token)
05:45:54 — Config: Restaurados: 7 agendamentos
05:45:54 — Chrome não encontrado. Instalando...
05:46:41 — Chrome instalado: chrome@148.0.7778.97
05:46:41 — wppconnect checa atualização: 1.41.3 → 2.2.0
05:46:42 — Browser: usando pasta /tmp/wppconnect-tokens/whatsapp-bot
05:46:42 — Browser: Initializing browser...
05:46:49 — checking headless → headless ativo
05:46:51 — Client: Initializing...
05:46:51 — Setting WA WEB version to 2.3000.10305x → FALHA: versão não disponível
05:46:51 — Loading WhatsApp WEB (fallback para latest)
05:47:03 — Page loaded, Injecting wapi.js
05:47:12 — Session: Unpaired
05:47:46 — wapi.js injected
05:47:51 — [http] Connected
05:47:54 — Checking is logged...
05:47:54 — WA WEB version: 2.3000.1039851994
05:47:54 — WA-JS version: 3.23.4
05:47:54 — [http] Waiting for QRCode Scan...
05:48:00 — Current state: QR (CONNECTING)
05:49:39 — Current state: QR (PAIRING) → QR (CONNECTING)
05:49:43 — Waiting for QRCode Scan: Attempt 1
05:50:41 — Waiting for QRCode Scan: Attempt 2
05:51:00 — Waiting for QRCode Scan: Attempt 3
05:51:20 — Waiting for QRCode Scan: Attempt 4
05:51:40 — Waiting for QRCode Scan: Attempt 5
05:51:50 — Detected service running on port 10000
05:52:00 — Waiting for QRCode Scan: Attempt 6
05:53:09 — Current state: QR (CONNECTING)
05:53:12 — Current state: QR (CONNECTING)
05:53:13 — Waiting for QRCode Scan: Attempt 7
```

### Falha na primeira instância (srv-...-m7rc2)
```
05:46:59 — Erro: Falha iniciar bot — Attempted to use detached Frame '7137D41A023B39A06C4AEEAF92D9536E'.
```
Isso ocorre porque o Puppeteer perde o frame da página durante injeção do wapi.js. O `try/catch` em `iniciarBot()` captura o erro e define `client = null`, mas não tenta novamente. A segunda instância (8drht) sobreviveu.

---

## 3. Bugs e Falhas Detectadas

### 🔴 BLOQUEANTE: QR Code não é exposto
- **Local:** `index.js:53` — `let qrDataURL = null;` (nunca atualizado)
- **Causa:** `logQR: false` (linha 412) desliga a saída do QR. Nenhum callback `onQR` é registrado. A variável `qrDataURL` fica sempre `null`.
- **Impacto:** API `/api/status` retorna `qr: null`. Frontend nunca exibe QR. Usuário não consegue escanear.
- **Linhas:** 407-425 (create options), 609 (API status), 394-408 do HTML (updateStatus)

### 🔴 BLOQUEANTE: Rota /api/pairing-code não existe
- **Local:** `public/index.html:1063` chama `POST /api/pairing-code`
- **Causa:** Backend `index.js` não tem essa rota. O modal de emparelhamento no HTML foi copiado de uma versão Baileys.
- **Impacto:** Botão "Gerar código" dá 404. Única forma de conectar é QR (que também não funciona).
- **Solução:** A rota precisa ser implementada (ou removida do frontend).

### 🔴 BLOQUEANTE: wppconnect com `useChrome: false` mas sem Chrome alternativo
- **Local:** `index.js:410` — `useChrome: false`
- **Causa:** wppconnect usa Puppeteer internamente. `useChrome: false` tenta usar Chromium empacotado pela própria lib. Se não achar, quebra.
- **Impacto:** A instância m7rc2 quebrou com "detached Frame" porque o gerenciamento de página do Puppeteer falhou. A instância 8drht sobreviveu mas pode falhar a qualquer momento.
- **Evidência:** Chrome é instalado via `ensureChrome()` que require('puppeteer'), mas `puppeteer` NÃO está no `package.json`. O require só funciona se o wppconnect instalou internamente.

### 🟡 ALTO: Sem lógica de reconexão após falha
- **Local:** `index.js:439-443` — catch de iniciarBot define `client = null` e `restarting = false`
- **Causa:** Se o wppconnect.create() falhar (detached frame, timeout, etc.), o bot para completamente. Não há retry nem watchdog.
- **Impacto:** Bot fica offline até o próximo deploy/Render restart.

### 🟡 ALTO: render.yaml desatualizado
- **Local:** `render.yaml:9-12`
- **Problema:** Usa `WWEBJS_AUTH_DIR` e `WWEBJS_READY_WAIT_MS` (variáveis do `whatsapp-web.js`, biblioteca anterior). O código atual usa `WPP_TOKEN_DIR`.
- **Impacto:** Variáveis fictícias no ambiente. `SUPABASE_SESSION_PATH` = `wwebjs_auth.zip` mas o código salva como `wppconnect-tokens.zip`.

### 🟡 ALTO: Versão do WhatsApp Web forçada inexistente
- **Local:** `index.js` — wppconnect tenta forçar versão `2.3000.10305x`
- **Log:** `Version not available for 2.3000.10305x, using latest as fallback`
- **Impacto:** A versão forçada não é encontrada nos servidores; usa fallback. Pode causar comportamento imprevisível na renderização do QR.

### 🟡 MÉDIO: Sem escuta de mensagens recebidas
- **Local:** `index.js` usa `wpp.onAck` e `wpp.onParticipantsChanged` mas NÃO registra `wpp.onMessage` ou `wpp.onAnyMessage`.
- **Impacto:** Bot não responde a comandos, não processa pedidos, não pode receber número de telefone para pairing code.

### 🟡 MÉDIO: NPM audit com 5 vulnerabilidades moderadas
- **Log:** `5 moderate severity vulnerabilities`
- **Recomendação:** Rodar `npm audit fix` para corrigir.

### 🟡 MÉDIO: ensureChrome instala Chrome duas vezes
- **Local:** `index.js:358-395`
- **Causa:** O código tenta 3 estratégias de instalação em cascata. Em cada deploy, Chrome é instalado do zero (15s). O cache Puppeteer sobrevive entre deploys no Render, mas o código não verifica corretamente antes de reinstalar.
- **Impacto:** Startup lento (~15s só pra instalar Chrome que já existe).

### 🟢 BAIXO: Limpeza de logs a cada 12h
- **Local:** `index.js:93`
- **Comentário:** Logs internos são limpos a cada 12h. Bom pra memória, mas logs históricos no Supabase seriam ideais.

### 🟢 BAIXO: stdio: 'inherit' no execSync do Chrome
- **Local:** `index.js:370,386`
- **Comentário:** `execSync` com `stdio: 'inherit'` mistura saída do Chrome installer com logs do app. Não é um bug, mas polui o log.

### 🟢 BAIXO: DeprecationWarning url.parse()
- **Log:** `[DEP0169] DeprecationWarning: url.parse() behavior is not standardized`
- **Causa:** O pacote `@wppconnect-team/wppconnect` 1.32.2 usa `url.parse()` que é deprecated no Node.js atual.

---

## 4. Diagrama de Arquivos

```
bot-whatsapp/
├── index.js              ← 693 linhas, entrypoint principal
├── package.json          ← Dependências (wppconnect, express, supabase, etc.)
├── render.yaml            ← Config Render (desatualizada)
├── .env.example           ← Template de variáveis de ambiente
├── public/
│   └── index.html         ← Frontend dashboard (1095 linhas, Bootstrap)
└── README.md
```

---

## 5. Estado Atual do Bot

| Métrica | Valor |
|---------|-------|
| Conectado | ❌ Não |
| Estado | `connecting` |
| Status | `Iniciando WhatsApp...` |
| Uptime | ~6 min (reinicia a cada deploy) |
| Agendamentos | 7 (7 ativos) |
| Cache grupos | Inválido |
| Supabase | Configurado |
| QR Data URL | `null` (nunca gerado) |

---

## 6. Resumo dos Commits (linha do tempo)

```
c9b2bae → b9d0b19 (7 commits) ─── Implementação Baileys (funcional)
       │
c31df78 ───────────────────────── Rewrite wppconnect (substitui Baileys)
       │
f2c7f4d ───────────────────────── Fix Chrome autoinstall
       │
0c1b737 ───────────────────────── Fix puppeteer dep + ensureChrome cascata
       │
28c40cc ───────────────────────── Fix onStateChange/onQRCode (HEAD, atual)
```

---

## 7. Recomendações Imediatas

### Conexão (bloqueante)
1. **Expor QR:** Adicionar `logQR: true` e/ou callback `onQR` para capturar e expor via API
2. **Implementar `/api/pairing-code`** ou remover do frontend
3. **Atualizar wppconnect** para v2.2.0 (ou migrar de volta pro Baileys que tem pairing code nativo)

### Estabilidade
4. **Adicionar watchdog/reconnect** — se `wppconnect.create()` falhar, tentar novamente após delay
5. **Corrigir render.yaml** — remover vars obsoletas do wwebjs, atualizar paths do Supabase
6. **Verificar dependência puppeteer** — adicionar ao `package.json` se necessário

### Código
7. **Adicionar `onMessage`** para receber comandos
8. **Rodar `npm audit fix`** para vulnerabilidades
9. **Atualizar `.env.example`** para refletir variáveis reais do wppconnect

---

*Relatório gerado em 20/05/2026 às 05:53 BRT*
*Fonte: Código fonte (index.js, public/index.html, package.json, render.yaml), Logs Render (80+ entradas), API de status do bot, Histórico git (57 commits)*
