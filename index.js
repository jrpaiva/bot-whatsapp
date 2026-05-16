const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qrcode = require('qrcode');
const chromium = require('@sparticuz/chromium');
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.WWEBJS_AUTH_DIR || '/tmp/.wwebjs_auth';
const CONFIG_FILE = process.env.BOT_CONFIG_FILE || path.join('/tmp', 'bot_config.json');
const BRASILIA_TZ = 'America/Sao_Paulo';
const READY_WAIT_MS = Number(process.env.WWEBJS_READY_WAIT_MS || 45000);
const STARTED_AT = new Date();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'whatsapp-sessions';
const SUPABASE_SESSION_PATH = process.env.SUPABASE_SESSION_PATH || 'wwebjs_auth.zip';
const SUPABASE_CONFIG_PATH = process.env.SUPABASE_CONFIG_PATH || 'bot_config.json';

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDefaultConfig() {
    return {
        agendamentos: [
            {
                id: 1,
                grupo: '',
                mensagem: '',
                cron: '0 12 * * 1-3',
                diasSemana: [1, 2, 3],
                horario: '12:00',
                ativo: false
            }
        ]
    };
}

function migrateAgendamento(ag) {
    const migrated = { ...ag };

    if (!migrated.horario || !Array.isArray(migrated.diasSemana)) {
        const parsed = parseCron(migrated.cron || '0 12 * * 1-3');
        migrated.horario = migrated.horario || parsed.horario;
        migrated.diasSemana = Array.isArray(migrated.diasSemana) ? migrated.diasSemana : parsed.diasSemana;
    }

    migrated.cron = buildCronFromSchedule(migrated.horario, migrated.diasSemana);
    return migrated;
}

function parseCron(expr) {
    const fallback = { horario: '12:00', diasSemana: [1, 2, 3] };
    if (!expr || typeof expr !== 'string') return fallback;

    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return fallback;

    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    const daysExpr = parts[4];

    const horario = `${String(Number.isFinite(hour) ? hour : 12).padStart(2, '0')}:${String(Number.isFinite(minute) ? minute : 0).padStart(2, '0')}`;
    const diasSemana = parseDays(daysExpr);

    return { horario, diasSemana };
}

function parseDays(daysExpr) {
    if (!daysExpr || daysExpr === '*') return [0, 1, 2, 3, 4, 5, 6];

    const days = new Set();
    String(daysExpr).split(',').forEach(part => {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            if (Number.isInteger(start) && Number.isInteger(end)) {
                for (let d = start; d <= end; d++) days.add(d);
            }
        } else {
            const d = Number(part);
            if (Number.isInteger(d)) days.add(d);
        }
    });

    return [...days].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);
}

function buildCronFromSchedule(horario, diasSemana) {
    const [hourRaw, minuteRaw] = String(horario || '12:00').split(':');
    const hour = Math.min(Math.max(parseInt(hourRaw, 10) || 0, 0), 23);
    const minute = Math.min(Math.max(parseInt(minuteRaw, 10) || 0, 0), 59);
    const days = Array.isArray(diasSemana) && diasSemana.length
        ? diasSemana.map(Number).filter(d => d >= 0 && d <= 6).sort((a, b) => a - b).join(',')
        : '*';

    return `${minute} ${hour} * * ${days}`;
}

function normalizeConfig(cfg) {
    const base = cfg && typeof cfg === 'object' ? cfg : getDefaultConfig();
    const agendamentos = Array.isArray(base.agendamentos) ? base.agendamentos : [];
    return { ...base, agendamentos: agendamentos.map(migrateAgendamento) };
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
        }
    } catch (e) {
        console.error('[Config] Erro ao carregar:', e.message);
    }
    return getDefaultConfig();
}

function saveConfig(cfg) {
    try {
        ensureDir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalizeConfig(cfg), null, 2));
    } catch (e) {
        console.error('[Config] Erro ao salvar:', e.message);
    }
}

let config = loadConfig();
let qrCodeDataURL = null;
let botStatus = 'Inicializando...';
let botState = 'starting';
let botConnected = false;
let clientInstance = null;
let scheduledJobs = {};
let logs = [];
let restarting = false;

function setBotState(state, status) {
    botState = state;
    botStatus = status;
}

function getErrorDetails(err) {
    if (!err) return 'Erro desconhecido';
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.status) parts.push(`status=${err.status}`);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.name) parts.push(`name=${err.name}`);
    if (err.details) parts.push(`details=${err.details}`);
    if (err.hint) parts.push(`hint=${err.hint}`);
    return parts.join(' | ') || String(err);
}

function addLog(type, msg, extra = null) {
    const fullMsg = extra ? `${msg} — ${extra}` : msg;
    const entry = { type, msg: fullMsg, time: new Date().toLocaleTimeString('pt-BR', { timeZone: BRASILIA_TZ }) };
    logs.unshift(entry);
    if (logs.length > 300) logs.pop();
    console.log(`[${type}] ${fullMsg}`);
}


function sanitizeWhatsAppMessage(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[^\S\n\t]+$/gm, '')
        .trim();
}

function getBrasiliaParts() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('pt-BR', {
        timeZone: BRASILIA_TZ,
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    return {
        data: `${parts.day}/${parts.month}/${parts.year}`,
        hora: `${parts.hour}:${parts.minute}`,
        diaSemana: parts.weekday || '',
        saudacao: Number(parts.hour) < 12 ? 'Bom dia' : Number(parts.hour) < 18 ? 'Boa tarde' : 'Boa noite'
    };
}

function applyMessageVariables(message, grupo = '') {
    const p = getBrasiliaParts();
    const vars = {
        grupo,
        data: p.data,
        hora: p.hora,
        diaSemana: p.diaSemana,
        saudacao: p.saudacao
    };
    return String(message || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`;
    });
}

process.on('uncaughtException', (err) => {
    addLog('Erro', 'Exceção não tratada', getErrorDetails(err));
    console.error(err);
});

process.on('unhandledRejection', (err) => {
    addLog('Erro', 'Promise rejeitada sem tratamento', getErrorDetails(err));
    console.error(err);
});

function scheduleAll() {
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};

    config = normalizeConfig(config);

    const ativos = config.agendamentos.filter(ag => ag.ativo && ag.grupo && ag.mensagem && ag.cron);
    addLog('Cron', `Reagendando ${ativos.length} agendamento(s) ativo(s).`);

    config.agendamentos.forEach(ag => {
        if (!ag.ativo || !ag.grupo || !ag.mensagem || !ag.cron) return;
        try {
            scheduledJobs[ag.id] = cron.schedule(ag.cron, async () => {
                const agora = new Date().toLocaleString('pt-BR', { timeZone: BRASILIA_TZ });
                addLog('Cron', `Disparo iniciado: grupo="${ag.grupo}", horário="${ag.horario || 'sem horário'}", data="${agora}"`);
                try {
                    if (!ag.ativo) {
                        addLog('Cron', `Ignorado porque está inativo: grupo="${ag.grupo}"`);
                        return;
                    }
                    if (!ag.grupo || !ag.mensagem) {
                        addLog('Erro', `Agendamento incompleto: grupo="${ag.grupo || 'vazio'}"`);
                        return;
                    }
                    const result = await enviarLembrete(ag.grupo, ag.mensagem, { source: 'cron', agendamentoId: ag.id });
                    if (result.ok) addLog('Cron', `Disparo finalizado com sucesso: grupo="${ag.grupo}"`);
                    else addLog('Erro', `Disparo falhou: grupo="${ag.grupo}"`, result.msg || 'erro não informado');
                } catch (e) {
                    addLog('Erro', `Falha no agendamento: grupo="${ag.grupo}"`, getErrorDetails(e));
                }
            }, { timezone: BRASILIA_TZ });
            addLog('Cron', `Agendado: "${ag.grupo}" às ${ag.horario || 'sem horário'} [Brasília] cron="${ag.cron}" ativo=${ag.ativo ? 'sim' : 'não'}`);
        } catch (e) {
            addLog('Erro', `Cron inválido para agendamento ${ag.id}`, getErrorDetails(e));
        }
    });
}


function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntilReady(timeoutMs = READY_WAIT_MS) {
    if (botConnected && clientInstance) return true;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (botConnected && clientInstance) return true;
        if (!clientInstance || botState === 'qr' || botState === 'error' || botState === 'auth_failure' || botState === 'disconnected') return false;
        await wait(1000);
    }
    return botConnected && clientInstance;
}

async function enviarLembrete(grupo, mensagem, meta = {}) {
    if (!clientInstance || !botConnected) {
        if (clientInstance && ['starting', 'connecting', 'authenticated', 'restoring'].includes(botState)) {
            addLog('Info', `Bot ainda não está pronto. Aguardando até ${Math.round(READY_WAIT_MS / 1000)}s antes de enviar...`);
            const ready = await waitUntilReady();
            if (!ready) {
                addLog('Erro', `Bot não conectou a tempo. Estado atual: ${botStatus}`);
                return { ok: false, msg: `Bot ainda não está conectado. Estado atual: ${botStatus}` };
            }
        } else {
            addLog('Erro', `Bot não conectado. Estado atual: ${botStatus}`);
            return { ok: false, msg: `Bot não conectado. Estado atual: ${botStatus}` };
        }
    }
    try {
        const mensagemFinal = sanitizeWhatsAppMessage(applyMessageVariables(mensagem, grupo));
        if (!mensagemFinal) {
            addLog('Erro', `Mensagem vazia após limpeza. Grupo="${grupo}"`);
            return { ok: false, msg: 'Mensagem vazia após limpeza.' };
        }

        addLog('WhatsApp', `Tentando enviar mensagem para "${grupo}" com ${mensagemFinal.length} caracteres.`);
        const chats = await clientInstance.getChats();
        const g = chats.find(c => c.isGroup && c.name === grupo);
        if (g) {
            const sentMsg = await clientInstance.sendMessage(g.id._serialized, mensagemFinal);
            const msgId = sentMsg?.id?._serialized || sentMsg?.id?.id || 'sem-id';
            addLog('Sucesso', `Mensagem enviada para "${grupo}". ID=${msgId}`);
            return { ok: true, id: msgId };
        }
        addLog('Aviso', `Grupo "${grupo}" não encontrado.`);
        return { ok: false, msg: `Grupo "${grupo}" não encontrado.` };
    } catch (e) {
        addLog('Erro', 'Falha ao enviar mensagem', getErrorDetails(e));
        return { ok: false, msg: getErrorDetails(e) };
    }
}


function zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(sourceDir)) return reject(new Error(`Pasta não encontrada: ${sourceDir}`));

        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(archive.pointer()));
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

async function clearDirectory(dir) {
    if (fs.existsSync(dir)) await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
}

async function extractZip(zipPath, destination) {
    await clearDirectory(destination);
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: destination })).promise();
}

function requireSupabase() {
    if (!supabase) {
        throw new Error('Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_ANON_KEY no Render.');
    }
}


async function saveConfigToSupabase() {
    requireSupabase();
    ensureDir(path.dirname(CONFIG_FILE));
    const normalized = normalizeConfig(config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2));
    addLog('Config', `Enviando config para Supabase: ${SUPABASE_BUCKET}/${SUPABASE_CONFIG_PATH}`);

    const fileBuffer = fs.readFileSync(CONFIG_FILE);
    const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(SUPABASE_CONFIG_PATH, fileBuffer, {
            contentType: 'application/json',
            upsert: true
        });
    if (error) throw error;
    addLog('Config', 'Config salva no Supabase.');
}

async function restoreConfigFromSupabase() {
    if (!supabase) {
        addLog('Config', 'Supabase não configurado. Agendamentos não foram restaurados.');
        return false;
    }

    try {
        addLog('Config', `Tentando restaurar agendamentos do Supabase: ${SUPABASE_BUCKET}/${SUPABASE_CONFIG_PATH}`);
        const { data, error } = await supabase.storage
            .from(SUPABASE_BUCKET)
            .download(SUPABASE_CONFIG_PATH);

        if (error) {
            addLog('Config', `Nenhum arquivo remoto de agendamentos encontrado em "${SUPABASE_CONFIG_PATH}". Usando config local.`, getErrorDetails(error));
            return false;
        }

        const text = await data.text();
        const remoteConfig = normalizeConfig(JSON.parse(text));
        ensureDir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(remoteConfig, null, 2));
        config = remoteConfig;

        const total = config.agendamentos.length;
        const ativos = config.agendamentos.filter(a => a.ativo).length;
        const inativos = total - ativos;
        addLog('Config', `Agendamentos restaurados do Supabase com sucesso. Total=${total}, ativos=${ativos}, inativos=${inativos}.`);

        if (total > 0) {
            config.agendamentos.forEach((ag, index) => {
                addLog('Config', `Restaurado #${index + 1}: grupo="${ag.grupo || 'sem grupo'}", horário="${ag.horario || 'sem horário'}", ativo=${ag.ativo ? 'sim' : 'não'}, cron="${ag.cron || 'sem cron'}"`);
            });
        }
        return true;
    } catch (e) {
        addLog('Erro', 'Erro ao restaurar agendamentos do Supabase', getErrorDetails(e));
        return false;
    }
}

async function saveSessionToSupabase() {
    requireSupabase();
    ensureDir(AUTH_DIR);

    if (!fs.existsSync(AUTH_DIR)) {
        throw new Error(`Pasta de sessão não encontrada: ${AUTH_DIR}`);
    }

    const tmpFile = path.join('/tmp', `wwebjs_auth_${Date.now()}.zip`);
    addLog('Sessão', `Compactando sessão local: ${AUTH_DIR}`);
    const zipBytes = await zipDirectory(AUTH_DIR, tmpFile);
    addLog('Sessão', `ZIP criado: ${(zipBytes / 1024 / 1024).toFixed(2)} MB`);

    const fileStream = fs.createReadStream(tmpFile);
    addLog('Sessão', `Enviando para Supabase: ${SUPABASE_BUCKET}/${SUPABASE_SESSION_PATH}`);

    const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(SUPABASE_SESSION_PATH, fileStream, {
            contentType: 'application/zip',
            upsert: true
        });

    await fs.promises.rm(tmpFile, { force: true });
    if (error) throw error;
}

async function deleteSessionFromSupabase() {
    requireSupabase();
    addLog('Sessão', `Excluindo do Supabase: ${SUPABASE_BUCKET}/${SUPABASE_SESSION_PATH}`);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([SUPABASE_SESSION_PATH]);
    if (error) throw error;
}

async function restoreSessionFromSupabase() {
    requireSupabase();
    restarting = true;
    setBotState('restoring', 'Restaurando sessão...');
    const tmpFile = path.join('/tmp', `wwebjs_restore_${Date.now()}.zip`);
    addLog('Sessão', `Baixando do Supabase: ${SUPABASE_BUCKET}/${SUPABASE_SESSION_PATH}`);
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_SESSION_PATH);
    if (error) throw error;

    const buffer = Buffer.from(await data.arrayBuffer());
    await fs.promises.writeFile(tmpFile, buffer);

    await stopBot(true);
    addLog('Sessão', `Extraindo sessão em: ${AUTH_DIR}`);
    await extractZip(tmpFile, AUTH_DIR);
    await fs.promises.rm(tmpFile, { force: true });

    await restoreConfigFromSupabase();
    config = loadConfig();
    setBotState('connecting', 'Sessão restaurada. Conectando WhatsApp...');
    await iniciarBot();
}

async function stopBot(keepRestarting = false) {
    restarting = true;
    setBotState('restarting', 'Reiniciando...');
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};

    if (clientInstance) {
        try {
            await clientInstance.destroy();
        } catch (e) {
            addLog('Aviso', 'Erro ao destruir client anterior', getErrorDetails(e));
        }
    }

    clientInstance = null;
    botConnected = false;
    qrCodeDataURL = null;
    if (!keepRestarting) restarting = false;
}


app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
        ok: true,
        service: 'wa-bot',
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        now: new Date().toISOString(),
        timezone: BRASILIA_TZ,
        state: botState,
        connected: botConnected
    });
});

app.get('/health', (req, res) => {
    res.redirect('/api/health');
});

app.get('/ping', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).send('pong');
});

app.get('/api/status', (req, res) => {
    res.json({
        connected: botConnected,
        state: botState,
        status: botStatus,
        restarting,
        qr: qrCodeDataURL,
        timezone: 'Horário de Brasília',
        supabaseConfigured: Boolean(supabase),
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        supabaseBucket: SUPABASE_BUCKET,
        supabaseSessionPath: SUPABASE_SESSION_PATH,
        supabaseConfigPath: SUPABASE_CONFIG_PATH
    });
});

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
    try {
        config = normalizeConfig(req.body);
        saveConfig(config);

        try {
            await saveConfigToSupabase();
        } catch (e) {
            addLog('Erro', 'Config salva localmente, mas falhou ao salvar no Supabase', getErrorDetails(e));
        }

        if (botConnected) scheduleAll();
        addLog('Config', 'Configurações salvas.');
        res.json({ ok: true, config });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar configurações', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
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
        const grupos = chats.filter(c => c.isGroup).map(c => c.name).sort((a, b) => a.localeCompare(b));
        res.json(grupos);
    } catch (e) {
        addLog('Erro', 'Erro ao listar grupos', getErrorDetails(e));
        res.json([]);
    }
});

app.post('/api/session/save', async (req, res) => {
    try {
        await saveSessionToSupabase();
        addLog('Sessão', `Sessão salva no Supabase: ${SUPABASE_BUCKET}/${SUPABASE_SESSION_PATH}`);
        res.json({ ok: true, msg: 'Sessão salva no Supabase.' });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar sessão', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.post('/api/session/delete', async (req, res) => {
    try {
        await deleteSessionFromSupabase();
        addLog('Sessão', 'Sessão excluída do Supabase.');
        res.json({ ok: true, msg: 'Sessão excluída do Supabase.' });
    } catch (e) {
        addLog('Erro', 'Erro ao excluir sessão', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.post('/api/session/restore', async (req, res) => {
    try {
        res.json({ ok: true, msg: 'Restauração iniciada. O bot será reiniciado.' });
        restarting = true;
        setBotState('restoring', 'Restaurando sessão do Supabase...');
        addLog('Sessão', 'Restaurando sessão do Supabase...');
        setTimeout(async () => {
            try {
                await restoreSessionFromSupabase();
                addLog('Sessão', 'Sessão restaurada. Aguardando conexão do WhatsApp...');
            } catch (e) {
                addLog('Erro', 'Erro ao restaurar sessão', getErrorDetails(e));
                setBotState('error', 'Erro ao restaurar sessão');
                restarting = false;
            }
        }, 500);
    } catch (e) {
        addLog('Erro', 'Erro ao restaurar sessão', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    addLog('Servidor', `Rodando na porta ${PORT}`);
    addLog('Servidor', 'Endpoint de uptime disponível em /api/health');
});

async function iniciarBot() {
    if (clientInstance) return;

    setBotState('connecting', 'Iniciando WhatsApp...');

    ensureDir(AUTH_DIR);
    const execPath = await chromium.executablePath();
    addLog('Info', `Chrome: ${execPath}`);
    addLog('Info', `Sessão local: ${AUTH_DIR}`);

    clientInstance = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
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

    clientInstance.on('loading_screen', (percent, message) => {
        setBotState('connecting', `Carregando WhatsApp ${percent || 0}%...`);
        addLog('WhatsApp', `Carregando ${percent || 0}%`, message || '');
    });

    clientInstance.on('authenticated', () => {
        qrCodeDataURL = null;
        setBotState('authenticated', 'Sessão autenticada. Finalizando conexão...');
        addLog('Bot', 'Sessão autenticada. Aguardando ready...');
    });

    clientInstance.on('qr', async (qr) => {
        addLog('QR', 'Novo QR Code gerado — acesse o painel para escanear.');
        qrCodeDataURL = await qrcode.toDataURL(qr);
        setBotState('qr', 'Aguardando escaneamento...');
        botConnected = false;
        restarting = false;
    });

    clientInstance.on('ready', () => {
        addLog('Bot', 'Conectado com sucesso!');
        qrCodeDataURL = null;
        setBotState('ready', 'Conectado');
        botConnected = true;
        restarting = false;
        scheduleAll();
    });


    clientInstance.on('message_ack', (msg, ack) => {
        const msgId = msg?.id?._serialized || msg?.id?.id || 'sem-id';
        const ackStatus = {
            '-1': 'erro',
            '0': 'pendente',
            '1': 'recebida pelo servidor',
            '2': 'entregue ao dispositivo',
            '3': 'lida',
            '4': 'reproduzida'
        };
        addLog('ACK', `Mensagem ${msgId}: ${ackStatus[String(ack)] || ack}`);
    });

    clientInstance.on('auth_failure', (msg) => {
        addLog('Erro', `Falha de autenticação: ${msg}`);
        setBotState('auth_failure', 'Erro de autenticação');
        botConnected = false;
        restarting = false;
    });

    clientInstance.on('disconnected', (reason) => {
        addLog('Bot', `Desconectado: ${reason}`);
        setBotState('disconnected', 'Desconectado');
        botConnected = false;
        restarting = false;
        qrCodeDataURL = null;
        clientInstance = null;
        if (!restarting) setTimeout(() => iniciarBot(), 5000);
    });

    setBotState('connecting', 'Inicializando client do WhatsApp...');
    clientInstance.initialize().catch((e) => {
        addLog('Erro', 'Erro ao inicializar WhatsApp', getErrorDetails(e));
        setBotState('error', 'Erro ao inicializar WhatsApp');
        botConnected = false;
        restarting = false;
        clientInstance = null;
        if (!restarting) setTimeout(() => iniciarBot(), 8000);
    });
}

async function bootstrap() {
    await restoreConfigFromSupabase();
    config = loadConfig();
    await iniciarBot();
}

bootstrap();
