const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');

// Inicializa o bot configurado para rodar na nuvem do Render
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // Sem executablePath. O pacote 'puppeteer' nativo resolve o caminho sozinho na nuvem
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

// Desenha o QR Code diretamente na tela de Logs do Render
client.on('qr', (qr) => {
    console.log('\n==================================================================');
    console.log('👉 ESCANEIE O QR CODE ABAIXO COM O SEU WHATSAPP BUSINESS:');
    console.log('==================================================================\n');
    qrcode.generate(qr, { small: true });
});

// Mensagem executada assim que o login for bem-sucedido
client.on('ready', () => {
    console.log('\n🚀 BOT CONECTADO COM SUCESSO E RODANDO NA NUVEM! 🚀\n');

    // =========================================================================
    // CONFIGURAÇÃO DOS SEUS LEMBRETES (Horário de Brasília)
    // Dias da semana: 1 = Segunda, 2 = Terça, 3 = Quarta. (1-3 significa Seg a Qua)
    // ATENÇÃO: O Render usa o fuso horário UTC (Hora do Brasil + 3 horas)
    // =========================================================================

    // EXEMPLO 1: Envia de Segunda a Quarta, às 09:00 da manhã do Brasil (09h + 3h = 12h UTC)
    cron.schedule('0 12 * * 1-3', async () => {
        // Altere o nome entre aspas para o nome EXATO do seu grupo do WhatsApp
        await enviarLembrete("Nome Exato do Seu Grupo 1", "⚠️ Lembrete do Grupo 1: Mensagem matinal de Segunda a Quarta!");
    });

    // EXEMPLO 2: Envia de Segunda a Quarta, às 15:00 da tarde do Brasil (15h + 3h = 18h UTC)
    cron.schedule('0 18 * * 1-3', async () => {
        // Altere o nome entre aspas para o nome EXATO do seu grupo do WhatsApp
        await enviarLembrete("Nome Exato do Seu Grupo 2", "🔔 Lembrete do Grupo 2: Mensagem vespertina de Segunda a Quarta!");
    });

});

// Função responsável por buscar o grupo na conta e disparar a mensagem
async function enviarLembrete(nomeDoGrupo, mensagem) {
    try {
        console.log(`[Processando] Tentando enviar lembrete para: "${nomeDoGrupo}"...`);
        const chats = await client.getChats();
        
        // Localiza o chat que seja um grupo e possua o nome idêntico ao configurado
        const grupo = chats.find(chat => chat.isGroup && chat.name === nomeDoGrupo);

        if (grupo) {
            await client.sendMessage(grupo.id._serialized, mensagem);
            console.log(`[Sucesso] Mensagem enviada para o grupo: "${nomeDoGrupo}"`);
        } else {
            console.log(`[Aviso] O grupo chamado "${nomeDoGrupo}" não foi encontrado. Certifique-se de que o bot foi adicionado a ele.`);
        }
    } catch (error) {
        console.error(`[Erro] Falha ao enviar para o grupo "${nomeDoGrupo}":`, error);
    }
}

// Inicia o processo de conexão do bot
client.initialize();
