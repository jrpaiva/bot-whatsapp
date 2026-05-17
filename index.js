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
const PREDEFINIDAS_FILE = path.join('/tmp', 'predefinidas.json');
const BRASILIA_TZ = 'America/Sao_Paulo';
const READY_WAIT_MS = Number(process.env.WWEBJS_READY_WAIT_MS || 45000);
const STARTED_AT = new Date();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'whatsapp-sessions';
const SUPABASE_SESSION_PATH = process.env.SUPABASE_SESSION_PATH || 'wwebjs_auth.zip';
const SUPABASE_CONFIG_PATH = process.env.SUPABASE_CONFIG_PATH || 'bot_config.json';
const SUPABASE_PREDEFINIDAS_PATH = process.env.SUPABASE_PREDEFINIDAS_PATH || 'predefinidas.json';

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── CONFIG ─────────────────────────────────────────────────────────────────

function getDefaultConfig() {
    return { agendamentos: [] };
}

function migrateAgendamento(ag) {
    const migrated = { ...ag };
    if (!migrated.horario || !Array.isArray(migrated.diasSemana)) {
        const parsed = parseCron(migrated.cron || '0 12 * * 1-3');
        migrated.horario = migrated.horario || parsed.horario;
        migrated.diasSemana = Array.isArray(migrated.diasSemana) ? migrated.diasSemana : parsed.diasSemana;
    }
    migrated.grupo = migrated.grupo || '';
    migrated.grupoId = migrated.grupoId || '';
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
    return { horario, diasSemana: parseDays(daysExpr) };
}

function parseDays(daysExpr) {
    if (!daysExpr || daysExpr === '*') return [0, 1, 2, 3, 4, 5, 6];
    const days = new Set();
    String(daysExpr).split(',').forEach(part => {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            if (Number.isInteger(start) && Number.isInteger(end))
                for (let d = start; d <= end; d++) days.add(d);
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
        if (fs.existsSync(CONFIG_FILE))
            return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) { console.error('[Config] Erro ao carregar:', e.message); }
    return getDefaultConfig();
}

function saveConfig(cfg) {
    try {
        ensureDir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalizeConfig(cfg), null, 2));
    } catch (e) { console.error('[Config] Erro ao salvar:', e.message); }
}

// ── PREDEFINIDAS ───────────────────────────────────────────────────────────

function loadPredefinidas() {
    try {
        if (fs.existsSync(PREDEFINIDAS_FILE))
            return JSON.parse(fs.readFileSync(PREDEFINIDAS_FILE, 'utf8'));
    } catch (e) { console.error('[Predefinidas] Erro ao carregar:', e.message); }
    return [];
}

function savePredefinidas(list) {
    try {
        ensureDir(path.dirname(PREDEFINIDAS_FILE));
        fs.writeFileSync(PREDEFINIDAS_FILE, JSON.stringify(list, null, 2));
    } catch (e) { console.error('[Predefinidas] Erro ao salvar:', e.message); }
}

async function savePredefinidasToSupabase(list) {
    if (!supabase) return;
    try {
        const buf = Buffer.from(JSON.stringify(list, null, 2));
        const { error } = await supabase.storage.from(SUPABASE_BUCKET)
            .upload(SUPABASE_PREDEFINIDAS_PATH, buf, { contentType: 'application/json', upsert: true });
        if (error) throw error;
        addLog('Config', `Predefinidas salvas no Supabase: ${SUPABASE_BUCKET}/${SUPABASE_PREDEFINIDAS_PATH}.`);
    } catch (e) { addLog('Erro', 'Falha ao salvar predefinidas no Supabase', getErrorDetails(e)); }
}

async function restorePredefinidasFromSupabase() {
    if (!supabase) return;
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_PREDEFINIDAS_PATH);
        if (error) return;
        const list = JSON.parse(await data.text());
        savePredefinidas(list);
        addLog('Config', `Predefinidas restauradas do Supabase. Total=${list.length}.`);
    } catch (e) { addLog('Aviso', 'Sem predefinidas no Supabase.'); }
}

let config = loadConfig();
let predefinidas = loadPredefinidas();

// ── STATE ──────────────────────────────────────────────────────────────────

let qrCodeDataURL = null;
let botStatus = 'Inicializando...';
let botState = 'starting';
let botConnected = false;
let clientInstance = null;
let scheduledJobs = {};
let logs = [];
let restarting = false;

function setBotState(state, status) { botState = state; botStatus = status; }

function getErrorDetails(err) {
    if (!err) return 'Erro desconhecido';
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.status) parts.push(`status=${err.status}`);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.name) parts.push(`name=${err.name}`);
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
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[^\S\n\t]+$/gm, '').trim();
}

function getBrasiliaParts() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('pt-BR', {
        timeZone: BRASILIA_TZ, weekday: 'long', day: '2-digit',
        month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
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
    const vars = { grupo, data: p.data, hora: p.hora, diaSemana: p.diaSemana, saudacao: p.saudacao };
    return String(message || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`
    );
}

process.on('uncaughtException', (err) => { addLog('Erro', 'Exceção não tratada', getErrorDetails(err)); console.error(err); });
process.on('unhandledRejection', (err) => { addLog('Erro', 'Promise rejeitada', getErrorDetails(err)); console.error(err); });

// ── CRON ───────────────────────────────────────────────────────────────────

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
                addLog('Cron', `Disparo: "${ag.grupo}" às ${agora}`);
                try {
                    const result = await enviarLembrete(ag.grupo, ag.mensagem, { grupoId: ag.grupoId });
                    if (result.ok) addLog('Cron', `OK: "${ag.grupo}"`);
                    else addLog('Erro', `Falhou: "${ag.grupo}"`, result.msg);
                } catch (e) { addLog('Erro', `Falha no agendamento: "${ag.grupo}"`, getErrorDetails(e)); }
            }, { timezone: BRASILIA_TZ });
            addLog('Cron', `Agendado: "${ag.grupo}" às ${ag.horario} [Brasília]`);
        } catch (e) { addLog('Erro', `Cron inválido: ${ag.id}`, getErrorDetails(e)); }
    });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntilReady(timeoutMs = READY_WAIT_MS) {
    if (botConnected && clientInstance) return true;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (botConnected && clientInstance) return true;
        if (!clientInstance || ['qr', 'error', 'auth_failure', 'disconnected'].includes(botState)) return false;
        await wait(1000);
    }
    return botConnected && clientInstance;
}

// ── ENVIAR (com validação de participação + ACK) ───────────────────────────

async function enviarLembrete(grupo, mensagem, meta = {}) {
    const grupoId = meta.grupoId || '';

    if (!clientInstance || !botConnected) {
        if (clientInstance && ['starting', 'connecting', 'authenticated', 'restoring'].includes(botState)) {
            addLog('Info', `Aguardando bot ficar pronto...`);
            const ready = await waitUntilReady();
            if (!ready) return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
        } else {
            return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
        }
    }

    try {
        const mensagemFinal = sanitizeWhatsAppMessage(applyMessageVariables(mensagem, grupo));
        if (!mensagemFinal) return { ok: false, msg: 'Mensagem vazia.' };

        addLog('WhatsApp', `Tentando enviar para "${grupo}"${grupoId ? ` id="${grupoId}"` : ''}`);

        // 1. Resolve destino
        let destinoId = grupoId || null;
        let destinoNome = grupo;

        if (!destinoId) {
            const chats = await clientInstance.getChats();
            const matches = chats.filter(c => c.isGroup && c.name === grupo);
            if (!matches.length) {
                addLog('Aviso', `Grupo "${grupo}" não encontrado.`);
                return { ok: false, msg: `Grupo "${grupo}" não encontrado.` };
            }
            if (matches.length > 1) addLog('Aviso', `${matches.length} grupos com nome "${grupo}". Salve o ID correto.`);
            destinoId = matches[0].id._serialized;
            destinoNome = matches[0].name;
        }

        // 2. Valida participação ANTES de enviar
        try {
            const chatObj = await clientInstance.getChatById(destinoId);
            const botNumber = String(clientInstance.info?.wid?._serialized || '').replace(/\D/g, '');

            if (chatObj && Array.isArray(chatObj.participants) && botNumber) {
                const participa = chatObj.participants.some(p =>
                    String(p?.id?._serialized || p?.id?.user || p?.id || '').replace(/\D/g, '') === botNumber
                );
                if (!participa) {
                    addLog('Erro', `Bot NÃO está mais no grupo "${destinoNome}". Corrija o agendamento.`);
                    return { ok: false, msg: `Bot foi removido do grupo "${destinoNome}".` };
                }
            }
            if (chatObj?.isReadOnly) {
                addLog('Erro', `Grupo "${destinoNome}" está somente leitura.`);
                return { ok: false, msg: `Grupo "${destinoNome}" está somente leitura.` };
            }
            destinoNome = chatObj?.name || destinoNome;
        } catch (validErr) {
            addLog('Aviso', `Não foi possível validar grupo "${destinoNome}": ${getErrorDetails(validErr)}. Abortando.`);
            return { ok: false, msg: `Grupo "${destinoNome}" parece inválido: ${getErrorDetails(validErr)}` };
        }

        addLog('WhatsApp', `Destino validado: "${destinoNome}" (${destinoId})`);

        // 3. Envia e rastreia ACK
        return await new Promise(async (resolve) => {
            let resolved = false;
            let ackTimeout = null;
            let sentMsgId = null;

            function finish(result) {
                if (resolved) return;
                resolved = true;
                if (ackTimeout) clearTimeout(ackTimeout);
                if (clientInstance) clientInstance.removeListener('message_ack', onAck);
                resolve(result);
            }

            function onAck(msg, ack) {
                const mid = msg?.id?._serialized || msg?.id?.id || '';
                if (!sentMsgId || mid !== sentMsgId) return;

                const labels = {
                    '-1': 'erro/rejeitada',
                    '0': 'pendente',
                    '1': 'recebida pelo servidor do WhatsApp',
                    '2': 'entregue ao destino',
                    '3': 'lida',
                    '4': 'reproduzida'
                };

                addLog('ACK', `Mensagem ${mid}: ${labels[String(ack)] || ack}`);

                if (ack === -1) {
                    addLog('Erro', `ACK negativo para "${destinoNome}". Mensagem rejeitada.`);
                    finish({ ok: false, msg: `ACK negativo: mensagem rejeitada para "${destinoNome}".` });
                } else if (ack >= 2) {
                    addLog('Sucesso', `Mensagem entregue ao destino "${destinoNome}". ID=${mid}`);
                    finish({ ok: true, id: mid, grupo: destinoNome, grupoId: destinoId, ack });
                }
            }

            if (clientInstance) clientInstance.on('message_ack', onAck);

            ackTimeout = setTimeout(() => {
                addLog('Erro', `Mensagem NÃO confirmou entrega para "${destinoNome}" em 45s. Último ACK pode ter ficado abaixo de 2.`);
                finish({ ok: false, msg: `Mensagem enviada ao servidor, mas não confirmou entrega no grupo "${destinoNome}".` });
            }, 45000);

            try {
                const sentMsg = await clientInstance.sendMessage(destinoId, mensagemFinal);
                sentMsgId = sentMsg?.id?._serialized || sentMsg?.id?.id || null;
                if (sentMsgId) {
                    addLog('WhatsApp', `Mensagem enviada ao servidor para "${destinoNome}". ID=${sentMsgId}. Aguardando ACK 2...`);
                } else {
                    addLog('Aviso', `Mensagem enviada para "${destinoNome}", mas sem ID de rastreio. Não foi possível aguardar ACK.`);
                    finish({ ok: true, grupo: destinoNome, grupoId: destinoId });
                }
            } catch (sendErr) {
                addLog('Erro', `sendMessage falhou: "${destinoNome}"`, getErrorDetails(sendErr));
                finish({ ok: false, msg: getErrorDetails(sendErr) });
            }
        });

    } catch (e) {
        addLog('Erro', 'Falha geral ao enviar', getErrorDetails(e));
        return { ok: false, msg: getErrorDetails(e) };
    }
}

// ── SUPABASE ───────────────────────────────────────────────────────────────

function requireSupabase() {
    if (!supabase) throw new Error('Supabase não configurado.');
}

async function saveConfigToSupabase() {
    requireSupabase();
    ensureDir(path.dirname(CONFIG_FILE));
    const normalized = normalizeConfig(config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2));
    const { error } = await supabase.storage.from(SUPABASE_BUCKET)
        .upload(SUPABASE_CONFIG_PATH, fs.readFileSync(CONFIG_FILE), { contentType: 'application/json', upsert: true });
    if (error) throw error;
    addLog('Config', 'Config salva no Supabase.');
}

async function restoreConfigFromSupabase() {
    if (!supabase) { addLog('Config', 'Supabase não configurado.'); return false; }
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_CONFIG_PATH);
        if (error) { addLog('Config', 'Sem config remota. Usando local.'); return false; }
        const remoteConfig = normalizeConfig(JSON.parse(await data.text()));
        ensureDir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(remoteConfig, null, 2));
        config = remoteConfig;
        addLog('Config', `Agendamentos restaurados. Total=${config.agendamentos.length}`);
        return true;
    } catch (e) { addLog('Erro', 'Erro ao restaurar config', getErrorDetails(e)); return false; }
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

async function saveSessionToSupabase() {
    requireSupabase();
    ensureDir(AUTH_DIR);
    const tmpFile = path.join('/tmp', `wwebjs_auth_${Date.now()}.zip`);
    const zipBytes = await zipDirectory(AUTH_DIR, tmpFile);
    addLog('Sessão', `ZIP: ${(zipBytes / 1024 / 1024).toFixed(2)} MB`);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET)
        .upload(SUPABASE_SESSION_PATH, fs.createReadStream(tmpFile), { contentType: 'application/zip', upsert: true });
    await fs.promises.rm(tmpFile, { force: true });
    if (error) throw error;
}

async function deleteSessionFromSupabase() {
    requireSupabase();
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([SUPABASE_SESSION_PATH]);
    if (error) throw error;
}

async function restoreSessionFromSupabase() {
    requireSupabase();
    restarting = true;
    setBotState('restoring', 'Restaurando sessão...');
    const tmpFile = path.join('/tmp', `wwebjs_restore_${Date.now()}.zip`);
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_SESSION_PATH);
    if (error) throw error;
    await fs.promises.writeFile(tmpFile, Buffer.from(await data.arrayBuffer()));
    await stopBot(true);
    await extractZip(tmpFile, AUTH_DIR);
    await fs.promises.rm(tmpFile, { force: true });
    await restoreConfigFromSupabase();
    await restorePredefinidasFromSupabase();
    config = loadConfig();
    predefinidas = loadPredefinidas();
    setBotState('connecting', 'Sessão restaurada. Conectando...');
    await iniciarBot();
}

async function stopBot(keepRestarting = false) {
    restarting = true;
    setBotState('restarting', 'Reiniciando...');
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};
    if (clientInstance) {
        try { await clientInstance.destroy(); } catch (e) { addLog('Aviso', 'Erro ao destruir client', getErrorDetails(e)); }
    }
    clientInstance = null;
    botConnected = false;
    qrCodeDataURL = null;
    if (!keepRestarting) restarting = false;
}

// ── ROTAS ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'wa-bot', uptimeSeconds: Math.floor(process.uptime()), state: botState, connected: botConnected });
});
app.get('/health', (req, res) => res.redirect('/api/health'));
app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/api/status', (req, res) => {
    res.json({
        connected: botConnected, state: botState, status: botStatus, restarting, qr: qrCodeDataURL,
        supabaseConfigured: Boolean(supabase), uptimeSeconds: Math.floor(process.uptime()),
        startedAt: STARTED_AT.toISOString(), supabaseBucket: SUPABASE_BUCKET,
        supabaseSessionPath: SUPABASE_SESSION_PATH, supabaseConfigPath: SUPABASE_CONFIG_PATH
    });
});

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
    try {
        config = normalizeConfig(req.body);
        saveConfig(config);
        try { await saveConfigToSupabase(); } catch (e) { addLog('Erro', 'Falhou ao salvar no Supabase', getErrorDetails(e)); }
        if (botConnected) scheduleAll();
        addLog('Config', 'Configurações salvas.');
        res.json({ ok: true, config });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar config', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

// Salvar agendamento individual
app.post('/api/config/agendamento/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const ag = req.body;
        const idx = config.agendamentos.findIndex(a => a.id === id);
        if (idx === -1) {
            config.agendamentos.push(migrateAgendamento({ ...ag, id }));
        } else {
            config.agendamentos[idx] = migrateAgendamento({ ...ag, id });
        }
        saveConfig(config);
        try { await saveConfigToSupabase(); } catch (e) { addLog('Aviso', 'Supabase falhou', getErrorDetails(e)); }
        if (botConnected) scheduleAll();
        addLog('Config', `Agendamento #${id} salvo.`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/enviar', async (req, res) => {
    const { grupo, grupoId, mensagem } = req.body;
    if ((!grupo && !grupoId) || !mensagem) return res.json({ ok: false, msg: 'Grupo e mensagem obrigatórios.' });
    const result = await enviarLembrete(grupo || grupoId, mensagem, { grupoId });
    res.json(result);
});

app.get('/api/grupos', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!clientInstance || !botConnected) return res.json([]);
    try {
        const chats = await clientInstance.getChats();
        const botNumber = String(clientInstance.info?.wid?._serialized || '').replace(/\D/g, '');
        const grupos = [];
        for (const chat of chats) {
            if (!chat.isGroup) continue;
            const groupId = chat.id?._serialized || '';
            const nome = chat.name || '';
            try {
                const fullChat = await clientInstance.getChatById(groupId);
                const participants = Array.isArray(fullChat.participants) ? fullChat.participants : [];
                const participa = Boolean(botNumber) && participants.some(p =>
                    String(p?.id?._serialized || p?.id?.user || p?.id || '').replace(/\D/g, '') === botNumber
                );
                if (!participa) continue;
                if (fullChat.isReadOnly) continue;
                grupos.push({ nome, id: groupId });
            } catch (e) { addLog('Aviso', `Falha ao validar "${nome}"`, getErrorDetails(e)); }
        }
        grupos.sort((a, b) => a.nome.localeCompare(b.nome));
        res.json(grupos);
    } catch (e) { addLog('Erro', 'Erro ao listar grupos', getErrorDetails(e)); res.json([]); }
});

// ── PREDEFINIDAS ROUTES ────────────────────────────────────────────────────

app.get('/api/predefinidas', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.json(predefinidas);
});

app.post('/api/predefinidas', async (req, res) => {
    try {
        const { id, titulo, mensagem, categoria } = req.body;
        if (!titulo || !mensagem) return res.status(400).json({ ok: false, msg: 'Título e mensagem obrigatórios.' });
        if (id) {
            const idx = predefinidas.findIndex(p => p.id === id);
            if (idx !== -1) {
                predefinidas[idx] = { ...predefinidas[idx], titulo, mensagem, categoria: categoria || '', updatedAt: new Date().toISOString() };
                addLog('Config', `Predefinida atualizada: "${titulo}"`);
            } else {
                predefinidas.push({ id, titulo, mensagem, categoria: categoria || '', createdAt: new Date().toISOString() });
                addLog('Config', `Predefinida criada: "${titulo}"`);
            }
        } else {
            const newId = Date.now();
            predefinidas.push({ id: newId, titulo, mensagem, categoria: categoria || '', createdAt: new Date().toISOString() });
            addLog('Config', `Predefinida criada: "${titulo}"`);
        }
        savePredefinidas(predefinidas);
        await savePredefinidasToSupabase(predefinidas);
        res.json({ ok: true, predefinidas });
    } catch (e) {
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.delete('/api/predefinidas/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        predefinidas = predefinidas.filter(p => p.id !== id);
        savePredefinidas(predefinidas);
        await savePredefinidasToSupabase(predefinidas);
        addLog('Config', `Predefinida #${id} removida.`);
        res.json({ ok: true, predefinidas });
    } catch (e) {
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

// ── SESSION ROUTES ─────────────────────────────────────────────────────────

app.post('/api/session/save', async (req, res) => {
    try {
        await saveSessionToSupabase();
        addLog('Sessão', 'Sessão salva no Supabase.');
        res.json({ ok: true, msg: 'Sessão salva no Supabase.' });
    } catch (e) { addLog('Erro', 'Erro ao salvar sessão', getErrorDetails(e)); res.status(500).json({ ok: false, msg: getErrorDetails(e) }); }
});

app.post('/api/session/delete', async (req, res) => {
    try {
        await deleteSessionFromSupabase();
        addLog('Sessão', 'Sessão excluída.');
        res.json({ ok: true, msg: 'Sessão excluída do Supabase.' });
    } catch (e) { addLog('Erro', 'Erro ao excluir sessão', getErrorDetails(e)); res.status(500).json({ ok: false, msg: getErrorDetails(e) }); }
});

app.post('/api/session/restart', async (req, res) => {
    try {
        res.json({ ok: true, msg: 'Reiniciando WhatsApp...' });
        setTimeout(async () => {
            try { await stopBot(true); await wait(1500); await iniciarBot(); }
            catch (e) { addLog('Erro', 'Erro ao reiniciar', getErrorDetails(e)); restarting = false; }
        }, 300);
    } catch (e) { res.status(500).json({ ok: false, msg: getErrorDetails(e) }); }
});

app.post('/api/session/restore', async (req, res) => {
    try {
        res.json({ ok: true, msg: 'Restauração iniciada.' });
        restarting = true;
        setBotState('restoring', 'Restaurando sessão...');
        setTimeout(async () => {
            try { await restoreSessionFromSupabase(); }
            catch (e) { addLog('Erro', 'Erro ao restaurar', getErrorDetails(e)); setBotState('error', 'Erro ao restaurar'); restarting = false; }
        }, 500);
    } catch (e) { res.status(500).json({ ok: false, msg: getErrorDetails(e) }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    addLog('Servidor', `Rodando na porta ${PORT}`);
    addLog('Servidor', 'Uptime em /api/health');
});

// ── WHATSAPP ───────────────────────────────────────────────────────────────

async function iniciarBot() {
    if (clientInstance) return;
    setBotState('connecting', 'Iniciando WhatsApp...');
    ensureDir(AUTH_DIR);
    const execPath = await chromium.executablePath();
    addLog('Info', `Chrome: ${execPath} | Sessão: ${AUTH_DIR}`);

    clientInstance = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
        puppeteer: {
            executablePath: execPath,
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
            headless: true
        }
    });

    clientInstance.on('loading_screen', (percent, message) => {
        setBotState('connecting', `Carregando ${percent || 0}%...`);
    });

    clientInstance.on('authenticated', () => {
        qrCodeDataURL = null;
        setBotState('authenticated', 'Autenticado. Finalizando...');
        addLog('Bot', 'Autenticado. Aguardando ready...');
    });

    clientInstance.on('qr', async (qr) => {
        addLog('QR', 'Novo QR Code — acesse o painel.');
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

    clientInstance.on('message_ack', () => {}); // rastreado individualmente em enviarLembrete

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

    clientInstance.initialize().catch((e) => {
        addLog('Erro', 'Erro ao inicializar', getErrorDetails(e));
        setBotState('error', 'Erro ao inicializar');
        botConnected = false;
        restarting = false;
        clientInstance = null;
        if (!restarting) setTimeout(() => iniciarBot(), 8000);
    });
}

async function bootstrap() {
    await restoreConfigFromSupabase();
    await restorePredefinidasFromSupabase();
    config = loadConfig();
    predefinidas = loadPredefinidas();
    await iniciarBot();
}

bootstrap();
