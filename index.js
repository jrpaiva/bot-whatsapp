const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const cron = require('node-cron');
const qrcodeimg = require('qrcode');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', (qr) => {
    qrcodeimg.toFile('qrcode.png', qr, (err) => {
        if (err) console.error('Erro ao gerar imagem do QR Code:', err);
        console.log('👉 QR CODE ATUALIZADO! Procure o arquivo qrcode.png para escanear.');
    });
});

client.on('ready', () => {
    console.log('🚀 Bot conectado com sucesso e rodando na nuvem!');

    // =========================================================================
    // CONFIGURAÇÃO DOS SEUS LEMBRETES (Horário de Brasília)
    // Dias da semana: 1 = Segunda, 2 = Terça, 3 = Quarta. (1-3 significa Seg a Qua)
    // ATENÇÃO: Ajustado o fuso horário (Hora do Brasil + 3 horas = Hora do Servidor)
    // =========================================================================

    // EXEMPLO 1: Envia de Segunda a Quarta, às 09:00 da manhã do Brasil (09+3 = 12h UTC)
    cron.schedule('0 12 * * 1-3', async () => {
        // MUDE ABAIXO: "Nome do Grupo" e o texto da mensagem
        await enviarLembrete("Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal!");
    });

    // EXEMPLO 2: Envia de Segunda a Quarta, às 15:00 da tarde do Brasil (15+3 = 18h UTC)
    cron.schedule('0 18 * * 1-3', async () => {
        // MUDE ABAIXO: "Nome do Grupo" e o texto da mensagem
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
