# WA Bot — WPPConnect para Render 512 MB

Versão ajustada para rodar no Render Free com 512 MB, usando WPPConnect e painel web.

## O que foi corrigido

- QR Code agora é capturado pelo callback correto `catchQR`.
- Pareamento por código agora usa `phoneNumber` + `catchLinkCode`, que é o fluxo correto do WPPConnect.
- Removido o reinício automático agressivo do QR a cada 30s, que causava conflito de navegador aberto.
- Reduzido volume de logs em memória.
- Desativado log de update do WPPConnect.
- Adicionados argumentos mais leves para Chromium.
- Adicionada limpeza de locks antigos do Chrome na pasta da sessão.
- Corrigido retorno de informações de Supabase no `/api/status`.

## Variáveis recomendadas no Render

```env
WPP_TOKEN_DIR=/tmp/wppconnect-tokens
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
LOG_MAX_ENTRIES=180
LOG_AUTO_CLEAR_HOURS=12
MEMORY_WARN_MB=420
MEMORY_RESTART_MB=500
QR_REFRESH_MS=0
PAIRING_WAIT_MS=90000
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_ROLE_KEY
SUPABASE_BUCKET=whatsapp-sessions
SUPABASE_SESSION_PATH=wppconnect-tokens.zip
SUPABASE_CONFIG_PATH=bot_config.json
MCP_AUTH_TOKEN=troque-por-uma-chave-grande-e-secreta
```

## Deploy

```bash
npm install
npm start
```

No Render:

```txt
Build Command: npm install
Start Command: node index.js
```

## Conectar por QR Code

1. Abra o painel do Render.
2. Aguarde aparecer o QR Code.
3. No WhatsApp, vá em **Aparelhos conectados > Conectar um aparelho**.
4. Escaneie o QR.
5. Quando conectar, salve a sessão pelo botão de sessão/Supabase.

## Conectar por código

1. Clique em **Emparelhar com código**.
2. Digite o número com país + DDD + número.
3. Exemplo:

```txt
5598999999999
```

4. Aguarde o código aparecer.
5. No WhatsApp, vá em **Aparelhos conectados > Conectar um aparelho > Conectar com número de telefone**.
6. Digite o código exibido.

## Endpoints úteis

```txt
GET  /api/health
GET  /api/status
GET  /api/memory
GET  /api/logs
POST /api/logs/clear
POST /api/session/restart
POST /api/session/delete
POST /api/session/save
POST /api/session/restore
POST /api/pairing-code
```
