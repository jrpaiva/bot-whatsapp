# WA Bot Baileys — Render 512 MB

Versão migrada de WPPConnect/Puppeteer para Baileys.

## O que mudou

- Removeu completamente Chromium, Puppeteer, WPPConnect e cache de Chrome.
- Usa Baileys via WebSocket do WhatsApp Web.
- Mantém painel web, QR Code, pareamento por código, envio manual, grupos, agendamentos, mensagens predefinidas, logs e MCP.
- Usa menos RAM no Render porque não abre navegador.
- Sessão fica em `BAILEYS_AUTH_DIR` e pode ser salva/restaurada pelo Supabase Storage.
- Backup automático da sessão no Supabase a cada `SESSION_AUTOSAVE_MS`, quando configurado.

## Render

```txt
Build Command: npm install
Start Command: npm start
```

Recomendo fazer deploy com:

```txt
Manual Deploy > Clear build cache & deploy
```

## Variáveis recomendadas

```env
NODE_VERSION=20
BAILEYS_AUTH_DIR=/tmp/baileys-auth
PAIRING_WAIT_MS=90000
SESSION_AUTOSAVE_MS=60000
LOG_MAX_ENTRIES=180
LOG_AUTO_CLEAR_HOURS=12
MEMORY_WARN_MB=360
MEMORY_RESTART_MB=470
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_ROLE_KEY
SUPABASE_BUCKET=whatsapp-sessions
SUPABASE_SESSION_PATH=baileys-auth.zip
SUPABASE_CONFIG_PATH=bot_config.json
SUPABASE_PREDEFINIDAS_PATH=predefinidas.json
MCP_AUTH_TOKEN=troque-por-uma-chave-grande-e-secreta
```

## Conectar por QR

1. Abra o painel.
2. Aguarde o QR aparecer.
3. No WhatsApp: Aparelhos conectados > Conectar aparelho.
4. Escaneie o QR.
5. Depois de conectar, use o botão Sessão > Salvar Sessão se o Supabase estiver configurado.

## Conectar por código

1. Clique em Emparelhar com código.
2. Informe o número com país + DDD + número, sem `+`.
3. Exemplo: `5598999999999`.
4. No WhatsApp: Aparelhos conectados > Conectar aparelho > Conectar com número de telefone.
5. Digite o código exibido no painel.

## Endpoints

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
GET  /api/grupos
POST /api/enviar
```


## Correção v4.0.1

- Fixado `baileys` em `6.7.16` porque `baileys@^7.0.0` não existe no npm e causa `ETARGET` no Render.
