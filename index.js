'use strict';

const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const pino = require('pino');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// Supabase v2 precisa de WebSocket explícito no Node 20 usado pelo Render.
// Sem isso o processo cai antes de iniciar o servidor.
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || process.env.WPP_TOKEN_DIR || '/tmp/baileys-auth';
const CONFIG_FILE = process.env.BOT_CONFIG_FILE || path.join('/tmp', 'bot_config.json');
const PREDEF_FILE = process.env.BOT_PREDEFINIDAS_FILE || path.join('/tmp', 'predefinidas.json');
const BRASILIA_TZ = 'America/Sao_Paulo';
const STARTED_AT = new Date();
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || '/mcp';
const LOG_MAX = Number(process.env.LOG_MAX_ENTRIES || 180);
const LOG_CLEAR_H = Number(process.env.LOG_AUTO_CLEAR_HOURS || 12);
const MEM_WARN_MB = Number(process.env.MEMORY_WARN_MB || 360);
const MEM_RESTART_MB = Number(process.env.MEMORY_RESTART_MB || 470);
const PAIRING_WAIT_MS = Number(process.env.PAIRING_WAIT_MS || 90000);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 5000);
const SESSION_AUTOSAVE_MS = Number(process.env.SESSION_AUTOSAVE_MS || 60000);
const MARK_ONLINE_ON_CONNECT = String(process.env.MARK_ONLINE_ON_CONNECT || 'false').toLowerCase() === 'true';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: WebSocket } }) : null;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'whatsapp-sessions';
const SUPABASE_SESSION_PATH = process.env.SUPABASE_SESSION_PATH || 'baileys-auth.zip';
const SUPABASE_CONFIG_PATH = process.env.SUPABASE_CONFIG_PATH || 'bot_config.json';
const SUPABASE_PREDEF_PATH = process.env.SUPABASE_PREDEFINIDAS_PATH || 'predefinidas.json';

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const mkdir = p => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const errMsg = e => e ? [e.message, e.status, e.code, e.name].filter(Boolean).join(' | ') || String(e) : 'desconhecido';
const sanitize = t => String(t || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\S\n\t]+$/gm, '').trim();
const reqSup = () => { if (!supabase) throw new Error('Supabase não configurado'); };
const jidClean = jid => String(jid || '').trim();
const toGroupJid = id => {
    const v = jidClean(id);
    if (!v) return '';
    if (v.includes('@')) return v;
    return `${v}@g.us`;
};
const toUserJid = id => {
    const v = String(id || '').replace(/\D/g, '');
    if (!v) return '';
    return `${v}@s.whatsapp.net`;
};

let baileys = null;
let DisconnectReason = {};
let makeWASocket = null;
let useMultiFileAuthState = null;
let fetchLatestBaileysVersion = null;

async function loadBaileys() {
    if (baileys) return baileys;
    try {
        baileys = await import('baileys');
    } catch (e) {
        try { baileys = await import('@whiskeysockets/baileys'); }
        catch { throw e; }
    }
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    DisconnectReason = baileys.DisconnectReason || {};
    if (!makeWASocket || !useMultiFileAuthState) throw new Error('Baileys não carregou makeWASocket/useMultiFileAuthState');
    return baileys;
}

const brasil = () => {
    const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: BRASILIA_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'long' });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { data: `${p.day}/${p.month}/${p.year}`, hora: `${p.hour}:${p.minute}`, diaSemana: p.weekday || '', saudacao: Number(p.hour) < 12 ? 'Bom dia' : Number(p.hour) < 18 ? 'Boa tarde' : 'Boa noite' };
};

let config = { agendamentos: [] };
let qrDataURL = null;
let qrString = null;
let botStatus = 'Inicializando...';
let botState = 'starting';
let botConnected = false;
let client = null;
let scheduledJobs = {};
let logs = [];
let restarting = false;
let memWarn = false;
let reconnectTimer = null;
let shuttingDown = false;
let startPromise = null;
let pairingPhone = '';
let pairingRequestedFor = '';
let lastPairingCode = '';
let pairingWaiters = [];
let authSaveTimer = null;
let groupsCache = { list: null, at: 0, building: false };
let lastCredsUpdateAt = 0;
const CACHE_TTL = 2 * 60 * 1000;

const getClient = () => (client && botConnected ? client : null);
const invalCache = () => { groupsCache = { list: null, at: 0, building: false }; };
const setState = (s, msg) => { botState = s; botStatus = msg; };

const log = (type, msg, extra = null) => {
    const full = extra ? `${msg} — ${extra}` : msg;
    logs.unshift({ type, msg: full, time: new Date().toLocaleTimeString('pt-BR', { timeZone: BRASILIA_TZ }) });
    if (logs.length > LOG_MAX) logs.length = LOG_MAX;
    console.log(`[${type}] ${full}`);
};

const logMem = force => {
    const m = process.memoryUsage();
    const r = Math.round(m.rss / 1024 / 1024), h = Math.round(m.heapUsed / 1024 / 1024), t = Math.round(m.heapTotal / 1024 / 1024), e = Math.round(m.external / 1024 / 1024);
    const s = `rss=${r}MB heap=${h}/${t}MB ext=${e}MB`;
    if (force) { log('Sistema', `Memória: ${s}`); return; }
    if (r >= MEM_WARN_MB && !memWarn) { memWarn = true; log('Aviso', `Memória alta: ${s}.`); }
    if (r < MEM_WARN_MB - 60) memWarn = false;
    if (r >= MEM_RESTART_MB) {
        log('Aviso', `Memória crítica (${r}MB). Reiniciando socket...`);
        reiniciarBot(true);
    }
};

process.on('uncaughtException', e => { log('Erro', 'Exceção', errMsg(e)); console.error(e); });
process.on('unhandledRejection', e => { log('Erro', 'Rejeição', errMsg(e)); console.error(e); });

log('Sistema', `PID=${process.pid} Logs=${LOG_MAX} Limpeza=${LOG_CLEAR_H}h Motor=Baileys`);
logMem(true);
if (LOG_CLEAR_H > 0) setInterval(() => { logs = []; logMem(true); }, LOG_CLEAR_H * 3600000).unref();
setInterval(() => logMem(false), 300000).unref();

const defaultConfig = () => ({ agendamentos: [] });
const parseDays = expr => {
    if (!expr || expr === '*') return [0, 1, 2, 3, 4, 5, 6];
    const s = new Set();
    String(expr).split(',').forEach(p => {
        if (p.includes('-')) { const [a, b] = p.split('-').map(Number); if (Number.isInteger(a) && Number.isInteger(b)) for (let d = a; d <= b; d++) s.add(d); }
        else { const d = Number(p); if (Number.isInteger(d)) s.add(d); }
    });
    return [...s].filter(d => d >= 0 && d <= 6).sort();
};
const buildCron = (horario, dias) => {
    const [hr = '12', mn = '00'] = String(horario || '12:00').split(':');
    const h = Math.min(Math.max(parseInt(hr, 10) || 0, 0), 23);
    const m = Math.min(Math.max(parseInt(mn, 10) || 0, 0), 59);
    const ds = Array.isArray(dias) && dias.length ? [...new Set(dias.map(Number).filter(d => d >= 0 && d <= 6))].sort().join(',') : '*';
    return `${m} ${h} * * ${ds}`;
};
const normAg = ag => {
    const d = ag.diasSemana, h = ag.horario || '12:00';
    const dias = Array.isArray(d) ? d.map(Number).filter(x => x >= 0 && x <= 6).sort() : parseDays('');
    return { ...ag, grupo: ag.grupo || '', grupoId: ag.grupoId || '', diasSemana: dias, horario: h, cron: ag.cron || buildCron(h, dias) };
};
const normCfg = cfg => {
    const base = cfg && typeof cfg === 'object' ? cfg : defaultConfig();
    return { ...base, agendamentos: (Array.isArray(base.agendamentos) ? base.agendamentos : []).map(normAg) };
};
const loadCfg = () => {
    try { if (fs.existsSync(CONFIG_FILE)) return normCfg(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
    catch (e) { log('Config', `Erro: ${e.message}`); }
    return defaultConfig();
};
const saveCfg = c => { mkdir(path.dirname(CONFIG_FILE)); fs.writeFileSync(CONFIG_FILE, JSON.stringify(normCfg(c), null, 2)); };
const applyVars = (msg, grupo = '') => {
    const p = brasil();
    const v = { grupo, data: p.data, hora: p.hora, diaSemana: p.diaSemana, saudacao: p.saudacao };
    return String(msg || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, k) => Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : `{{${k}}`);
};

const saveCfgRemote = async () => {
    reqSup(); saveCfg(config);
    const buf = fs.readFileSync(CONFIG_FILE);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_CONFIG_PATH, buf, { contentType: 'application/json', upsert: true });
    if (error) throw error;
};
const loadCfgRemote = async () => {
    if (!supabase) return false;
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_CONFIG_PATH);
        if (error) return false;
        const r = normCfg(JSON.parse(await data.text()));
        mkdir(path.dirname(CONFIG_FILE));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(r, null, 2));
        config = r;
        log('Config', `Restaurados: ${r.agendamentos.length} agendamentos`);
        return true;
    } catch (e) { log('Erro', 'Falha config', errMsg(e)); return false; }
};

const normPredef = data => {
    const arr = Array.isArray(data) ? data : [];
    return arr.map(x => ({ id: x.id || Date.now() + Math.floor(Math.random() * 1000), titulo: String(x.titulo || x.nome || '').trim(), mensagem: String(x.mensagem || '').trim() })).filter(x => x.titulo || x.mensagem);
};
const loadPredefLocal = () => { try { if (fs.existsSync(PREDEF_FILE)) return normPredef(JSON.parse(fs.readFileSync(PREDEF_FILE, 'utf8'))); } catch (e) { log('Erro', 'Predef local', errMsg(e)); } return []; };
const savePredefLocal = d => { mkdir(path.dirname(PREDEF_FILE)); fs.writeFileSync(PREDEF_FILE, JSON.stringify(normPredef(d), null, 2)); };
const savePredefRemote = async data => {
    const d = normPredef(data); savePredefLocal(d);
    if (!supabase) return;
    const buf = Buffer.from(JSON.stringify(d, null, 2));
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_PREDEF_PATH, buf, { contentType: 'application/json', upsert: true });
    if (error) throw error;
};
const loadPredefRemote = async () => {
    if (!supabase) return loadPredefLocal();
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_PREDEF_PATH);
        if (error) return loadPredefLocal();
        const d = normPredef(JSON.parse(await data.text()));
        savePredefLocal(d);
        return d;
    } catch { return loadPredefLocal(); }
};

async function zipDir(src, out) {
    mkdir(path.dirname(out));
    return new Promise((res, rej) => {
        const output = fs.createWriteStream(out);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', res);
        archive.on('error', rej);
        archive.pipe(output);
        archive.directory(src, false);
        archive.finalize();
    });
}
const saveSessionRemote = async () => {
    reqSup();
    if (!fs.existsSync(AUTH_DIR)) throw new Error('Sessão local não existe');
    const tmp = `/tmp/baileys_auth_${Date.now()}.zip`;
    await zipDir(AUTH_DIR, tmp);
    const buf = fs.readFileSync(tmp);
    await fs.promises.rm(tmp, { force: true });
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_SESSION_PATH, buf, { contentType: 'application/zip', upsert: true });
    if (error) throw error;
};
const delSessionRemote = async () => {
    reqSup();
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([SUPABASE_SESSION_PATH]);
    if (error) throw error;
};
const rmrf = async p => { if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true }); mkdir(p); };
const restoreSessionRemote = async () => {
    reqSup();
    restarting = true;
    setState('restoring', 'Restaurando sessão...');
    const tmp = `/tmp/baileys_res_${Date.now()}.zip`;
    log('Sessão', 'Baixando do Supabase...');
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_SESSION_PATH);
    if (error) throw error;
    await fs.promises.writeFile(tmp, Buffer.from(await data.arrayBuffer()));
    await pararBot(true);
    await rmrf(AUTH_DIR);
    await new Promise((res, rej) => { fs.createReadStream(tmp).pipe(unzipper.Extract({ path: AUTH_DIR })).on('close', res).on('error', rej); });
    await fs.promises.rm(tmp, { force: true });
    await loadCfgRemote();
    config = loadCfg();
    await iniciarBot();
};
const scheduleSessionAutosave = () => {
    if (!supabase || SESSION_AUTOSAVE_MS <= 0) return;
    if (authSaveTimer) return;
    authSaveTimer = setTimeout(async () => {
        authSaveTimer = null;
        try { await saveSessionRemote(); log('Sessão', 'Backup automático salvo.'); }
        catch (e) { log('Aviso', 'Backup automático falhou', errMsg(e)); }
    }, SESSION_AUTOSAVE_MS);
    authSaveTimer.unref?.();
};

async function pararBot(keep = false) {
    restarting = true;
    setState('restarting', 'Parando...');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};
    invalCache();
    const old = client;
    client = null;
    botConnected = false;
    if (old) {
        try { old.ev?.removeAllListeners?.(); } catch {}
        try { old.ws?.close?.(); } catch {}
        try { old.end?.(); } catch {}
    }
    await wait(500);
    if (!keep) { restarting = false; qrDataURL = null; qrString = null; lastPairingCode = ''; }
}

async function reiniciarBot(keep = false) {
    if (startPromise) { log('Bot', 'Inicialização já em andamento.'); return; }
    log('Bot', 'Reiniciando...');
    await pararBot(true);
    await wait(1000);
    await iniciarBot();
}

function resolvePairingWaiters(code) {
    lastPairingCode = code || '';
    const waiters = pairingWaiters.splice(0);
    waiters.forEach(w => w.resolve(lastPairingCode));
}
function waitPairingCode(timeoutMs = PAIRING_WAIT_MS) {
    if (lastPairingCode) return Promise.resolve(lastPairingCode);
    return new Promise(resolve => {
        const item = { resolve: code => { clearTimeout(item.to); resolve(code || null); }, to: null };
        item.to = setTimeout(() => {
            pairingWaiters = pairingWaiters.filter(w => w !== item);
            resolve(null);
        }, timeoutMs);
        pairingWaiters.push(item);
    });
}
async function requestPairingCodeIfNeeded() {
    if (!client || !pairingPhone || pairingRequestedFor === pairingPhone || botConnected) return;
    pairingRequestedFor = pairingPhone;
    try {
        setState('pairing', 'Gerando código de emparelhamento...');
        const code = await client.requestPairingCode(pairingPhone);
        const clean = String(code || '').replace(/\s+/g, '').trim();
        if (!clean) throw new Error('Código vazio retornado pelo WhatsApp');
        setState('pairing_code', 'Código de emparelhamento gerado.');
        log('Pairing', `Código gerado: ${clean}`);
        resolvePairingWaiters(clean);
    } catch (e) {
        pairingRequestedFor = '';
        log('Erro', 'Falha código de pareamento', errMsg(e));
        resolvePairingWaiters(null);
    }
}
async function gerarPairingCode(phone) {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) throw new Error('Número inválido. Use país + DDD + número, sem +.');
    pairingPhone = cleanPhone;
    pairingRequestedFor = '';
    lastPairingCode = '';
    qrDataURL = null;
    qrString = null;
    if (!client || botConnected) {
        await pararBot(true);
        await iniciarBot();
    } else {
        requestPairingCodeIfNeeded();
    }
    return await waitPairingCode(PAIRING_WAIT_MS);
}

async function iniciarBot() {
    if (client || startPromise || shuttingDown) return startPromise;
    startPromise = (async () => {
        restarting = false;
        setState(pairingPhone ? 'pairing' : 'launching', pairingPhone ? 'Preparando pareamento...' : 'Iniciando WhatsApp...');
        mkdir(AUTH_DIR);
        await loadBaileys();
        log('Info', `Auth Baileys: ${AUTH_DIR}`);
        if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) log('Info', 'Sessão existente detectada.');
        try {
            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            let version;
            try { version = fetchLatestBaileysVersion ? (await fetchLatestBaileysVersion()).version : undefined; }
            catch (e) { log('Aviso', 'Não foi possível buscar versão WA Web', errMsg(e)); }

            const sock = makeWASocket({
                version,
                auth: state,
                logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' }),
                printQRInTerminal: false,
                browser: ['WA Bot Render', 'Chrome', '1.0.0'],
                markOnlineOnConnect: MARK_ONLINE_ON_CONNECT,
                syncFullHistory: false,
                generateHighQualityLinkPreview: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 25000,
                getMessage: async () => ({ conversation: '' }),
            });
            client = sock;

            sock.ev.on('creds.update', async () => {
                lastCredsUpdateAt = Date.now();
                try { await saveCreds(); scheduleSessionAutosave(); }
                catch (e) { log('Erro', 'Falha ao salvar credenciais', errMsg(e)); }
            });

            sock.ev.on('connection.update', async update => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;
                if (qr) {
                    qrString = qr;
                    qrDataURL = await qrcode.toDataURL(qr);
                    botConnected = false;
                    restarting = false;
                    setState(pairingPhone ? 'pairing' : 'qr', pairingPhone ? 'Aguardando código de emparelhamento...' : 'Aguardando QR Code');
                    log('QR', 'Novo QR Code disponível no painel.');
                    if (pairingPhone) setTimeout(() => requestPairingCodeIfNeeded(), 700).unref?.();
                }
                if (connection === 'connecting') {
                    botConnected = false;
                    setState(pairingPhone ? 'pairing' : 'connecting', pairingPhone ? 'Conectando para gerar código...' : 'Conectando...');
                    if (pairingPhone) setTimeout(() => requestPairingCodeIfNeeded(), 1200).unref?.();
                }
                if (connection === 'open') {
                    botConnected = true;
                    restarting = false;
                    qrDataURL = null;
                    qrString = null;
                    pairingPhone = '';
                    pairingRequestedFor = '';
                    lastPairingCode = '';
                    setState('ready', 'Conectado');
                    log('Sessão', isNewLogin ? 'Conectado com novo login.' : 'Conectado.');
                    invalCache();
                    scheduleAll();
                    scheduleSessionAutosave();
                    listGroups().catch(e => log('Aviso', 'Não foi possível carregar grupos', errMsg(e)));
                }
                if (connection === 'close') {
                    botConnected = false;
                    const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
                    const loggedOut = code === DisconnectReason.loggedOut || code === 401;
                    const restartRequired = code === DisconnectReason.restartRequired;
                    const reason = code ? `código ${code}` : errMsg(lastDisconnect?.error);
                    log(loggedOut ? 'Sessão' : 'Bot', `Conexão fechada (${reason})`);
                    client = null;
                    invalCache();
                    if (loggedOut) {
                        setState('logged_out', 'Sessão desconectada. Escaneie novamente.');
                        try { await rmrf(AUTH_DIR); } catch {}
                        qrDataURL = null;
                        qrString = null;
                        pairingPhone = '';
                        pairingRequestedFor = '';
                    }
                    if (!shuttingDown && !restarting) {
                        const delay = restartRequired ? 700 : RECONNECT_DELAY_MS;
                        setState(loggedOut ? 'qr' : 'reconnecting', loggedOut ? 'Aguardando novo QR...' : `Reconectando em ${Math.round(delay / 1000)}s...`);
                        if (reconnectTimer) clearTimeout(reconnectTimer);
                        reconnectTimer = setTimeout(() => { reconnectTimer = null; iniciarBot(); }, delay);
                        reconnectTimer.unref?.();
                    }
                }
            });

            sock.ev.on('messages.upsert', async ev => {
                for (const msg of ev.messages || []) await handleIncomingMessage(msg).catch(e => log('Erro', 'Mensagem recebida', errMsg(e)));
            });

            sock.ev.on('groups.update', () => invalCache());
            sock.ev.on('group-participants.update', () => invalCache());
            log('Bot', 'Socket Baileys iniciado.');
        } catch (e) {
            client = null;
            botConnected = false;
            setState('error', 'Falha ao iniciar bot');
            log('Erro', 'Falha iniciar bot', errMsg(e));
            if (!shuttingDown) {
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => { reconnectTimer = null; iniciarBot(); }, RECONNECT_DELAY_MS);
                reconnectTimer.unref?.();
            }
        } finally {
            startPromise = null;
        }
    })();
    return startPromise;
}

async function sendText(jid, text) {
    if (!client) throw new Error('Socket não iniciado');
    return await client.sendMessage(jid, { text });
}
function unwrapText(msg) {
    const m = msg.message || {};
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
}
async function handleIncomingMessage(msg) {
    if (!msg || msg.key?.fromMe) return;
    const fromJid = msg.key?.remoteJid || '';
    const isGroup = fromJid.endsWith('@g.us');
    const text = sanitize(unwrapText(msg));
    if (!text) return;
    const lower = text.toLowerCase();
    if (lower === '!ping') return sendText(fromJid, '🏓 Pong!');
    if (lower.startsWith('!echo ')) return sendText(fromJid, text.slice(6));
    if (lower === '!status' || lower === '!bot') {
        const st = mcpStatus();
        return sendText(fromJid, `🤖 Bot WhatsApp\nStatus: ${st.connected ? '✅ Conectado' : '❌ Desconectado'}\nMotor: Baileys\nAgendamentos: ${st.agendamentosAtivos}/${st.agendamentos} ativos\nUptime: ${Math.floor(st.uptimeSeconds / 60)}min`);
    }
    if (!isGroup && (lower === 'menu' || lower === '!menu' || lower === 'help' || lower === '!help')) {
        return sendText(fromJid, `🤖 *Comandos disponíveis*\n\n!ping — Testar resposta\n!echo <texto> — Repetir mensagem\n!status — Status do bot\n!menu — Esta mensagem`);
    }
}

async function listGroups() {
    if (groupsCache.list && Date.now() - groupsCache.at < CACHE_TTL) return groupsCache.list;
    if (groupsCache.building) {
        const dead = Date.now() + 8000;
        while (groupsCache.building && Date.now() < dead) await wait(200);
        if (groupsCache.list) return groupsCache.list;
        return [];
    }
    groupsCache.building = true;
    try {
        if (!getClient() || typeof client.groupFetchAllParticipating !== 'function') { groupsCache.building = false; return []; }
        const data = await client.groupFetchAllParticipating();
        const gs = Object.values(data || {}).map(g => ({ nome: g.subject || g.name || 'Sem nome', id: g.id })).filter(g => g.id).sort((a, b) => a.nome.localeCompare(b.nome));
        groupsCache = { list: gs, at: Date.now(), building: false };
        if (!gs.length) log('Aviso', 'Nenhum grupo encontrado.');
        return gs;
    } catch (e) { groupsCache.building = false; throw e; }
}
async function enviarMsg(grupo, mensagem, meta = {}) {
    if (!client || !botConnected) {
        log('Erro', `Bot não conectado (${botStatus})`);
        return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
    }
    try {
        const msg = sanitize(applyVars(mensagem, grupo));
        if (!msg) return { ok: false, msg: 'Mensagem vazia' };
        let destId = jidClean(meta.grupoId || grupo);
        let destNome = grupo || destId;
        if (destId && !destId.includes('@') && /^\d+$/.test(destId)) destId = toGroupJid(destId);
        if (!destId || !destId.endsWith('@g.us')) {
            const groups = await listGroups();
            const match = groups.find(g => g.nome === grupo || g.id === grupo || g.id === meta.grupoId);
            if (!match) return { ok: false, msg: `Grupo "${grupo}" não encontrado` };
            destId = match.id;
            destNome = match.nome;
        } else if (destId.endsWith('@g.us')) {
            const cached = groupsCache.list?.find(g => g.id === destId);
            if (cached) destNome = cached.nome;
        }
        log('WhatsApp', `Enviando para "${destNome}" (${destId})`);
        const sent = await client.sendMessage(destId, { text: msg });
        log('Sucesso', `Enviado "${destNome}"`);
        return { ok: true, id: sent?.key?.id || '', grupo: destNome, grupoId: destId };
    } catch (e) { return { ok: false, msg: errMsg(e) }; }
}
function scheduleAll() {
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};
    config = normCfg(config);
    const ativos = config.agendamentos.filter(a => a.ativo && a.grupo && a.mensagem && a.cron);
    log('Cron', `Reagendando ${ativos.length}/${config.agendamentos.length}`);
    config.agendamentos.forEach(a => {
        if (!a.ativo || !a.grupo || !a.mensagem || !a.cron) return;
        try {
            scheduledJobs[a.id] = cron.schedule(a.cron, async () => {
                if (!a.ativo) return;
                log('Cron', `Disparo: "${a.grupo}"`);
                const r = await enviarMsg(a.grupo, a.mensagem, { origem: 'cron', grupoId: a.grupoId });
                log(r.ok ? 'Cron' : 'Erro', `Disparo ${a.grupo}: ${r.ok ? 'OK' : r.msg}`);
            }, { timezone: BRASILIA_TZ });
        } catch (e) { log('Erro', `Cron inválido ${a.id}`, errMsg(e)); }
    });
}

const mcpAuth = (req, res, next) => {
    if (!MCP_AUTH_TOKEN) return res.status(503).json({ ok: false, error: 'MCP_AUTH_TOKEN não configurado.' });
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (t !== MCP_AUTH_TOKEN) return res.status(401).json({ ok: false, error: 'Token inválido.' });
    next();
};
const mcpR = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError });
const mcpStatus = () => ({
    connected: botConnected, state: botState, status: botStatus, restarting, engine: 'baileys', timezone: BRASILIA_TZ,
    uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(),
    supabaseConfigured: Boolean(supabase), gruposCacheValido: Boolean(groupsCache.list), gruposCacheTotal: groupsCache.list?.length || 0,
    agendamentos: config.agendamentos.length, agendamentosAtivos: config.agendamentos.filter(a => a.ativo).length,
    authDir: AUTH_DIR, lastCredsUpdateAt
});
const mcpTools = () => [
    { name: 'listar_status_bot', description: 'Mostra status do bot WhatsApp', inputSchema: { type: 'object', properties: {} } },
    { name: 'listar_grupos', description: 'Lista grupos do WhatsApp', inputSchema: { type: 'object', properties: {} } },
    { name: 'listar_agendamentos', description: 'Lista agendamentos', inputSchema: { type: 'object', properties: {} } },
    { name: 'criar_agendamento', description: 'Cria agendamento', inputSchema: { type: 'object', properties: { grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' }, horario: { type: 'string' }, diasSemana: { type: 'array', items: { type: 'number' } }, ativo: { type: 'boolean' } }, required: ['grupo', 'mensagem'] } },
    { name: 'editar_agendamento', description: 'Edita agendamento pelo ID', inputSchema: { type: 'object', properties: { id: {}, grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' }, horario: { type: 'string' }, diasSemana: { type: 'array', items: { type: 'number' } }, ativo: { type: 'boolean' } }, required: ['id'] } },
    { name: 'excluir_agendamento', description: 'Exclui agendamento', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'ativar_agendamento', description: 'Ativa agendamento', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'pausar_agendamento', description: 'Pausa agendamento', inputSchema: { type: 'object', properties: { id: {} }, required: ['id'] } },
    { name: 'enviar_mensagem_teste', description: 'Envia mensagem para grupo', inputSchema: { type: 'object', properties: { grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' } }, required: ['mensagem'] } },
    { name: 'listar_logs', description: 'Lista logs', inputSchema: { type: 'object', properties: { limite: { type: 'number' } } } },
    { name: 'salvar_sessao', description: 'Salva sessão no Supabase', inputSchema: { type: 'object', properties: {} } },
    { name: 'restaurar_sessao', description: 'Restaura sessão do Supabase', inputSchema: { type: 'object', properties: {} } },
    { name: 'excluir_sessao', description: 'Exclui sessão', inputSchema: { type: 'object', properties: {} } },
];
const persistCfg = async () => {
    config = normCfg(config); saveCfg(config);
    try { await saveCfgRemote(); } catch (e) { log('Erro', 'Supabase config', errMsg(e)); }
    if (botConnected) scheduleAll();
};
async function callMcp(name, args = {}) {
    const a = args || {};
    switch (name) {
        case 'listar_status_bot': return mcpStatus();
        case 'listar_grupos': return await listGroups();
        case 'listar_agendamentos': return normCfg(config).agendamentos;
        case 'criar_agendamento': {
            const ag = normAg({ id: Date.now(), grupo: String(a.grupo || '').trim(), grupoId: String(a.grupoId || '').trim(), mensagem: String(a.mensagem || ''), horario: String(a.horario || '08:00'), diasSemana: Array.isArray(a.diasSemana) ? a.diasSemana : [1, 2, 3, 4, 5], ativo: a.ativo === true });
            config = normCfg(config); config.agendamentos.push(ag); await persistCfg(); return { ok: true, agendamento: ag };
        }
        case 'editar_agendamento': {
            const idx = config.agendamentos.findIndex(x => String(x.id) === String(a.id)); if (idx < 0) throw new Error(`Agendamento ${a.id} não encontrado`);
            config.agendamentos[idx] = normAg({ ...config.agendamentos[idx], ...a, id: config.agendamentos[idx].id }); await persistCfg(); return { ok: true, agendamento: config.agendamentos[idx] };
        }
        case 'excluir_agendamento': config.agendamentos = config.agendamentos.filter(x => String(x.id) !== String(a.id)); await persistCfg(); return { ok: true };
        case 'ativar_agendamento':
        case 'pausar_agendamento': {
            const idx = config.agendamentos.findIndex(x => String(x.id) === String(a.id)); if (idx < 0) throw new Error(`Agendamento ${a.id} não encontrado`);
            config.agendamentos[idx].ativo = name === 'ativar_agendamento'; config.agendamentos[idx] = normAg(config.agendamentos[idx]); await persistCfg(); return { ok: true, agendamento: config.agendamentos[idx] };
        }
        case 'enviar_mensagem_teste': return await enviarMsg(String(a.grupo || a.grupoId || '').trim(), String(a.mensagem || ''), { origem: 'mcp', grupoId: String(a.grupoId || '').trim() });
        case 'listar_logs': return logs.slice(0, Math.min(Math.max(Number(a.limite || 50), 1), 300));
        case 'salvar_sessao': await saveSessionRemote(); return { ok: true };
        case 'restaurar_sessao': setTimeout(() => restoreSessionRemote().catch(e => log('Erro', 'Restore', errMsg(e))), 300); return { ok: true, msg: 'Restauração iniciada' };
        case 'excluir_sessao': await delSessionRemote(); await rmrf(AUTH_DIR); setTimeout(() => reiniciarBot(true).catch(e => log('Erro', 'Reinício', errMsg(e))), 300); return { ok: true, msg: 'Sessão limpa' };
        default: throw new Error(`Ferramenta desconhecida: ${name}`);
    }
}
const handleMcp = async payload => {
    if (!payload || typeof payload !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Inválido' } };
    const id = payload.id ?? null;
    try {
        if (payload.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: payload.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bot-whatsapp-mcp-baileys', version: '4.0' } } };
        if (payload.method === 'notifications/initialized') return null;
        if (payload.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: mcpTools() } };
        if (payload.method === 'tools/call') { const r = await callMcp(payload.params.name, payload.params.arguments); return { jsonrpc: '2.0', id, result: mcpR(r) }; }
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método não suportado: ${payload.method}` } };
    } catch (e) { return { jsonrpc: '2.0', id, result: mcpR({ ok: false, error: errMsg(e) }, true) }; }
};

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'wa-bot-baileys', uptime: Math.floor(process.uptime()), state: botState, connected: botConnected, engine: 'baileys', mcpConfigured: Boolean(MCP_AUTH_TOKEN) }));
app.get('/health', (req, res) => res.redirect('/api/health'));
app.get('/ping', (req, res) => res.send('pong'));
app.get(MCP_ENDPOINT, mcpAuth, (req, res) => res.json({ ok: true, name: 'bot-whatsapp-mcp-baileys', tools: mcpTools().map(t => t.name) }));
app.post(MCP_ENDPOINT, mcpAuth, async (req, res) => {
    try {
        if (Array.isArray(req.body)) return res.json((await Promise.all(req.body.map(handleMcp))).filter(Boolean));
        const r = await handleMcp(req.body); if (!r) return res.status(202).end(); res.json(r);
    } catch (e) { res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: errMsg(e) } }); }
});
app.get('/api/status', (req, res) => res.json({
    connected: botConnected, state: botState, status: botStatus, restarting, engine: 'baileys',
    qr: qrDataURL, qrRaw: qrString, pairingCode: lastPairingCode,
    supabaseConfigured: Boolean(supabase), supabaseBucket: SUPABASE_BUCKET, supabaseSessionPath: SUPABASE_SESSION_PATH,
    uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(),
    gruposCacheValido: Boolean(groupsCache.list), gruposCacheTotal: groupsCache.list?.length || 0,
}));
app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', async (req, res) => {
    try { config = normCfg(req.body); saveCfg(config); try { await saveCfgRemote(); } catch (e) { log('Erro', 'Supabase', errMsg(e)); } if (botConnected) scheduleAll(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/agendamento', async (req, res) => {
    try {
        const ag = normAg(req.body || {}); if (!ag.id) ag.id = Date.now(); config = normCfg(config);
        const idx = config.agendamentos.findIndex(x => String(x.id) === String(ag.id)); if (idx >= 0) config.agendamentos[idx] = ag; else config.agendamentos.push(ag);
        saveCfg(config); try { await saveCfgRemote(); } catch (e) { log('Erro', 'Supabase', errMsg(e)); } if (botConnected) scheduleAll(); res.json({ ok: true, agendamento: ag });
    } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/pairing-code', async (req, res) => {
    try {
        const phone = String(req.body?.phone || '').replace(/\D/g, '');
        if (!phone || phone.length < 10 || phone.length > 15) return res.status(400).json({ ok: false, msg: 'Número inválido. Use código do país + DDD + número (5511999999999).' });
        if (botConnected) return res.status(400).json({ ok: false, msg: 'Bot já conectado. Não é necessário emparelhar.' });
        const code = await gerarPairingCode(phone);
        if (code) res.json({ ok: true, code });
        else res.status(504).json({ ok: false, msg: 'Não foi possível gerar o código dentro do tempo limite. Use o QR Code ou tente novamente.' });
    } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.get('/api/predefinidas', async (req, res) => { const d = await loadPredefRemote(); res.json(d); });
app.post('/api/predefinidas', async (req, res) => {
    try {
        const item = normPredef([{ ...req.body, id: req.body?.id || Date.now() }])[0]; if (!item) return res.status(400).json({ ok: false, msg: 'Título ou mensagem obrigatórios' });
        const cur = await loadPredefRemote(); const idx = cur.findIndex(x => String(x.id) === String(item.id)); if (idx >= 0) cur[idx] = item; else cur.unshift(item); await savePredefRemote(cur); res.json({ ok: true, predefinida: item });
    } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.delete('/api/predefinidas/:id', async (req, res) => {
    try { const cur = await loadPredefRemote(); await savePredefRemote(cur.filter(x => String(x.id) !== String(req.params.id))); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.get('/api/logs', (req, res) => res.json(logs));
app.post('/api/logs/clear', (req, res) => { logs = []; res.json({ ok: true }); });
app.get('/api/memory', (req, res) => { const m = process.memoryUsage(); res.json({ rssMb: Math.round(m.rss / 1024 / 1024), heapUsedMb: Math.round(m.heapUsed / 1024 / 1024), limitHintMb: 512, engine: 'baileys' }); });
app.post('/api/enviar', async (req, res) => {
    const { grupo, grupoId, mensagem } = req.body || {};
    if ((!grupo && !grupoId) || !mensagem) return res.json({ ok: false, msg: 'Grupo e mensagem obrigatórios' });
    res.json(await enviarMsg(grupo || grupoId, mensagem, { grupoId }));
});
app.get('/api/grupos', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!client || !botConnected) return res.json([]);
    try { res.json(await listGroups()); } catch (e) { log('Erro', 'Listar grupos', errMsg(e)); res.json([]); }
});
app.post('/api/session/save', async (req, res) => { try { await saveSessionRemote(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); } });
app.post('/api/session/delete', async (req, res) => {
    try { if (supabase) await delSessionRemote().catch(() => {}); await rmrf(AUTH_DIR); res.json({ ok: true, msg: 'Sessão limpa' }); setTimeout(() => reiniciarBot(true).catch(() => {}), 300); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/session/restart', async (req, res) => { try { res.json({ ok: true, msg: 'Reiniciando...' }); setTimeout(() => reiniciarBot(true).catch(() => {}), 300); } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); } });
app.post('/api/session/restore', async (req, res) => {
    try { res.json({ ok: true, msg: 'Restaurando...' }); setTimeout(() => restoreSessionRemote().catch(e => { log('Erro', 'Restore', errMsg(e)); setState('error', 'Erro restore'); restarting = false; }), 500); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    log('Servidor', `Porta ${PORT}`);
    log('Servidor', `MCP: ${MCP_ENDPOINT} ${MCP_AUTH_TOKEN ? '(token)' : '(desativado)'}`);
});
process.on('SIGTERM', async () => { log('Sistema', 'SIGTERM recebido, encerrando...'); shuttingDown = true; await pararBot(false); setTimeout(() => process.exit(0), 1200); });
process.on('SIGINT', async () => { log('Sistema', 'SIGINT recebido, encerrando...'); shuttingDown = true; await pararBot(false); setTimeout(() => process.exit(0), 800); });

async function bootstrap() {
    await loadCfgRemote();
    config = loadCfg();
    await iniciarBot();
}
bootstrap();
