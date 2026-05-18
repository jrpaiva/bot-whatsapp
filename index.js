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
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || '/mcp';
const LOG_MAX_ENTRIES = Number(process.env.LOG_MAX_ENTRIES || 180);
const LOG_AUTO_CLEAR_HOURS = Number(process.env.LOG_AUTO_CLEAR_HOURS || 12);
const LOG_CRON_DETAILS = String(process.env.LOG_CRON_DETAILS || 'false').toLowerCase() === 'true';
const MEMORY_WARN_MB = Number(process.env.MEMORY_WARN_MB || 450);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'whatsapp-sessions';
const SUPABASE_SESSION_PATH = process.env.SUPABASE_SESSION_PATH || 'wwebjs_auth.zip';
const SUPABASE_CONFIG_PATH = process.env.SUPABASE_CONFIG_PATH || 'bot_config.json';
const SUPABASE_PREDEFINIDAS_PATH = process.env.SUPABASE_PREDEFINIDAS_PATH || 'predefinidas.json';
const PREDEFINIDAS_FILE = process.env.BOT_PREDEFINIDAS_FILE || path.join('/tmp', 'predefinidas.json');

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
                grupoId: '',
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
let lastLoadingLog = { bucket: null, at: 0 };
let memoryWarningActive = false;

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
    const entry = {
        type,
        msg: fullMsg,
        time: new Date().toLocaleTimeString('pt-BR', { timeZone: BRASILIA_TZ })
    };

    logs.unshift(entry);

    if (logs.length > LOG_MAX_ENTRIES) {
        logs.length = LOG_MAX_ENTRIES;
    }

    console.log(`[${type}] ${fullMsg}`);
}

function clearLogs(reason = 'manual') {
    const removed = logs.length;
    logs = [];
    addLog('Sistema', `Logs limpos automaticamente. Motivo=${reason}. Removidos=${removed}. Limite atual=${LOG_MAX_ENTRIES}.`);
}

function getMemorySnapshot() {
    const mem = process.memoryUsage();
    const toMb = bytes => Math.round(bytes / 1024 / 1024);
    return {
        rssMb: toMb(mem.rss),
        heapUsedMb: toMb(mem.heapUsed),
        heapTotalMb: toMb(mem.heapTotal),
        externalMb: toMb(mem.external)
    };
}

function logMemoryIfNeeded(force = false) {
    const mem = getMemorySnapshot();
    const details = `rss=${mem.rssMb}MB heap=${mem.heapUsedMb}/${mem.heapTotalMb}MB external=${mem.externalMb}MB`;

    if (force) {
        addLog('Sistema', `Memória atual: ${details}`);
        return;
    }

    if (mem.rssMb >= MEMORY_WARN_MB && !memoryWarningActive) {
        memoryWarningActive = true;
        addLog('Aviso', `Memória alta: ${details}. Render Free costuma reiniciar perto de 512MB.`);
    }

    if (mem.rssMb < MEMORY_WARN_MB - 60) {
        memoryWarningActive = false;
    }
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
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
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

process.on('SIGTERM', () => {
    addLog('Sistema', 'Recebido SIGTERM. O ambiente está encerrando/reiniciando o serviço.');
});

process.on('SIGINT', () => {
    addLog('Sistema', 'Recebido SIGINT. Processo interrompido.');
});

addLog('Sistema', `Processo iniciado. PID=${process.pid}. Limite de logs=${LOG_MAX_ENTRIES}. Limpeza automática=${LOG_AUTO_CLEAR_HOURS}h.`);
logMemoryIfNeeded(true);

if (LOG_AUTO_CLEAR_HOURS > 0) {
    setInterval(() => {
        clearLogs(`${LOG_AUTO_CLEAR_HOURS}h`);
        logMemoryIfNeeded(true);
    }, LOG_AUTO_CLEAR_HOURS * 60 * 60 * 1000);
}

setInterval(() => {
    logMemoryIfNeeded(false);
}, 5 * 60 * 1000);

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
                addLog('Cron', `Disparo: grupo="${ag.grupo}", id="${ag.grupoId || 'sem id'}", horário="${ag.horario || ''}", data="${agora}"`);
                try {
                    if (!ag.ativo) { addLog('Cron', `Ignorado (inativo): "${ag.grupo}"`); return; }
                    if (!ag.grupo || !ag.mensagem) { addLog('Erro', `Agendamento incompleto: "${ag.grupo || 'vazio'}"`); return; }
                    const result = await enviarLembrete(ag.grupo, ag.mensagem, { source: 'cron', agendamentoId: ag.id, grupoId: ag.grupoId });
                    if (result.ok) addLog('Cron', `Disparo OK: "${ag.grupo}"`);
                    else addLog('Erro', `Disparo falhou: "${ag.grupo}"`, result.msg || 'erro não informado');
                } catch (e) {
                    addLog('Erro', `Falha no agendamento: "${ag.grupo}"`, getErrorDetails(e));
                }
            }, { timezone: BRASILIA_TZ });
            if (LOG_CRON_DETAILS) {
                addLog('Cron', `Agendado: "${ag.grupo}" às ${ag.horario || '?'} [Brasília] cron="${ag.cron}"`);
            }
        } catch (e) {
            addLog('Erro', `Cron inválido para agendamento ${ag.id}`, getErrorDetails(e));
        }
    });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// ── FUNÇÃO CORRIGIDA: valida participação e rastreia ACK ───────────────────
async function enviarLembrete(grupo, mensagem, meta = {}) {
    const grupoId = meta.grupoId || '';

    if (!clientInstance || !botConnected) {
        if (clientInstance && ['starting', 'connecting', 'authenticated', 'restoring'].includes(botState)) {
            addLog('Info', `Bot ainda não pronto. Aguardando até ${Math.round(READY_WAIT_MS / 1000)}s...`);
            const ready = await waitUntilReady();
            if (!ready) {
                addLog('Erro', `Bot não conectou a tempo. Estado: ${botStatus}`);
                return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
            }
        } else {
            addLog('Erro', `Bot não conectado. Estado: ${botStatus}`);
            return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
        }
    }

    try {
        const mensagemFinal = sanitizeWhatsAppMessage(applyMessageVariables(mensagem, grupo));
        if (!mensagemFinal) {
            addLog('Erro', `Mensagem vazia após limpeza. Grupo="${grupo}"`);
            return { ok: false, msg: 'Mensagem vazia após limpeza.' };
        }

        addLog('WhatsApp', `Tentando enviar para "${grupo}"${grupoId ? ` id="${grupoId}"` : ''}`);

        // ── 1. Resolve o destino ──────────────────────────────────────────
        let destinoId = grupoId || null;
        let destinoNome = grupo;

        if (!destinoId) {
            // Sem ID salvo: busca pelo nome (risco de cache, avisa)
            const chats = await clientInstance.getChats();
            const matches = chats.filter(c => c.isGroup && c.name === grupo);
            if (matches.length > 1) {
                addLog('Aviso', `${matches.length} grupos com nome "${grupo}". Salve o ID correto no painel.`);
            }
            const g = matches[0];
            if (!g) {
                addLog('Aviso', `Grupo "${grupo}" não encontrado em getChats().`);
                return { ok: false, msg: `Grupo "${grupo}" não encontrado.` };
            }
            destinoId = g.id._serialized;
            destinoNome = g.name;
        }

        // ── 2. Valida participação ANTES de enviar ────────────────────────
        try {
            const chatObj = await clientInstance.getChatById(destinoId);
            const botIdRaw = clientInstance.info?.wid?._serialized || '';
            const botNumber = String(botIdRaw).replace(/\D/g, '');

            if (chatObj && Array.isArray(chatObj.participants) && botNumber) {
                const aindaParticipa = chatObj.participants.some(p => {
                    const pid = String(
                        p?.id?._serialized || p?.id?.user || p?.id || ''
                    ).replace(/\D/g, '');
                    return pid === botNumber;
                });

                if (!aindaParticipa) {
                    addLog('Erro', `Bot NÃO está mais no grupo "${destinoNome}" (${destinoId}). Remova ou corrija o agendamento.`);
                    return { ok: false, msg: `Bot foi removido do grupo "${destinoNome}". Corrija o agendamento.` };
                }
            }

            if (chatObj?.isReadOnly === true) {
                addLog('Erro', `Grupo "${destinoNome}" está somente leitura.`);
                return { ok: false, msg: `Grupo "${destinoNome}" está somente leitura.` };
            }

            destinoNome = chatObj?.name || destinoNome;
        } catch (validErr) {
            // getChatById pode falhar para IDs completamente inválidos
            addLog('Aviso', `Não foi possível validar grupo "${destinoNome}" (${destinoId}): ${getErrorDetails(validErr)}. Abortando por segurança.`);
            return { ok: false, msg: `Grupo "${destinoNome}" parece inválido ou inexistente: ${getErrorDetails(validErr)}` };
        }

        addLog('WhatsApp', `Destino validado: nome="${destinoNome}", id="${destinoId}"`);

        // ── 3. Envia e aguarda ACK para confirmar sucesso ─────────────────
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

                const ackLabels = { '-1': 'ERRO', '0': 'pendente', '1': 'enviado ao servidor', '2': 'entregue', '3': 'lida', '4': 'reproduzida' };
                addLog('ACK', `Mensagem ${mid}: ${ackLabels[String(ack)] || ack}`);

                if (ack === -1) {
                    addLog('Erro', `ACK negativo para "${destinoNome}" (${destinoId}). Mensagem rejeitada pelo WhatsApp.`);
                    finish({ ok: false, msg: `ACK negativo: mensagem rejeitada pelo WhatsApp para "${destinoNome}".` });
                } else if (ack >= 1) {
                    addLog('Sucesso', `Mensagem confirmada para "${destinoNome}". GrupoID=${destinoId}. ID=${mid}`);
                    finish({ ok: true, id: mid, grupo: destinoNome, grupoId: destinoId });
                }
            }

            if (clientInstance) clientInstance.on('message_ack', onAck);

            // Timeout de segurança: se ACK não chegar em 15s, considera enviado
            ackTimeout = setTimeout(() => {
                addLog('Aviso', `ACK não chegou em 15s para "${destinoNome}". Considerando como enviado.`);
                finish({ ok: true, grupo: destinoNome, grupoId: destinoId });
            }, 15000);

            try {
                const sentMsg = await clientInstance.sendMessage(destinoId, mensagemFinal);
                sentMsgId = sentMsg?.id?._serialized || sentMsg?.id?.id || null;

                if (!sentMsgId) {
                    addLog('Sucesso', `Mensagem enviada para "${destinoNome}" (sem ID para rastrear ACK).`);
                    finish({ ok: true, grupo: destinoNome, grupoId: destinoId });
                }
            } catch (sendErr) {
                addLog('Erro', `Falha no sendMessage para "${destinoNome}"`, getErrorDetails(sendErr));
                finish({ ok: false, msg: getErrorDetails(sendErr) });
            }
        });

    } catch (e) {
        addLog('Erro', 'Falha geral ao enviar', getErrorDetails(e));
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
    if (!supabase) throw new Error('Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Render.');
}

async function saveConfigToSupabase() {
    requireSupabase();
    ensureDir(path.dirname(CONFIG_FILE));
    const normalized = normalizeConfig(config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2));
    addLog('Config', `Enviando config para Supabase: ${SUPABASE_BUCKET}/${SUPABASE_CONFIG_PATH}`);
    const fileBuffer = fs.readFileSync(CONFIG_FILE);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_CONFIG_PATH, fileBuffer, { contentType: 'application/json', upsert: true });
    if (error) throw error;
    addLog('Config', 'Config salva no Supabase.');
}

async function restoreConfigFromSupabase() {
    if (!supabase) { addLog('Config', 'Supabase não configurado. Usando config local.'); return false; }
    try {
        addLog('Config', `Restaurando agendamentos do Supabase: ${SUPABASE_BUCKET}/${SUPABASE_CONFIG_PATH}`);
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_CONFIG_PATH);
        if (error) { addLog('Config', `Sem arquivo remoto em "${SUPABASE_CONFIG_PATH}". Usando config local.`, getErrorDetails(error)); return false; }
        const text = await data.text();
        const remoteConfig = normalizeConfig(JSON.parse(text));
        ensureDir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(remoteConfig, null, 2));
        config = remoteConfig;
        const total = config.agendamentos.length;
        const ativos = config.agendamentos.filter(a => a.ativo).length;
        addLog('Config', `Agendamentos restaurados. Total=${total}, ativos=${ativos}.`);
        return true;
    } catch (e) {
        addLog('Erro', 'Erro ao restaurar agendamentos do Supabase', getErrorDetails(e));
        return false;
    }
}

function normalizePredefinidas(data) {
    const arr = Array.isArray(data) ? data : [];
    return arr
        .map(item => ({
            id: item.id || Date.now() + Math.floor(Math.random() * 1000),
            titulo: String(item.titulo || item.nome || '').trim(),
            mensagem: String(item.mensagem || '').trim()
        }))
        .filter(item => item.titulo || item.mensagem);
}

function loadPredefinidasLocal() {
    try {
        if (fs.existsSync(PREDEFINIDAS_FILE)) {
            return normalizePredefinidas(JSON.parse(fs.readFileSync(PREDEFINIDAS_FILE, 'utf8')));
        }
    } catch (e) {
        addLog('Erro', 'Erro ao carregar predefinidas locais', getErrorDetails(e));
    }
    return [];
}

function savePredefinidasLocal(predefinidas) {
    ensureDir(path.dirname(PREDEFINIDAS_FILE));
    fs.writeFileSync(PREDEFINIDAS_FILE, JSON.stringify(normalizePredefinidas(predefinidas), null, 2));
}

async function savePredefinidasToSupabase(predefinidas) {
    requireSupabase();
    const normalized = normalizePredefinidas(predefinidas);
    savePredefinidasLocal(normalized);
    const fileBuffer = Buffer.from(JSON.stringify(normalized, null, 2));
    addLog('Predefinidas', `Enviando predefinidas para Supabase: ${SUPABASE_BUCKET}/${SUPABASE_PREDEFINIDAS_PATH}`);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_PREDEFINIDAS_PATH, fileBuffer, { contentType: 'application/json', upsert: true });
    if (error) throw error;
    addLog('Predefinidas', 'Predefinidas salvas no Supabase.');
    return normalized;
}

async function restorePredefinidasFromSupabase() {
    if (!supabase) return loadPredefinidasLocal();
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_PREDEFINIDAS_PATH);
        if (error) return loadPredefinidasLocal();
        const text = await data.text();
        const predefinidas = normalizePredefinidas(JSON.parse(text));
        savePredefinidasLocal(predefinidas);
        return predefinidas;
    } catch (e) {
        addLog('Erro', 'Erro ao restaurar predefinidas do Supabase', getErrorDetails(e));
        return loadPredefinidasLocal();
    }
}

async function saveSessionToSupabase() {
    requireSupabase();
    ensureDir(AUTH_DIR);
    if (!fs.existsSync(AUTH_DIR)) throw new Error(`Pasta de sessão não encontrada: ${AUTH_DIR}`);
    const tmpFile = path.join('/tmp', `wwebjs_auth_${Date.now()}.zip`);
    addLog('Sessão', `Compactando sessão: ${AUTH_DIR}`);
    const zipBytes = await zipDirectory(AUTH_DIR, tmpFile);
    addLog('Sessão', `ZIP: ${(zipBytes / 1024 / 1024).toFixed(2)} MB`);
    const fileStream = fs.createReadStream(tmpFile);
    addLog('Sessão', `Enviando para Supabase: ${SUPABASE_BUCKET}/${SUPABASE_SESSION_PATH}`);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_SESSION_PATH, fileStream, { contentType: 'application/zip', upsert: true });
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
        try { await clientInstance.destroy(); } catch (e) { addLog('Aviso', 'Erro ao destruir client', getErrorDetails(e)); }
    }
    clientInstance = null;
    botConnected = false;
    qrCodeDataURL = null;
    if (!keepRestarting) restarting = false;
}


// ── MCP SERVER HTTP ────────────────────────────────────────────────────────
// Endpoint remoto simples compatível com chamadas JSON-RPC do MCP.
// Protegido por Authorization: Bearer <MCP_AUTH_TOKEN>.

function mcpAuthMiddleware(req, res, next) {
    if (!MCP_AUTH_TOKEN) {
        return res.status(503).json({
            ok: false,
            error: 'MCP_AUTH_TOKEN não configurado. Defina esta variável no Render antes de expor o MCP.'
        });
    }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

    if (token !== MCP_AUTH_TOKEN) {
        return res.status(401).json({ ok: false, error: 'Token MCP inválido ou ausente.' });
    }

    next();
}

function jsonTextResult(data, isError = false) {
    return {
        content: [
            {
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
            }
        ],
        isError
    };
}

function mcpTool(name, description, inputSchema) {
    return { name, description, inputSchema };
}

function getMcpTools() {
    return [
        mcpTool('listar_status_bot', 'Lista o status atual do bot, conexão, uptime e caminhos configurados.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('listar_grupos', 'Lista grupos disponíveis no WhatsApp com nome e ID real.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('listar_agendamentos', 'Lista todos os agendamentos configurados.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('criar_agendamento', 'Cria um novo agendamento. Preferencialmente use grupoId obtido em listar_grupos.', {
            type: 'object',
            properties: {
                grupo: { type: 'string', description: 'Nome do grupo' },
                grupoId: { type: 'string', description: 'ID real do grupo, exemplo 12036...@g.us' },
                mensagem: { type: 'string' },
                horario: { type: 'string', description: 'Horário de Brasília no formato HH:MM' },
                diasSemana: { type: 'array', items: { type: 'number' }, description: '0=Domingo, 1=Segunda... 6=Sábado' },
                ativo: { type: 'boolean' }
            },
            required: ['mensagem', 'horario'],
            additionalProperties: false
        }),
        mcpTool('editar_agendamento', 'Edita um agendamento existente pelo ID.', {
            type: 'object',
            properties: {
                id: { type: ['string', 'number'] },
                grupo: { type: 'string' },
                grupoId: { type: 'string' },
                mensagem: { type: 'string' },
                horario: { type: 'string' },
                diasSemana: { type: 'array', items: { type: 'number' } },
                ativo: { type: 'boolean' }
            },
            required: ['id'],
            additionalProperties: false
        }),
        mcpTool('excluir_agendamento', 'Exclui um agendamento pelo ID.', {
            type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false
        }),
        mcpTool('ativar_agendamento', 'Ativa um agendamento pelo ID.', {
            type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false
        }),
        mcpTool('pausar_agendamento', 'Pausa um agendamento pelo ID.', {
            type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false
        }),
        mcpTool('listar_predefinidas', 'Lista mensagens predefinidas salvas.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('criar_predefinida', 'Cria uma mensagem predefinida.', {
            type: 'object',
            properties: { titulo: { type: 'string' }, mensagem: { type: 'string' } },
            required: ['mensagem'],
            additionalProperties: false
        }),
        mcpTool('editar_predefinida', 'Edita uma mensagem predefinida pelo ID.', {
            type: 'object',
            properties: { id: { type: ['string', 'number'] }, titulo: { type: 'string' }, mensagem: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }),
        mcpTool('excluir_predefinida', 'Exclui uma mensagem predefinida pelo ID.', {
            type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false
        }),
        mcpTool('enviar_mensagem_teste', 'Envia uma mensagem manual para um grupo.', {
            type: 'object',
            properties: { grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' } },
            required: ['mensagem'],
            additionalProperties: false
        }),
        mcpTool('listar_logs', 'Lista os logs recentes do bot.', {
            type: 'object',
            properties: { limite: { type: 'number', description: 'Quantidade máxima de logs, padrão 50' } },
            additionalProperties: false
        }),
        mcpTool('salvar_sessao', 'Salva a sessão atual do WhatsApp no Supabase.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('restaurar_sessao', 'Inicia a restauração da sessão do WhatsApp a partir do Supabase.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('excluir_sessao', 'Exclui o backup da sessão do WhatsApp no Supabase.', {
            type: 'object', properties: {}, additionalProperties: false
        }),
        mcpTool('atualizar_sessao_e_grupos', 'Reinicia o client do WhatsApp sem apagar a sessão, forçando nova leitura dos grupos.', {
            type: 'object', properties: {}, additionalProperties: false
        })
    ];
}

function mcpStatus() {
    return {
        connected: botConnected,
        state: botState,
        status: botStatus,
        restarting,
        timezone: BRASILIA_TZ,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        supabaseConfigured: Boolean(supabase),
        agendamentos: Array.isArray(config.agendamentos) ? config.agendamentos.length : 0,
        agendamentosAtivos: Array.isArray(config.agendamentos) ? config.agendamentos.filter(a => a.ativo).length : 0
    };
}

async function persistConfigFromMcp(logMessage = 'Config atualizada via MCP.') {
    config = normalizeConfig(config);
    saveConfig(config);
    try {
        await saveConfigToSupabase();
    } catch (e) {
        addLog('Erro', 'Config salva localmente via MCP, falhou no Supabase', getErrorDetails(e));
    }
    if (botConnected) scheduleAll();
    addLog('MCP', logMessage);
}

function resolveGroupNameById(grupoId, fallback = '') {
    if (!grupoId || !clientInstance || !botConnected) return fallback;
    return fallback;
}

async function listGroupsForMcp() {
    if (!clientInstance || !botConnected) return [];
    const chats = await clientInstance.getChats();
    const botIdRaw = clientInstance.info?.wid?._serialized || '';
    const botNumber = String(botIdRaw).replace(/\D/g, '');
    const grupos = [];

    for (const chat of chats) {
        if (!chat.isGroup) continue;
        const groupId = chat.id?._serialized || '';
        const nome = chat.name || '';
        try {
            const fullChat = await clientInstance.getChatById(groupId);
            const participants = Array.isArray(fullChat.participants) ? fullChat.participants : [];
            const botAindaParticipa = Boolean(botNumber) && participants.some(p => {
                const pid = String(p?.id?._serialized || p?.id?.user || p?.id || '').replace(/\D/g, '');
                return pid === botNumber;
            });
            if (!botAindaParticipa || fullChat.isReadOnly === true) continue;
            grupos.push({ nome, id: groupId });
        } catch (_) {}
    }

    return grupos.sort((a, b) => a.nome.localeCompare(b.nome));
}

async function callMcpTool(name, args = {}) {
    switch (name) {
        case 'listar_status_bot':
            return mcpStatus();

        case 'listar_grupos':
            return await listGroupsForMcp();

        case 'listar_agendamentos':
            return normalizeConfig(config).agendamentos;

        case 'criar_agendamento': {
            const grupo = String(args.grupo || '').trim();
            const grupoId = String(args.grupoId || '').trim();
            if (!grupo && !grupoId) throw new Error('Informe grupo ou grupoId.');
            if (!args.mensagem) throw new Error('Mensagem obrigatória.');
            const ag = migrateAgendamento({
                id: Date.now(),
                grupo,
                grupoId,
                mensagem: String(args.mensagem || ''),
                horario: String(args.horario || '08:00'),
                diasSemana: Array.isArray(args.diasSemana) ? args.diasSemana : [1, 2, 3, 4, 5],
                ativo: args.ativo === true
            });
            config = normalizeConfig(config);
            config.agendamentos.push(ag);
            await persistConfigFromMcp(`Agendamento criado via MCP: "${ag.grupo || ag.grupoId}"`);
            return { ok: true, agendamento: ag, config };
        }

        case 'editar_agendamento': {
            const id = args.id;
            if (id === undefined || id === null || id === '') throw new Error('ID obrigatório.');
            config = normalizeConfig(config);
            const idx = config.agendamentos.findIndex(a => String(a.id) === String(id));
            if (idx < 0) throw new Error(`Agendamento ${id} não encontrado.`);
            const atual = config.agendamentos[idx];
            config.agendamentos[idx] = migrateAgendamento({ ...atual, ...args, id: atual.id });
            await persistConfigFromMcp(`Agendamento editado via MCP: ${id}`);
            return { ok: true, agendamento: config.agendamentos[idx], config };
        }

        case 'excluir_agendamento': {
            const id = args.id;
            if (id === undefined || id === null || id === '') throw new Error('ID obrigatório.');
            config = normalizeConfig(config);
            const before = config.agendamentos.length;
            config.agendamentos = config.agendamentos.filter(a => String(a.id) !== String(id));
            if (config.agendamentos.length === before) throw new Error(`Agendamento ${id} não encontrado.`);
            await persistConfigFromMcp(`Agendamento excluído via MCP: ${id}`);
            return { ok: true, id, config };
        }

        case 'ativar_agendamento':
        case 'pausar_agendamento': {
            const id = args.id;
            if (id === undefined || id === null || id === '') throw new Error('ID obrigatório.');
            config = normalizeConfig(config);
            const idx = config.agendamentos.findIndex(a => String(a.id) === String(id));
            if (idx < 0) throw new Error(`Agendamento ${id} não encontrado.`);
            config.agendamentos[idx].ativo = name === 'ativar_agendamento';
            config.agendamentos[idx] = migrateAgendamento(config.agendamentos[idx]);
            await persistConfigFromMcp(`${name === 'ativar_agendamento' ? 'Ativado' : 'Pausado'} via MCP: ${id}`);
            return { ok: true, agendamento: config.agendamentos[idx], config };
        }

        case 'listar_predefinidas':
            return await restorePredefinidasFromSupabase();

        case 'criar_predefinida': {
            const incoming = normalizePredefinidas([{ id: Date.now(), titulo: args.titulo || '', mensagem: args.mensagem || '' }])[0];
            if (!incoming) throw new Error('Título ou mensagem obrigatórios.');
            const current = await restorePredefinidasFromSupabase();
            current.unshift(incoming);
            const saved = await savePredefinidasToSupabase(current);
            addLog('MCP', `Predefinida criada via MCP: "${incoming.titulo || incoming.id}"`);
            return { ok: true, predefinida: incoming, predefinidas: saved };
        }

        case 'editar_predefinida': {
            const id = args.id;
            if (id === undefined || id === null || id === '') throw new Error('ID obrigatório.');
            const current = await restorePredefinidasFromSupabase();
            const idx = current.findIndex(p => String(p.id) === String(id));
            if (idx < 0) throw new Error(`Predefinida ${id} não encontrada.`);
            current[idx] = normalizePredefinidas([{ ...current[idx], ...args, id: current[idx].id }])[0];
            const saved = await savePredefinidasToSupabase(current);
            addLog('MCP', `Predefinida editada via MCP: ${id}`);
            return { ok: true, predefinida: current[idx], predefinidas: saved };
        }

        case 'excluir_predefinida': {
            const id = args.id;
            if (id === undefined || id === null || id === '') throw new Error('ID obrigatório.');
            const current = await restorePredefinidasFromSupabase();
            const saved = await savePredefinidasToSupabase(current.filter(p => String(p.id) !== String(id)));
            addLog('MCP', `Predefinida excluída via MCP: ${id}`);
            return { ok: true, id, predefinidas: saved };
        }

        case 'enviar_mensagem_teste': {
            const grupo = String(args.grupo || args.grupoId || '').trim();
            const grupoId = String(args.grupoId || '').trim();
            if ((!grupo && !grupoId) || !args.mensagem) throw new Error('Grupo/grupoId e mensagem são obrigatórios.');
            return await enviarLembrete(grupo, String(args.mensagem), { source: 'mcp', grupoId });
        }

        case 'listar_logs': {
            const limite = Math.min(Math.max(Number(args.limite || 50), 1), 300);
            return logs.slice(0, limite);
        }

        case 'salvar_sessao':
            await saveSessionToSupabase();
            addLog('MCP', 'Sessão salva via MCP.');
            return { ok: true, msg: 'Sessão salva no Supabase.' };

        case 'restaurar_sessao':
            restarting = true;
            setBotState('restoring', 'Restaurando sessão do Supabase via MCP...');
            addLog('MCP', 'Restauração de sessão iniciada via MCP.');
            setTimeout(async () => {
                try {
                    await restoreSessionFromSupabase();
                    addLog('MCP', 'Sessão restaurada via MCP.');
                } catch (e) {
                    addLog('Erro', 'Erro ao restaurar sessão via MCP', getErrorDetails(e));
                    setBotState('error', 'Erro ao restaurar sessão via MCP');
                    restarting = false;
                }
            }, 300);
            return { ok: true, msg: 'Restauração iniciada. Consulte listar_status_bot/listar_logs.' };

        case 'excluir_sessao':
            await deleteSessionFromSupabase();
            addLog('MCP', 'Sessão excluída via MCP.');
            return { ok: true, msg: 'Sessão excluída do Supabase.' };

        case 'atualizar_sessao_e_grupos':
            addLog('MCP', 'Reinício local solicitado via MCP.');
            setTimeout(async () => {
                try {
                    await stopBot(true);
                    await wait(1500);
                    await iniciarBot();
                    addLog('MCP', 'Sessão local reiniciada via MCP.');
                } catch (e) {
                    addLog('Erro', 'Erro ao reiniciar sessão via MCP', getErrorDetails(e));
                    setBotState('error', 'Erro ao reiniciar via MCP');
                    restarting = false;
                }
            }, 300);
            return { ok: true, msg: 'Reinício iniciado. Consulte listar_status_bot/listar_logs.' };

        default:
            throw new Error(`Ferramenta MCP desconhecida: ${name}`);
    }
}

async function handleMcpRequest(payload) {
    if (!payload || typeof payload !== 'object') {
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Requisição inválida.' } };
    }

    const id = payload.id ?? null;
    const method = payload.method;
    const params = payload.params || {};

    try {
        if (method === 'initialize') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: params.protocolVersion || '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'bot-whatsapp-mcp', version: '1.0.0' }
                }
            };
        }

        if (method === 'notifications/initialized') {
            return null;
        }

        if (method === 'tools/list') {
            return { jsonrpc: '2.0', id, result: { tools: getMcpTools() } };
        }

        if (method === 'tools/call') {
            const toolName = params.name;
            const args = params.arguments || {};
            const data = await callMcpTool(toolName, args);
            return { jsonrpc: '2.0', id, result: jsonTextResult(data, false) };
        }

        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método não suportado: ${method}` } };
    } catch (e) {
        return { jsonrpc: '2.0', id, result: jsonTextResult({ ok: false, error: getErrorDetails(e) }, true) };
    }
}

// ── ROTAS ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'wa-bot', uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(), now: new Date().toISOString(), timezone: BRASILIA_TZ, state: botState, connected: botConnected, mcpConfigured: Boolean(MCP_AUTH_TOKEN), mcpEndpoint: MCP_ENDPOINT });
});

app.get('/health', (req, res) => res.redirect('/api/health'));
app.get('/ping', (req, res) => { res.set('Cache-Control', 'no-store'); res.status(200).send('pong'); });


app.get(MCP_ENDPOINT, mcpAuthMiddleware, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        ok: true,
        name: 'bot-whatsapp-mcp',
        endpoint: MCP_ENDPOINT,
        transport: 'http-jsonrpc',
        auth: 'Bearer token',
        tools: getMcpTools().map(t => t.name)
    });
});

app.post(MCP_ENDPOINT, mcpAuthMiddleware, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const payload = req.body;
        if (Array.isArray(payload)) {
            const responses = (await Promise.all(payload.map(handleMcpRequest))).filter(Boolean);
            return res.json(responses);
        }
        const response = await handleMcpRequest(payload);
        if (!response) return res.status(202).end();
        return res.json(response);
    } catch (e) {
        return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: getErrorDetails(e) } });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ connected: botConnected, state: botState, status: botStatus, restarting, qr: qrCodeDataURL, timezone: 'Horário de Brasília', supabaseConfigured: Boolean(supabase), uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(), supabaseBucket: SUPABASE_BUCKET, supabaseSessionPath: SUPABASE_SESSION_PATH, supabaseConfigPath: SUPABASE_CONFIG_PATH, supabasePredefinidasPath: SUPABASE_PREDEFINIDAS_PATH, mcpConfigured: Boolean(MCP_AUTH_TOKEN), mcpEndpoint: MCP_ENDPOINT });
});

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
    try {
        config = normalizeConfig(req.body);
        saveConfig(config);
        try { await saveConfigToSupabase(); } catch (e) { addLog('Erro', 'Config salva localmente, falhou no Supabase', getErrorDetails(e)); }
        if (botConnected) scheduleAll();
        addLog('Config', 'Configurações salvas.');
        res.json({ ok: true, config });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar configurações', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});


app.post('/api/agendamento', async (req, res) => {
    try {
        const ag = migrateAgendamento(req.body || {});
        if (!ag.id) ag.id = Date.now();
        const atual = normalizeConfig(config);
        const idx = atual.agendamentos.findIndex(item => String(item.id) === String(ag.id));
        if (idx >= 0) atual.agendamentos[idx] = ag;
        else atual.agendamentos.push(ag);
        config = normalizeConfig(atual);
        saveConfig(config);
        try { await saveConfigToSupabase(); } catch (e) { addLog('Erro', 'Agendamento salvo localmente, falhou no Supabase', getErrorDetails(e)); }
        if (botConnected) scheduleAll();
        addLog('Config', `Agendamento salvo individualmente: "${ag.grupo || 'sem grupo'}"`);
        res.json({ ok: true, agendamento: ag, config });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar agendamento individual', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.get('/api/predefinidas', async (req, res) => {
    const predefinidas = await restorePredefinidasFromSupabase();
    res.json(predefinidas);
});

app.post('/api/predefinidas', async (req, res) => {
    try {
        const incoming = normalizePredefinidas([{ ...req.body, id: req.body?.id || Date.now() }])[0];
        if (!incoming) return res.status(400).json({ ok: false, msg: 'Título ou mensagem obrigatórios.' });
        const current = await restorePredefinidasFromSupabase();
        const idx = current.findIndex(item => String(item.id) === String(incoming.id));
        if (idx >= 0) current[idx] = incoming;
        else current.unshift(incoming);
        const saved = await savePredefinidasToSupabase(current);
        res.json({ ok: true, predefinida: incoming, predefinidas: saved });
    } catch (e) {
        addLog('Erro', 'Erro ao salvar predefinida', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.delete('/api/predefinidas/:id', async (req, res) => {
    try {
        const current = await restorePredefinidasFromSupabase();
        const saved = await savePredefinidasToSupabase(current.filter(item => String(item.id) !== String(req.params.id)));
        res.json({ ok: true, predefinidas: saved });
    } catch (e) {
        addLog('Erro', 'Erro ao excluir predefinida', getErrorDetails(e));
        res.status(500).json({ ok: false, msg: getErrorDetails(e) });
    }
});

app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/logs/clear', (req, res) => {
    clearLogs('requisição manual');
    res.json({ ok: true, logs });
});

app.get('/api/memory', (req, res) => {
    res.json({ ok: true, memory: getMemorySnapshot(), limitHintMb: 512, warningAtMb: MEMORY_WARN_MB });
});

app.post('/api/enviar', async (req, res) => {
    const { grupo, grupoId, mensagem } = req.body;
    if ((!grupo && !grupoId) || !mensagem) return res.json({ ok: false, msg: 'Grupo e mensagem obrigatórios.' });
    const result = await enviarLembrete(grupo || grupoId, mensagem, { grupoId });
    res.json(result);
});

app.get('/api/grupos', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    if (!clientInstance || !botConnected) return res.json([]);

    try {
        const chats = await clientInstance.getChats();
        const botIdRaw = clientInstance.info?.wid?._serialized || '';
        const botNumber = String(botIdRaw).replace(/\D/g, '');
        const grupos = [];

        for (const chat of chats) {
            if (!chat.isGroup) continue;
            const groupId = chat.id?._serialized || '';
            const nome = chat.name || '';
            try {
                const fullChat = await clientInstance.getChatById(groupId);
                const participants = Array.isArray(fullChat.participants) ? fullChat.participants : [];

                const botAindaParticipa = Boolean(botNumber) && participants.some(p => {
                    const pid = String(p?.id?._serialized || p?.id?.user || p?.id || '').replace(/\D/g, '');
                    return pid === botNumber;
                });

                if (!botAindaParticipa) {
                    addLog('Grupos', `Ignorado (bot não participa): "${nome}" id="${groupId}"`);
                    continue;
                }
                if (fullChat.isReadOnly === true) {
                    addLog('Grupos', `Ignorado (somente leitura): "${nome}" id="${groupId}"`);
                    continue;
                }
                grupos.push({ nome, id: groupId });
            } catch (e) {
                addLog('Aviso', `Falha ao validar grupo "${nome}" id="${groupId}"`, getErrorDetails(e));
            }
        }

        grupos.sort((a, b) => a.nome.localeCompare(b.nome));
        res.json(grupos);
    } catch (e) {
        addLog('Erro', 'Erro ao listar grupos', getErrorDetails(e));
        res.json([]);
    }
});

app.post('/api/session/save', async (req, res) => {
    try {
        await saveSessionToSupabase();
        addLog('Sessão', `Sessão salva no Supabase.`);
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

app.post('/api/session/restart', async (req, res) => {
    try {
        res.json({ ok: true, msg: 'Reiniciando WhatsApp sem apagar sessão...' });
        addLog('Sessão', 'Reiniciando WhatsApp sem apagar autenticação.');
        setTimeout(async () => {
            try {
                await stopBot(true);
                await wait(1500);
                await iniciarBot();
                addLog('Sessão', 'Sessão local reiniciada. Aguardando conexão.');
            } catch (e) {
                addLog('Erro', 'Erro ao reiniciar sessão', getErrorDetails(e));
                setBotState('error', 'Erro ao reiniciar');
                restarting = false;
            }
        }, 300);
    } catch (e) {
        addLog('Erro', 'Erro ao solicitar reinício', getErrorDetails(e));
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    addLog('Servidor', `Rodando na porta ${PORT}`);
    addLog('Servidor', 'Uptime disponível em /api/health');
    addLog('Servidor', `MCP disponível em ${MCP_ENDPOINT} ${MCP_AUTH_TOKEN ? '(protegido por token)' : '(desativado: configure MCP_AUTH_TOKEN)'}`);
});

// ── WHATSAPP CLIENT ────────────────────────────────────────────────────────

async function iniciarBot() {
    if (clientInstance) return;
    setBotState('connecting', 'Iniciando WhatsApp...');
    ensureDir(AUTH_DIR);
    const execPath = await chromium.executablePath();
    addLog('Info', `Chrome: ${execPath}`);
    addLog('Info', `Sessão: ${AUTH_DIR}`);

    clientInstance = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
        puppeteer: {
            executablePath: execPath,
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
            headless: true
        }
    });

    clientInstance.on('loading_screen', (percent, message) => {
        const p = Number(percent || 0);
        setBotState('connecting', `Carregando WhatsApp ${p}%...`);

        // Evita dezenas de logs durante o carregamento do WhatsApp.
        // Registra apenas marcos relevantes ou no máximo 1 vez por minuto.
        const bucket = p >= 99 ? 99 : p >= 95 ? 95 : Math.floor(p / 25) * 25;
        const now = Date.now();
        if (bucket !== lastLoadingLog.bucket || now - lastLoadingLog.at > 60000) {
            lastLoadingLog = { bucket, at: now };
            addLog('WhatsApp', `Carregando ${p}%`, message || '');
        }
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

    // ACK global apenas para logs — o rastreamento por mensagem é feito em enviarLembrete
    clientInstance.on('message_ack', (msg, ack) => {
        // Silencioso aqui; o listener por mensagem individual cuida do log
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