const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode');
const chromium = require('@sparticuz/chromium');

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
        console.log('\n==================================================================');
        console.log('👉 COPIE O TEXTO ABAIXO E COLE EM: https://qrcode-converter.com');
        console.log('==================================================================\n');
        console.log(qr);
        console.log('\n==================================================================\n');
    });

    client.on('ready', () => {
        console.log('\n🚀 BOT CONECTADO COM SUCESSO E RODANDO NA NUVEM! 🚀\n');

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
    });

    client.on('disconnected', (reason) => {
        console.log('[Desconectado]', reason);
        console.log('[Info] Tentando reconectar...');
        iniciarBot();
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