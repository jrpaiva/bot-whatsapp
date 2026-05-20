# Bot WhatsApp Baileys — Render 512 MB

Versão com correção para `No sessions | SessionError` em grupos e proteção contra backup de sessão inválido.

## Render

Build Command:

```txt
npm install
```

Start Command:

```txt
npm start
```

Depois de subir esta versão, faça deploy com cache limpo:

```txt
Manual Deploy > Clear build cache & deploy
```

## Variáveis importantes

```env
NODE_VERSION=20
BAILEYS_AUTH_DIR=/tmp/baileys-auth
DEBUG_SEND=true
SEND_TIMEOUT_MS=45000
SEND_RETRY_ATTEMPTS=2
SEND_RETRY_DELAY_MS=2500
RESET_ON_PERSISTENT_NO_SESSIONS=true
DELETE_REMOTE_SESSION_ON_AUTH_ERROR=true
SESSION_AUTOSAVE_MS=60000
```

## O que esta versão corrige

- Atualiza Baileys para `@whiskeysockets/baileys@6.7.19`.
- Usa `makeCacheableSignalKeyStore` quando disponível.
- Usa cache real de metadata de grupos.
- Aplica patch defensivo pós-instalação para builds com bug de grupos LID.
- Não salva backup automático quando a sessão está marcada como inválida.
- Remove backup remoto do Supabase quando detectar logout/401.
- Faz reset forte quando `No sessions` persistir depois das tentativas.

## Fluxo correto após instalar

Se já havia sessão quebrada, escaneie o QR novamente. A versão antiga restaurava sessão inválida do Supabase e entrava em loop de `401`; esta versão remove esse backup ruim quando detectar erro de autenticação.
