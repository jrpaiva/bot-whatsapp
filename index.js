const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode');
const chromium = require('@sparticuz/chromium');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('public'));

// ── Persistência de configurações ──────────────────────────────────────────
const CONFIG_FILE = path.join('/app/.wwebjs_auth', 'config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
    return {
        agendamentos: [
            { id: 1, grupo: '', mensagem: '', cron: '0 12 * * 1-3', ativo: false }
        ]
    };
}

function saveConfig(cfg) {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    } catch (e) {
        console.error('[Config] Erro ao salvar:', e.message);
    }
}

let config = loadConfig();

// ── Estado global ───────────────────────────────────────────────────────────
let qrCodeDataURL = null;
let botStatus = 'Inicializando...';
let botConnected = false;
let clientInstance = null;
let scheduledJobs = {};
let logs = [];

function addLog(type, msg) {
    const entry = { type, msg, time: new Date().toLocaleTimeString('pt-BR') };
    logs.unshift(entry);
    if (logs.length > 100) logs.pop();
    console.log(`[${type}] ${msg}`);
}

// ── Agenda cron jobs ────────────────────────────────────────────────────────
function scheduleAll() {
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};

    config.agendamentos.forEach(ag => {
        if (!ag.ativo || !ag.grupo || !ag.mensagem || !ag.cron) return;
        try {
            scheduledJobs[ag.id] = cron.schedule(ag.cron, async () => {
                await enviarLembrete(ag.grupo, ag.mensagem);
            });
            addLog('Cron', `Agendado: "${ag.grupo}" [${ag.cron}]`);
        } catch (e) {
            addLog('Erro', `Cron inválido para agendamento ${ag.id}: ${e.message}`);
        }
    });
}

async function enviarLembrete(grupo, mensagem) {
    if (!clientInstance || !botConnected) {
        addLog('Erro', 'Bot não conectado.');
        return { ok: false, msg: 'Bot não conectado.' };
    }
    try {
        const chats = await clientInstance.getChats();
        const g = chats.find(c => c.isGroup && c.name === grupo);
        if (g) {
            await clientInstance.sendMessage(g.id._serialized, mensagem);
            addLog('Sucesso', `Mensagem enviada para "${grupo}"`);
            return { ok: true };
        } else {
            addLog('Aviso', `Grupo "${grupo}" não encontrado.`);
            return { ok: false, msg: `Grupo "${grupo}" não encontrado.` };
        }
    } catch (e) {
        addLog('Erro', `Falha ao enviar: ${e.message}`);
        return { ok: false, msg: e.message };
    }
}

// ── API Routes ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ connected: botConnected, status: botStatus, qr: qrCodeDataURL });
});

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
    config = req.body;
    saveConfig(config);
    if (botConnected) scheduleAll();
    addLog('Config', 'Configurações salvas.');
    res.json({ ok: true });
});

app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/enviar', async (req, res) => {
    const { grupo, mensagem } = req.body;
    if (!grupo || !mensagem) return res.json({ ok: false, msg: 'Grupo e mensagem obrigatórios.' });
    const result = await enviarLembrete(grupo, mensagem);
    res.json(result);
});

app.get('/api/grupos', async (req, res) => {
    if (!clientInstance || !botConnected) return res.json([]);
    try {
        const chats = await clientInstance.getChats();
        const grupos = chats.filter(c => c.isGroup).map(c => c.name);
        res.json(grupos);
    } catch (e) {
        res.json([]);
    }
});

// ── Serve o painel ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => addLog('Servidor', `Rodando na porta ${PORT}`));

// ── WhatsApp Client ─────────────────────────────────────────────────────────
async function iniciarBot() {
    const execPath = await chromium.executablePath();
    addLog('Info', `Chrome: ${execPath}`);

    clientInstance = new Client({
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

    clientInstance.on('qr', async (qr) => {
        addLog('QR', 'Novo QR Code gerado — acesse o painel para escanear.');
        qrCodeDataURL = await qrcode.toDataURL(qr);
        botStatus = 'Aguardando escaneamento...';
        botConnected = false;
    });

    clientInstance.on('ready', () => {
        addLog('Bot', 'Conectado com sucesso!');
        qrCodeDataURL = null;
        botStatus = 'Conectado';
        botConnected = true;
        scheduleAll();
    });

    clientInstance.on('auth_failure', (msg) => {
        addLog('Erro', `Falha de autenticação: ${msg}`);
        botStatus = 'Erro de autenticação';
        botConnected = false;
    });

    clientInstance.on('disconnected', (reason) => {
        addLog('Bot', `Desconectado: ${reason}`);
        botStatus = 'Desconectado';
        botConnected = false;
        qrCodeDataURL = null;
        setTimeout(() => iniciarBot(), 5000);
    });

    clientInstance.initialize();
}

iniciarBot();
