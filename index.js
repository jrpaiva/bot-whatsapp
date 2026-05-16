const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Aponta diretamente para a pasta onde o log confirmou que o Chrome foi baixado
        executablePath: '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

// O restante do seu código continua exatamente igual abaixo...


// O restante do seu código (client.on('qr', ...), client.on('ready', ...) e seus lembretes) continua igual aqui para baixo...



// Exibe o QR Code desenhado diretamente na tela preta do Render
client.on('qr', (qr) => {
    console.log('👉 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP BUSINESS:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 Bot conectado com sucesso e rodando na nuvem!');

    // =========================================================================
    // SEUS LEMBRETES (Horário de Brasília)
    // =========================================================================

    // Exemplo 1: Segunda a Quarta, às 09:00h do Brasil (09+3 = 12h UTC)
    cron.schedule('0 12 * * 1-3', async () => {
        await enviarLembrete("Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal!");
    });

    // Exemplo 2: Segunda a Quarta, às 15:00h do Brasil (15+3 = 18h UTC)
    cron.schedule('0 18 * * 1-3', async () => {
        await enviarLembrete("Nome Exato do Seu Grupo 2", "🔔 Lembrete do Grupo 2: Mensagem da tarde!");
    });
});

async function enviarLembrete(nomeDoGrupo, mensagem) {
    try {
        const chats = await client.getChats();
        const grupo = chats.find(chat => chat.isGroup && chat.name === nomeDoGrupo);

        if (grupo) {
            await client.sendMessage(grupo.id._serialized, mensagem);
            console.log(`[Sucesso] Mensagem enviada para o grupo: "${nomeDoGrupo}"`);
        } else {
            console.log(`[Aviso] O grupo chamado "${nomeDoGrupo}" não foi encontrado. O bot está adicionado nele?`);
        }
    } catch (error) {
        console.error(`[Erro] Falha ao enviar para o grupo "${nomeDoGrupo}":`, error);
    }
}

client.initialize();
