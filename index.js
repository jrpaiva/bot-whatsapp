const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
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
                '--single-process'       // importante no Render (free tier)
            ],
            headless: true              // força true explicitamente
        }
    });

    client.on('qr', (qr) => {
        console.log('\n==================================================================');
        console.log('👉 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP BUSINESS:');
        console.log('==================================================================\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('\n🚀 BOT CONECTADO COM SUCESSO E RODANDO NA NUVEM! 🚀\n');

        cron.schedule('0 12 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal!");
        });

        cron.schedule('0 18 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 2", "🔔 Lembrete do Grupo 2: Mensagem da tarde!");
        });
    });

    client.on('auth_failure', (msg) => {
        console.error('[Erro] Falha de autenticação:', msg);
    });

    client.on('disconnected', (reason) => {
        console.log('[Desconectado]', reason);
    });

    client.initialize();
}