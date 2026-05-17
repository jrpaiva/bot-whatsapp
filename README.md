# WA Bot — Render + Supabase + Uptime

Bot de WhatsApp com painel web, envio manual, agendamento em horário de Brasília, backup manual da sessão e backup automático dos agendamentos no Supabase Storage.

## Variáveis no Render

```env
WWEBJS_AUTH_DIR=/tmp/.wwebjs_auth
WWEBJS_READY_WAIT_MS=45000
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_ROLE_KEY
SUPABASE_BUCKET=whatsapp-sessions
SUPABASE_SESSION_PATH=wwebjs_auth.zip
SUPABASE_CONFIG_PATH=bot_config.json
SUPABASE_PREDEFINIDAS_PATH=predefinidas.json
```

## Supabase

Crie um bucket privado no Storage:

```txt
whatsapp-sessions
```

Configuração recomendada:

```txt
Public bucket: OFF
Restrict file size: 50MB ou 100MB
Restrict MIME types: application/zip e application/json
```

## Endpoint para UptimeRobot / cron-job.org

Use este endpoint para manter o Render Free acordado:

```txt
https://SEU-APP.onrender.com/api/health
```

Configuração recomendada:

```txt
Método: GET
Intervalo: 5 minutos
```

Também existem:

```txt
/health
/ping
/api/status
```

O endpoint mais leve para uptime é:

```txt
/api/health
```

## Fluxo de sessão

1. Faça deploy.
2. Escaneie o QR Code.
3. Aguarde aparecer `Conectado com sucesso!`.
4. Clique em `Sessão > Salvar Sessão`.
5. Em novo deploy, clique em `Sessão > Restaurar`.
6. Aguarde o status mudar para `Conectado` antes de testar envio.

## Agendamentos

Os agendamentos são salvos em `bot_config.json` no Supabase Storage quando você clica em `Salvar tudo`. Ao iniciar ou restaurar sessão, o bot tenta restaurar esses agendamentos automaticamente.

Os horários são informados diretamente em horário de Brasília. O sistema gera o cron automaticamente usando:

```txt
America/Sao_Paulo
```

## Rodar local

```bash
npm install
npm start
```


## Mensagens predefinidas

As mensagens predefinidas são salvas no Supabase Storage em `predefinidas.json`.

Fluxo:

```txt
Criar predefinida
↓
Salvar no Supabase
↓
Usar em envio manual ou agendamento
↓
Editar a mensagem antes de enviar/salvar
```
