const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode');
const chromium = require('@sparticuz/chromium');
const express = require('express');

// Servidor web para exibir o QR Code
const app = express();
const PORT = process.env.PORT || 3000;
let qrCodeDataURL = null;
let botStatus = 'Aguardando QR Code...';

app.get('/', (req, res) => {
    if (qrCodeDataURL) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
                    <h2>📱 Escaneie o QR Code com o WhatsApp</h2>
                    <img src="${qrCodeDataURL}" style="width:300px;height:300px;" />
                    <p style="margin-top:20px;color:#aaa;">Após escanear, esta página mudará automaticamente.</p>
                    <script>setTimeout(() => location.reload(), 30000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
                    <h2>🤖 Status do Bot</h2>
                    <p style="font-size:1.5rem;">${botStatus}</p>
                    <script>setTimeout(() => location.reload(), 5000);</script>
                </body>
            </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`[Servidor] Rodando na porta ${PORT}`);
});

async function iniciarBot() {
    const execPath = await chromium.executablePath();
    console.log(`[Info] Usando Chrome em: ${execPath}`);

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: execPath,
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ],
            headless: true
        }
    });

    client.on('qr', async (qr) => {
        console.log('[QR Code] Novo QR Code gerado — acesse a URL do seu serviço no Render para escanear.');
        qrCodeDataURL = await qrcode.toDataURL(qr);
        botStatus = 'Aguardando QR Code...';
    });

    client.on('ready', () => {
        console.log('\n🚀 BOT CONECTADO COM SUCESSO E RODANDO NA NUVEM! 🚀\n');
        qrCodeDataURL = null;
        botStatus = '✅ Bot conectado e funcionando!';

        // Segunda a Quarta, 09:00 horário de Brasília (12:00 UTC)
        cron.schedule('0 12 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal!");
        });

        // Segunda a Quarta, 15:00 horário de Brasília (18:00 UTC)
        cron.schedule('0 18 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 2", "🔔 Lembrete do Grupo 2: Mensagem da tarde!");
        });
    });

    client.on('auth_failure', (msg) => {
        console.error('[Erro] Falha de autenticação:', msg);
        botStatus = '❌ Falha de autenticação. Reiniciando...';
    });

    client.on('disconnected', (reason) => {
        console.log('[Desconectado]', reason);
        botStatus = '🔄 Desconectado. Reconectando...';
        qrCodeDataURL = null;
        setTimeout(() => iniciarBot(), 5000);
    });

    client.initialize();
}

async function enviarLembrete(client, nomeDoGrupo, mensagem) {
    try {
        console.log(`[Processando] Tentando enviar lembrete para: "${nomeDoGrupo}"...`);
        const chats = await client.getChats();
        const grupo = chats.find(chat => chat.isGroup && chat.name === nomeDoGrupo);

        if (grupo) {
            await client.sendMessage(grupo.id._serialized, mensagem);
            console.log(`[Sucesso] Mensagem enviada para o grupo: "${nomeDoGrupo}"`);
        } else {
            console.log(`[Aviso] O grupo chamado "${nomeDoGrupo}" não foi encontrado.`);
        }
    } catch (error) {
        console.error(`[Erro] Falha ao enviar para o grupo "${nomeDoGrupo}":`, error);
    }
}

iniciarBot();