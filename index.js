const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const chromium = require('@sparticuz/chromium');

// Configuração blindada para servidores em nuvem como o Render
async function iniciarBot() {
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            transportMode: 'browser',
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            headless: chromium.headless
        }
    });

    // Desenha o QR Code diretamente na tela de Logs do Render
    client.on('qr', (qr) => {
        console.log('\n==================================================================');
        console.log('👉 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP BUSINESS:');
        console.log('==================================================================\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('\n🚀 BOT CONECTADO COM SUCESSO E RODANDO NA NUVEM! 🚀\n');

        // Lembrete: Segunda a Quarta, às 09:00 da manhã do Brasil (12:00 UTC)
        cron.schedule('0 12 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal!");
        });

        // Lembrete: Segunda a Quarta, às 15:00 da tarde do Brasil (18:00 UTC)
        cron.schedule('0 18 * * 1-3', async () => {
            await enviarLembrete(client, "Nome Exato do Seu Grupo 2", "🔔 Lembrete do Grupo 2: Mensagem da tarde!");
        });
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
