const wppconnect = require('@wppconnect-team/wppconnect');
const cron = require('node-cron');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_DIR = process.env.WPP_TOKEN_DIR || '/tmp/wppconnect-tokens';
const SESSION_NAME = process.env.WPP_SESSION_NAME || 'whatsapp-bot';
const SESSION_PATH = path.join(TOKEN_DIR, SESSION_NAME);
const CONFIG_FILE = process.env.BOT_CONFIG_FILE || path.join('/tmp', 'bot_config.json');
const BRASILIA_TZ = 'America/Sao_Paulo';
const STARTED_AT = new Date();
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || '/mcp';
const LOG_MAX = Number(process.env.LOG_MAX_ENTRIES || 180);
const LOG_CLEAR_H = Number(process.env.LOG_AUTO_CLEAR_HOURS || 12);
const MEM_WARN_MB = Number(process.env.MEMORY_WARN_MB || 420);
const MEM_RESTART_MB = Number(process.env.MEMORY_RESTART_MB || 500);
const QR_REFRESH_MS = Number(process.env.QR_REFRESH_MS || 0);
const PAIRING_WAIT_MS = Number(process.env.PAIRING_WAIT_MS || 90000);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 5000);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'whatsapp-sessions';
const SUPABASE_SESSION_PATH = process.env.SUPABASE_SESSION_PATH || 'wppconnect-tokens.zip';
const SUPABASE_CONFIG_PATH = process.env.SUPABASE_CONFIG_PATH || 'bot_config.json';
const SUPABASE_PREDEF_PATH = process.env.SUPABASE_PREDEFINIDAS_PATH || 'predefinidas.json';
const PREDEF_FILE = process.env.BOT_PREDEFINIDAS_FILE || path.join('/tmp', 'predefinidas.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const mkdir = p => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const rmrf = async p => { if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true }); mkdir(p); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const errMsg = e => e ? [e.message, e.status, e.code, e.name].filter(Boolean).join(' | ') || String(e) : 'desconhecido';
const sanitize = t => String(t || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\S\n\t]+$/gm, '').trim();

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
let initialSyncDone = false;
let pendingAcks = {};
let qrRefreshTimer = null;
let reconnectTimer = null;
let shuttingDown = false;
let startPromise = null;
let pairingPhone = '';
let lastPairingCode = '';
let pairingWaiters = [];

let gruposCache = { list: null, at: 0, building: false };
const CACHE_TTL = 2 * 60 * 1000;
const invalCache = () => { gruposCache = { list: null, at: 0, building: false }; };

const getClient = () => (client && botConnected ? client : null);
const clearChromeLocks = async () => {
    try {
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            await fs.promises.rm(path.join(SESSION_PATH, f), { force: true });
        }
    } catch {}
};
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
        log('Aviso', `Memória crítica (${r}MB). Reiniciando browser...`);
        reiniciarBot(true);
    }
};

process.on('uncaughtException', e => { log('Erro', 'Exceção', errMsg(e)); console.error(e); });
process.on('unhandledRejection', e => { log('Erro', 'Rejeição', errMsg(e)); console.error(e); });

log('Sistema', `PID=${process.pid} Logs=${LOG_MAX} Limpeza=${LOG_CLEAR_H}h`);
logMem(true);
if (LOG_CLEAR_H > 0) setInterval(() => { logs = []; logMem(true); }, LOG_CLEAR_H * 3600000);
setInterval(() => logMem(false), 300000);

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
    try { if (fs.existsSync(CONFIG_FILE)) return normCfg(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { log('Config', `Erro: ${e.message}`); }
    return defaultConfig();
};

const saveCfg = c => { mkdir(path.dirname(CONFIG_FILE)); fs.writeFileSync(CONFIG_FILE, JSON.stringify(normCfg(c), null, 2)); };

const applyVars = (msg, grupo = '') => {
    const p = brasil();
    const v = { grupo, data: p.data, hora: p.hora, diaSemana: p.diaSemana, saudacao: p.saudacao };
    return String(msg || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, k) => Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : `{{${k}}}`);
};

const reqSup = () => { if (!supabase) throw new Error('Supabase não configurado'); };

const saveCfgRemote = async () => {
    reqSup();
    saveCfg(config);
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
    reqSup();
    const d = normPredef(data);
    savePredefLocal(d);
    const buf = Buffer.from(JSON.stringify(d, null, 2));
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_PREDEF_PATH, buf, { contentType: 'application/json', upsert: true });
    if (error) throw error;
    return d;
};

const loadPredefRemote = async () => {
    if (!supabase) return loadPredefLocal();
    try {
        const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_PREDEF_PATH);
        if (error) return loadPredefLocal();
        const d = normPredef(JSON.parse(await data.text()));
        savePredefLocal(d);
        return d;
    } catch (e) { log('Erro', 'Predef remote', errMsg(e)); return loadPredefLocal(); }
};

const zipDir = async (src, out) => {
    if (!fs.existsSync(src)) throw new Error(`Pasta não encontrada: ${src}`);
    return new Promise((res, rej) => {
        const outS = fs.createWriteStream(out);
        const a = archiver('zip', { zlib: { level: 9 } });
        outS.on('close', () => res(a.pointer()));
        a.on('error', rej);
        a.pipe(outS);
        a.directory(src, false);
        a.finalize();
    });
};

const saveSessionRemote = async () => {
    reqSup();
    mkdir(TOKEN_DIR);
    const sessionPath = SESSION_PATH
    if (!fs.existsSync(sessionPath)) throw new Error(`Sessão não encontrada: ${sessionPath}`);
    const tmp = `/tmp/sess_${Date.now()}.zip`;
    const bytes = await zipDir(sessionPath, tmp);
    log('Sessão', `ZIP: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(SUPABASE_SESSION_PATH, fs.createReadStream(tmp), { contentType: 'application/zip', upsert: true });
    await fs.promises.rm(tmp, { force: true });
    if (error) throw error;
    log('Sessão', 'Salva no Supabase.');
};

const delSessionRemote = async () => {
    reqSup();
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([SUPABASE_SESSION_PATH]);
    if (error) throw error;
};

const restoreSessionRemote = async () => {
    reqSup();
    restarting = true;
    setState('restoring', 'Restaurando sessão...');
    const tmp = `/tmp/res_${Date.now()}.zip`;
    log('Sessão', 'Baixando do Supabase...');
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(SUPABASE_SESSION_PATH);
    if (error) throw error;
    await fs.promises.writeFile(tmp, Buffer.from(await data.arrayBuffer()));
    await pararBot(true);
    await rmrf(TOKEN_DIR);
    const sessionPath = SESSION_PATH
    mkdir(sessionPath);
    await new Promise((res, rej) => { fs.createReadStream(tmp).pipe(unzipper.Extract({ path: sessionPath })).on('close', res).on('error', rej); });
    await fs.promises.rm(tmp, { force: true });
    await loadCfgRemote();
    config = loadCfg();
    await iniciarBot();
};

function isExecutableFile(filePath) {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) return false;
        fs.chmodSync(filePath, 0o755);
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function findChromeExecutable(rootDir, maxDepth = 5) {
    if (!rootDir || !fs.existsSync(rootDir)) return null;

    const names = new Set(['chrome', 'chromium', 'chrome-headless-shell']);
    const preferred = [];
    const others = [];

    function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!['node_modules', '.git'].includes(entry.name)) walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile() || !names.has(entry.name)) continue;
            if (!isExecutableFile(full)) continue;
            if (full.includes('chrome-linux') || full.includes('chromium')) preferred.push(full);
            else others.push(full);
        }
    }

    walk(rootDir, 0);
    return preferred[0] || others[0] || null;
}

async function ensureChrome() {
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const buildId = process.env.PUPPETEER_CHROME_BUILD || '148.0.7778.97';
    mkdir(cacheDir);

    const envChrome = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envChrome) {
        const resolvedEnvChrome = isExecutableFile(envChrome) ? envChrome : findChromeExecutable(envChrome, 4);
        if (resolvedEnvChrome) {
            log('Info', `Chrome: ${resolvedEnvChrome}`);
            return resolvedEnvChrome;
        }
        log('Aviso', `PUPPETEER_EXECUTABLE_PATH inválido: ${envChrome}`);
    }

    let pb = null;
    try {
        pb = require('@puppeteer/browsers');
        const installed = await pb.install({
            browser: pb.Browser?.CHROME || 'chrome',
            buildId,
            cacheDir,
            unpack: true,
        });

        const candidates = [];
        if (typeof installed?.executablePath === 'function') candidates.push(installed.executablePath());
        if (typeof installed?.executablePath === 'string') candidates.push(installed.executablePath);
        if (typeof installed?.path === 'string') candidates.push(installed.path);

        if (typeof pb.computeExecutablePath === 'function') {
            try {
                candidates.push(pb.computeExecutablePath({
                    browser: pb.Browser?.CHROME || 'chrome',
                    buildId,
                    cacheDir,
                }));
            } catch {}
        }

        for (const candidate of candidates.filter(Boolean)) {
            const resolved = isExecutableFile(candidate) ? candidate : findChromeExecutable(candidate, 4);
            if (resolved) {
                log('Info', `Chrome: ${resolved}`);
                return resolved;
            }
        }

        const found = findChromeExecutable(cacheDir, 6);
        if (found) {
            log('Info', `Chrome: ${found}`);
            return found;
        }

        throw new Error(`Chrome instalado, mas executável não encontrado em ${cacheDir}`);
    } catch (e) {
        log('Info', `@puppeteer/browsers fallback: ${errMsg(e)}`);
    }

    try {
        const { execSync } = require('child_process');
        execSync(`npx @puppeteer/browsers install chrome@${buildId} --path ${cacheDir}`, {
            stdio: 'ignore', timeout: 180000,
        });
        const found = findChromeExecutable(cacheDir, 6);
        if (!found) throw new Error(`Chrome instalado via npx, mas executável não encontrado em ${cacheDir}`);
        log('Info', `Chrome: ${found}`);
        return found;
    } catch (e2) {
        log('Erro', 'Falha Chrome', errMsg(e2));
        throw e2;
    }
}

async function pararBot(keep = false) {
    if (shuttingDown) return;
    restarting = true;
    setState('restarting', 'Parando...');
    if (qrRefreshTimer) { clearTimeout(qrRefreshTimer); qrRefreshTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (startPromise) {
        try { await Promise.race([startPromise, wait(15000)]); } catch {}
    }
    Object.values(scheduledJobs).forEach(j => j.stop());
    scheduledJobs = {};
    invalCache();
    pendingAcks = {};
    const old = client;
    client = null;
    botConnected = false;
    if (old) {
        try {
            if (typeof old.close === 'function') await old.close();
            try {
                const b = old.page?.browser ? old.page.browser() : null;
                if (b && typeof b.close === 'function') await b.close();
            } catch {}
        } catch (e) { log('Aviso', 'Erro stop', errMsg(e)); }
        await wait(1200);
        await clearChromeLocks();
    }
    if (!keep) { restarting = false; qrDataURL = null; qrString = null; }
}

async function reiniciarBot(keep = false) {
    if (startPromise) { log('Bot', 'Inicialização já em andamento.'); return; }
    log('Bot', 'Reiniciando...');
    await pararBot(true);
    await wait(2500);
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

async function iniciarBot() {
    if (client || startPromise) return startPromise;
    if (shuttingDown) return;

    startPromise = (async () => {
        initialSyncDone = false;
        setState(pairingPhone ? 'pairing' : 'launching', pairingPhone ? 'Gerando código de emparelhamento...' : 'Iniciando WhatsApp...');
        mkdir(TOKEN_DIR);
        await clearChromeLocks();
        log('Info', `Tokens: ${TOKEN_DIR}`);
        try {
            const chromePath = await ensureChrome();
            const wpp = await wppconnect.create({
                session: SESSION_NAME,
                headless: true,
                useChrome: false,
                disableWelcome: true,
                disableGoogleAnalytics: true,
                updatesLog: false,
                logQR: false,
                autoClose: 0,
                deviceSyncTimeout: 0,
                waitForLogin: false,
                deviceName: 'WA Bot Render',
                folderNameToken: TOKEN_DIR,
                phoneNumber: pairingPhone || undefined,
                puppeteerOptions: {
                    executablePath: chromePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    timeout: 120000,
                    protocolTimeout: 120000,
                },
                browserArgs: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-sync',
                    '--disable-translate',
                    '--mute-audio',
                    '--metrics-recording-only',
                    '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
                    '--js-flags=--max-old-space-size=128',
                ],
                catchQR: async (base64Qr, asciiQR, attempts, urlCode) => {
                    try {
                        qrString = urlCode || base64Qr || '';
                        if (base64Qr && String(base64Qr).startsWith('data:image')) qrDataURL = base64Qr;
                        else if (urlCode) qrDataURL = await qrcode.toDataURL(urlCode);
                        else if (base64Qr) qrDataURL = await qrcode.toDataURL(base64Qr);
                        setState('qr', `Aguardando QR Code${attempts ? ` (${attempts})` : ''}`);
                        botConnected = false;
                        restarting = false;
                        log('QR', 'Novo QR Code disponível no painel.');
                        scheduleQRRefresh();
                    } catch (e) { log('Erro', 'Falha QR', errMsg(e)); }
                },
                catchLinkCode: (code) => {
                    const clean = String(code || '').trim();
                    if (!clean) return;
                    setState('pairing_code', 'Código de emparelhamento gerado.');
                    log('Pairing', `Código gerado: ${clean}`);
                    resolvePairingWaiters(clean);
                },
                statusFind: (statusSession) => {
                    log('Sessão', String(statusSession));
                    if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
                        qrDataURL = null;
                        qrString = null;
                        pairingPhone = '';
                        lastPairingCode = '';
                        setState('authenticated', 'WhatsApp autenticado. Finalizando conexão...');
                    }
                    if (statusSession === 'notLogged') setState(pairingPhone ? 'pairing' : 'qr', pairingPhone ? 'Aguardando código de emparelhamento...' : 'Aguardando QR Code...');
                    if (statusSession === 'autocloseCalled') log('Aviso', 'Auto close chamado pelo WPPConnect.');
                },
                onStateChange: state => {
                    log('Estado', `WhatsApp: ${state}`);
                    if (state === 'CONNECTED' || state === 'isLogged') {
                        qrDataURL = null;
                        qrString = null;
                        pairingPhone = '';
                        lastPairingCode = '';
                        setState('ready', 'Conectado');
                        botConnected = true;
                        restarting = false;
                        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                        if (!initialSyncDone) {
                            initialSyncDone = true;
                            invalCache();
                            scheduleAll();
                            listGroups().catch(() => {});
                        }
                    }
                    if (state === 'QRCode' || state === 'QR') {
                        setState('qr', 'Aguardando escaneamento...');
                        botConnected = false;
                        restarting = false;
                    }
                    if (state === 'DISCONNECTED' || state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
                        botConnected = false;
                        if (state === 'CONFLICT') log('Erro', 'Conflito: outro dispositivo');
                        if (!shuttingDown && !restarting && !pairingPhone) {
                            log('Bot', `Desconectado (${state}). Reconectando em ${RECONNECT_DELAY_MS/1000}s...`);
                            if (reconnectTimer) clearTimeout(reconnectTimer);
                            reconnectTimer = setTimeout(() => { reconnectTimer = null; reiniciarBot(); }, RECONNECT_DELAY_MS);
                        }
                    }
                },
            });

            client = wpp;

            wpp.onAck(async (ack) => {
                const id = ack?.id || ack?._serialized || '';
                const status = ack?.status ?? ack?.ack ?? -1;
                const cb = pendingAcks[id];
                if (cb) cb(status);
            });

            wpp.onParticipantsChanged(async () => { invalCache(); });

            wpp.onMessage(async (msg) => {
                try {
                    const isGroup = msg.isGroupMsg === true || msg.isGroup === true;
                    const from = isGroup ? (msg.chat?.name || msg.chat?.formattedTitle || msg.sender?.pushname || 'Alguém') : (msg.sender?.pushname || msg.notifyName || 'Alguém');
                    const text = (msg.body || msg.content || '').trim();
                    if (!text) return;
                    const lower = text.toLowerCase();

                    if (lower === '!ping') {
                        await wpp.sendText(msg.from, '🏓 Pong!');
                        return;
                    }
                    if (lower.startsWith('!echo ')) {
                        await wpp.sendText(msg.from, text.slice(6));
                        return;
                    }
                    if (lower === '!status' || lower === '!bot') {
                        const st = mcpStatus();
                        await wpp.sendText(msg.from, `🤖 Bot WhatsApp\nStatus: ${st.connected ? '✅ Conectado' : '❌ Desconectado'}\nAgendamentos: ${st.agendamentosAtivos}/${st.agendamentos} ativos\nUptime: ${Math.floor(st.uptimeSeconds / 60)}min`);
                        return;
                    }

                    if (!isGroup && (lower === 'menu' || lower === '!menu' || lower === 'help' || lower === '!help')) {
                        await wpp.sendText(msg.from, `🤖 *Comandos disponíveis*\n\n!ping — Testar resposta\n!echo <texto> — Repetir mensagem\n!status — Status do bot\n!menu — Esta mensagem`);
                    }
                } catch (e) {
                    log('Erro', 'onMessage', errMsg(e));
                }
            });

            log('Bot', 'Aguardando conexão...');
            try {
                const exists = await fs.promises.access(path.join(SESSION_PATH, 'Default', 'Local Storage', 'leveldb')).then(() => true).catch(() => false);
                if (exists) log('Info', 'Sessão existente detectada.');
            } catch {}
        } catch (e) {
            log('Erro', 'Falha iniciar bot', errMsg(e));
            client = null;
            botConnected = false;
            restarting = false;
            resolvePairingWaiters(null);
            await clearChromeLocks();
            if (!shuttingDown && !pairingPhone) {
                log('Bot', `Tentando novamente em ${RECONNECT_DELAY_MS/1000}s...`);
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => { reconnectTimer = null; iniciarBot(); }, RECONNECT_DELAY_MS);
            }
        } finally {
            startPromise = null;
        }
    })();
    return startPromise;
}

function scheduleQRRefresh() {
    if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
    if (!QR_REFRESH_MS || QR_REFRESH_MS <= 0) return;
    qrRefreshTimer = setTimeout(() => {
        qrRefreshTimer = null;
        if (!botConnected && !shuttingDown && !startPromise) {
            log('QR', 'QR expirado. Reiniciando por configuração QR_REFRESH_MS...');
            reiniciarBot();
        }
    }, QR_REFRESH_MS);
}

async function gerarPairingCode(phone) {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) return null;
    if (botConnected) return null;

    try {
        lastPairingCode = '';
        pairingPhone = cleanPhone;
        resolvePairingWaiters(null);
        log('Pairing', `Solicitando código para ${cleanPhone}`);
        if (startPromise && !client) {
            setState('pairing', 'Aguardando inicialização atual para trocar para código...');
            try { await Promise.race([startPromise, wait(20000)]); } catch {}
        }
        await pararBot(true);
        await wait(2500);
        await iniciarBot();
        return await waitPairingCode(PAIRING_WAIT_MS);
    } catch (e) {
        log('Aviso', 'Pairing code', errMsg(e));
        resolvePairingWaiters(null);
        return null;
    }
}

async function listGroups() {
    const c = getClient();
    if (!c) return [];
    if (gruposCache.list && Date.now() - gruposCache.at < CACHE_TTL) return gruposCache.list;
    if (gruposCache.building) { const dead = Date.now() + 8000; while (gruposCache.building && Date.now() < dead) await wait(200); if (gruposCache.list) return gruposCache.list; return []; }
    gruposCache.building = true;
    try {
        if (!getClient()) { gruposCache.building = false; return []; }
        const groups = await client.getAllGroups();
        const gs = (groups || []).map(g => {
            const id = g.id?._serialized || g.id || g._serialized || '';
            const name = g.name || g.subject || g.formattedTitle || 'Sem nome';
            return { nome: name, id };
        }).filter(g => g.id).sort((a, b) => a.nome.localeCompare(b.nome));
        if (gs.length > 0) gruposCache = { list: gs, at: Date.now(), building: false };
        else { gruposCache = { list: null, at: 0, building: false }; log('Aviso', 'Nenhum grupo encontrado.'); }
        return gs;
    } catch (e) { gruposCache.building = false; throw e; }
}

async function enviarMsg(grupo, mensagem, meta = {}) {
    const grupoId = meta.grupoId || '';
    if (!client || !botConnected) {
        log('Erro', `Bot não conectado (${botStatus})`);
        return { ok: false, msg: `Bot não conectado. Estado: ${botStatus}` };
    }
    try {
        const msg = sanitize(applyVars(mensagem, grupo));
        if (!msg) return { ok: false, msg: 'Mensagem vazia' };
        let destId = grupoId || grupo;
        let destNome = grupo;
        if (!grupoId) {
            const groups = await client.getAllGroups();
            const match = (groups || []).find(g => {
                const name = g.name || g.subject || g.formattedTitle || '';
                return name === grupo;
            });
            if (!match) return { ok: false, msg: `Grupo "${grupo}" não encontrado` };
            destId = match.id?._serialized || match.id || '';
            destNome = match.name || match.subject || grupo;
        }
        log('WhatsApp', `Enviando para "${destNome}" (${destId})`);
        const sent = await client.sendText(destId, msg);
        const id = sent?.id || sent?._serialized || '';
        if (!id) { log('Sucesso', `Enviado "${destNome}"`); return { ok: true, grupo: destNome, grupoId: destId }; }
        return await new Promise(res => {
            let done = false;
            const to = setTimeout(() => { if (done) return; done = true; delete pendingAcks[id]; res({ ok: true, grupo: destNome, grupoId: destId }); }, 15000);
            pendingAcks[id] = status => {
                if (done) return; done = true; clearTimeout(to); delete pendingAcks[id];
                const lbl = { 0: 'ERRO', 1: 'enviado', 2: 'entregue', 3: 'lida', 4: 'reproduzida' };
                log('ACK', `${id}: ${lbl[String(status)] || status}`);
                if (status === 0) res({ ok: false, msg: `ACK negativo: rejeitada para "${destNome}"` });
                else res({ ok: true, id, grupo: destNome, grupoId: destId });
            };
        });
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

const mcpR = (d, err = false) => ({ content: [{ type: 'text', text: typeof d === 'string' ? d : JSON.stringify(d, null, 2) }], isError: err });
const mcpTool = (n, d, s) => ({ name: n, description: d, inputSchema: s });

const mcpTools = () => [
    mcpTool('listar_status_bot', 'Status do bot', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('listar_grupos', 'Lista grupos', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('listar_agendamentos', 'Lista agendamentos', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('criar_agendamento', 'Cria agendamento', { type: 'object', properties: { grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' }, horario: { type: 'string' }, diasSemana: { type: 'array', items: { type: 'number' } }, ativo: { type: 'boolean' } }, required: ['mensagem', 'horario'], additionalProperties: false }),
    mcpTool('editar_agendamento', 'Edita agendamento', { type: 'object', properties: { id: { type: ['string', 'number'] }, grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' }, horario: { type: 'string' }, diasSemana: { type: 'array', items: { type: 'number' } }, ativo: { type: 'boolean' } }, required: ['id'], additionalProperties: false }),
    mcpTool('excluir_agendamento', 'Exclui agendamento', { type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false }),
    mcpTool('ativar_agendamento', 'Ativa agendamento', { type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false }),
    mcpTool('pausar_agendamento', 'Pausa agendamento', { type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false }),
    mcpTool('listar_predefinidas', 'Lista predefinidas', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('criar_predefinida', 'Cria predefinida', { type: 'object', properties: { titulo: { type: 'string' }, mensagem: { type: 'string' } }, required: ['mensagem'], additionalProperties: false }),
    mcpTool('editar_predefinida', 'Edita predefinida', { type: 'object', properties: { id: { type: ['string', 'number'] }, titulo: { type: 'string' }, mensagem: { type: 'string' } }, required: ['id'], additionalProperties: false }),
    mcpTool('excluir_predefinida', 'Exclui predefinida', { type: 'object', properties: { id: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false }),
    mcpTool('enviar_mensagem_teste', 'Envia mensagem', { type: 'object', properties: { grupo: { type: 'string' }, grupoId: { type: 'string' }, mensagem: { type: 'string' } }, required: ['mensagem'], additionalProperties: false }),
    mcpTool('listar_logs', 'Lista logs', { type: 'object', properties: { limite: { type: 'number' } }, additionalProperties: false }),
    mcpTool('salvar_sessao', 'Salva sessão no Supabase', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('restaurar_sessao', 'Restaura sessão do Supabase', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('excluir_sessao', 'Exclui sessão do Supabase', { type: 'object', properties: {}, additionalProperties: false }),
    mcpTool('atualizar_sessao_e_grupos', 'Reinicia client WhatsApp', { type: 'object', properties: {}, additionalProperties: false }),
];

const mcpStatus = () => ({
    connected: botConnected, state: botState, status: botStatus, restarting, timezone: BRASILIA_TZ,
    uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(),
    supabaseConfigured: Boolean(supabase), gruposCacheValido: Boolean(gruposCache.list), gruposCacheTotal: gruposCache.list?.length || 0,
    agendamentos: config.agendamentos.length, agendamentosAtivos: config.agendamentos.filter(a => a.ativo).length
});

const persistCfg = async () => {
    config = normCfg(config);
    saveCfg(config);
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
            config = normCfg(config);
            config.agendamentos.push(ag);
            await persistCfg();
            log('MCP', `Agendamento criado: "${ag.grupo || ag.grupoId}"`);
            return { ok: true, agendamento: ag };
        }
        case 'editar_agendamento': {
            const id = a.id; if (id === undefined || id === null || id === '') throw new Error('ID obrigatório');
            config = normCfg(config);
            const idx = config.agendamentos.findIndex(x => String(x.id) === String(id));
            if (idx < 0) throw new Error(`Agendamento ${id} não encontrado`);
            config.agendamentos[idx] = normAg({ ...config.agendamentos[idx], ...a, id: config.agendamentos[idx].id });
            await persistCfg();
            log('MCP', `Agendamento editado: ${id}`);
            return { ok: true, agendamento: config.agendamentos[idx] };
        }
        case 'excluir_agendamento': {
            const id = a.id; if (id === undefined || id === null || id === '') throw new Error('ID obrigatório');
            config = normCfg(config);
            const before = config.agendamentos.length;
            config.agendamentos = config.agendamentos.filter(x => String(x.id) !== String(id));
            if (config.agendamentos.length === before) throw new Error(`Agendamento ${id} não encontrado`);
            await persistCfg();
            log('MCP', `Agendamento excluído: ${id}`);
            return { ok: true };
        }
        case 'ativar_agendamento':
        case 'pausar_agendamento': {
            const id = a.id; if (id === undefined || id === null || id === '') throw new Error('ID obrigatório');
            config = normCfg(config);
            const idx = config.agendamentos.findIndex(x => String(x.id) === String(id));
            if (idx < 0) throw new Error(`Agendamento ${id} não encontrado`);
            config.agendamentos[idx].ativo = name === 'ativar_agendamento';
            config.agendamentos[idx] = normAg(config.agendamentos[idx]);
            await persistCfg();
            log('MCP', `${config.agendamentos[idx].ativo ? 'Ativado' : 'Pausado'}: ${id}`);
            return { ok: true, agendamento: config.agendamentos[idx] };
        }
        case 'listar_predefinidas': return await loadPredefRemote();
        case 'criar_predefinida': {
            const item = normPredef([{ id: Date.now(), titulo: a.titulo || '', mensagem: a.mensagem || '' }])[0];
            if (!item) throw new Error('Título ou mensagem obrigatórios');
            const cur = await loadPredefRemote();
            cur.unshift(item);
            await savePredefRemote(cur);
            log('MCP', `Predef criada: "${item.titulo || item.id}"`);
            return { ok: true, predefinida: item };
        }
        case 'editar_predefinida': {
            const id = a.id; if (id === undefined || id === null || id === '') throw new Error('ID obrigatório');
            const cur = await loadPredefRemote();
            const idx = cur.findIndex(x => String(x.id) === String(id));
            if (idx < 0) throw new Error(`Predef ${id} não encontrada`);
            cur[idx] = normPredef([{ ...cur[idx], ...a, id: cur[idx].id }])[0];
            await savePredefRemote(cur);
            log('MCP', `Predef editada: ${id}`);
            return { ok: true, predefinida: cur[idx] };
        }
        case 'excluir_predefinida': {
            const id = a.id; if (id === undefined || id === null || id === '') throw new Error('ID obrigatório');
            const cur = await loadPredefRemote();
            await savePredefRemote(cur.filter(x => String(x.id) !== String(id)));
            log('MCP', `Predef excluída: ${id}`);
            return { ok: true };
        }
        case 'enviar_mensagem_teste': {
            const grupo = String(a.grupo || a.grupoId || '').trim();
            const grupoId = String(a.grupoId || '').trim();
            if ((!grupo && !grupoId) || !a.mensagem) throw new Error('Grupo e mensagem obrigatórios');
            return await enviarMsg(grupo, String(a.mensagem), { origem: 'mcp', grupoId });
        }
        case 'listar_logs': return logs.slice(0, Math.min(Math.max(Number(a.limite || 50), 1), 300));
        case 'salvar_sessao': await saveSessionRemote(); log('MCP', 'Sessão salva.'); return { ok: true };
        case 'restaurar_sessao': setTimeout(async () => { try { await restoreSessionRemote(); } catch (e) { log('Erro', 'Restore', errMsg(e)); setState('error', 'Erro restore'); restarting = false; } }, 300); return { ok: true, msg: 'Restauração iniciada' };
        case 'excluir_sessao': await delSessionRemote(); await rmrf(TOKEN_DIR); setTimeout(async () => { try { await pararBot(true); await wait(1500); await iniciarBot(); } catch (e) { log('Erro', 'Reinício', errMsg(e)); setState('error', 'Erro reinício'); restarting = false; } }, 300); return { ok: true, msg: 'Sessão limpa' };
        case 'atualizar_sessao_e_grupos': setTimeout(async () => { try { await pararBot(true); await wait(1500); await iniciarBot(); } catch (e) { log('Erro', 'Reinício', errMsg(e)); setState('error', 'Erro reinício'); restarting = false; } }, 300); return { ok: true, msg: 'Reinício iniciado' };
        default: throw new Error(`Ferramenta desconhecida: ${name}`);
    }
}

const handleMcp = async payload => {
    if (!payload || typeof payload !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Inválido' } };
    const id = payload.id ?? null;
    try {
        if (payload.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: payload.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bot-whatsapp-mcp', version: '4.0' } } };
        if (payload.method === 'notifications/initialized') return null;
        if (payload.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: mcpTools() } };
        if (payload.method === 'tools/call') { const r = await callMcp(payload.params.name, payload.params.arguments); return { jsonrpc: '2.0', id, result: mcpR(r) }; }
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método não suportado: ${payload.method}` } };
    } catch (e) { return { jsonrpc: '2.0', id, result: mcpR({ ok: false, error: errMsg(e) }, true) }; }
};

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'wa-bot', uptime: Math.floor(process.uptime()), state: botState, connected: botConnected, mcpConfigured: Boolean(MCP_AUTH_TOKEN) }));
app.get('/health', (req, res) => res.redirect('/api/health'));
app.get('/ping', (req, res) => res.send('pong'));

app.get(MCP_ENDPOINT, mcpAuth, (req, res) => res.json({ ok: true, name: 'bot-whatsapp-mcp', tools: mcpTools().map(t => t.name) }));
app.post(MCP_ENDPOINT, mcpAuth, async (req, res) => {
    try {
        if (Array.isArray(req.body)) { const r = (await Promise.all(req.body.map(handleMcp))).filter(Boolean); return res.json(r); }
        const r = await handleMcp(req.body);
        if (!r) return res.status(202).end();
        res.json(r);
    } catch (e) { res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: errMsg(e) } }); }
});

app.get('/api/status', (req, res) => res.json({
    connected: botConnected, state: botState, status: botStatus, restarting,
    qr: qrDataURL, qrRaw: qrString, pairingCode: lastPairingCode,
    supabaseConfigured: Boolean(supabase), supabaseBucket: SUPABASE_BUCKET, supabaseSessionPath: SUPABASE_SESSION_PATH,
    uptimeSeconds: Math.floor(process.uptime()), startedAt: STARTED_AT.toISOString(),
    gruposCacheValido: Boolean(gruposCache.list), gruposCacheTotal: gruposCache.list?.length || 0,
}));

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', async (req, res) => {
    try { config = normCfg(req.body); saveCfg(config); try { await saveCfgRemote(); } catch (e) { log('Erro', 'Supabase', errMsg(e)); } if (botConnected) scheduleAll(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});

app.post('/api/agendamento', async (req, res) => {
    try {
        const ag = normAg(req.body || {});
        if (!ag.id) ag.id = Date.now();
        config = normCfg(config);
        const idx = config.agendamentos.findIndex(x => String(x.id) === String(ag.id));
        if (idx >= 0) config.agendamentos[idx] = ag; else config.agendamentos.push(ag);
        saveCfg(config);
        try { await saveCfgRemote(); } catch (e) { log('Erro', 'Supabase', errMsg(e)); }
        if (botConnected) scheduleAll();
        res.json({ ok: true, agendamento: ag });
    } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});

app.post('/api/pairing-code', async (req, res) => {
    try {
        const phone = String(req.body?.phone || '').replace(/\D/g, '');
        if (!phone || phone.length < 10 || phone.length > 15) {
            return res.status(400).json({ ok: false, msg: 'Número inválido. Use código do país + DDD + número (5511999999999).' });
        }
        if (botConnected) {
            return res.status(400).json({ ok: false, msg: 'Bot já conectado. Não é necessário emparelhar.' });
        }
        const code = await gerarPairingCode(phone);
        if (code) {
            log('Pairing', `Código gerado para ${phone}`);
            res.json({ ok: true, code });
        } else {
            res.status(504).json({ ok: false, msg: 'Não foi possível gerar o código dentro do tempo limite. Tente novamente ou use o QR Code no painel.' });
        }
    } catch (e) {
        res.status(500).json({ ok: false, msg: errMsg(e) });
    }
});

app.get('/api/predefinidas', async (req, res) => { const d = await loadPredefRemote(); res.json(d); });
app.post('/api/predefinidas', async (req, res) => {
    try {
        const item = normPredef([{ ...req.body, id: req.body?.id || Date.now() }])[0];
        if (!item) return res.status(400).json({ ok: false, msg: 'Título ou mensagem obrigatórios' });
        const cur = await loadPredefRemote();
        const idx = cur.findIndex(x => String(x.id) === String(item.id));
        if (idx >= 0) cur[idx] = item; else cur.unshift(item);
        await savePredefRemote(cur);
        res.json({ ok: true, predefinida: item });
    } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.delete('/api/predefinidas/:id', async (req, res) => {
    try { const cur = await loadPredefRemote(); await savePredefRemote(cur.filter(x => String(x.id) !== String(req.params.id))); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});

app.get('/api/logs', (req, res) => res.json(logs));
app.post('/api/logs/clear', (req, res) => { logs = []; res.json({ ok: true }); });
app.get('/api/memory', (req, res) => { const m = process.memoryUsage(); res.json({ rssMb: Math.round(m.rss / 1024 / 1024), heapUsedMb: Math.round(m.heapUsed / 1024 / 1024), limitHintMb: 512 }); });

app.post('/api/enviar', async (req, res) => {
    const { grupo, grupoId, mensagem } = req.body;
    if ((!grupo && !grupoId) || !mensagem) return res.json({ ok: false, msg: 'Grupo e mensagem obrigatórios' });
    res.json(await enviarMsg(grupo || grupoId, mensagem, { grupoId }));
});

app.get('/api/grupos', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!client || !botConnected) return res.json([]);
    try { res.json(await listGroups()); } catch (e) { res.json([]); }
});

app.post('/api/session/save', async (req, res) => {
    try { await saveSessionRemote(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/session/delete', async (req, res) => {
    try { await delSessionRemote(); await rmrf(TOKEN_DIR); res.json({ ok: true, msg: 'Sessão limpa' }); setTimeout(async () => { try { await pararBot(true); await wait(1500); await iniciarBot(); } catch (e) {} }, 300); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/session/restart', async (req, res) => {
    try { res.json({ ok: true, msg: 'Reiniciando...' }); setTimeout(async () => { try { await pararBot(true); await wait(1500); await iniciarBot(); } catch (e) {} }, 300); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});
app.post('/api/session/restore', async (req, res) => {
    try { res.json({ ok: true, msg: 'Restaurando...' }); restarting = true; setState('restoring', 'Restaurando...'); setTimeout(async () => { try { await restoreSessionRemote(); } catch (e) { log('Erro', 'Restore', errMsg(e)); setState('error', 'Erro'); restarting = false; } }, 500); }
    catch (e) { res.status(500).json({ ok: false, msg: errMsg(e) }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    log('Servidor', `Porta ${PORT}`);
    log('Servidor', `MCP: ${MCP_ENDPOINT} ${MCP_AUTH_TOKEN ? '(token)' : '(desativado)'}`);
});

process.on('SIGTERM', async () => {
    log('Sistema', 'SIGTERM recebido, encerrando...');
    shuttingDown = true;
    await pararBot(false);
    setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', async () => {
    log('Sistema', 'SIGINT recebido, encerrando...');
    shuttingDown = true;
    await pararBot(false);
    setTimeout(() => process.exit(0), 1000);
});

async function bootstrap() {
    await loadCfgRemote();
    config = loadCfg();
    await iniciarBot();
}
bootstrap();
