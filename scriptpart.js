<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
let config = { agendamentos: [] };
let grupos = [];
let agFilterDays = new Set();
let predefinidas = [];
let predefTargetTextareaId = null;
let lastLogs = [];
const expandedAgs = new Set();
const dayLabels = [
  { id: 0, label: 'Dom' }, { id: 1, label: 'Seg' }, { id: 2, label: 'Ter' }, { id: 3, label: 'Qua' },
  { id: 4, label: 'Qui' }, { id: 5, label: 'Sex' }, { id: 6, label: 'Sáb' }
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

function sanitizeClientMessage(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function getBrasiliaPartsClient() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const h = Number(parts.hour || 0);
  return {
    data: `${parts.day}/${parts.month}/${parts.year}`,
    hora: `${parts.hour}:${parts.minute}`,
    diaSemana: parts.weekday || '',
    saudacao: h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
  };
}

function applyVariablesClient(message, grupo = '') {
  const p = getBrasiliaPartsClient();
  const vars = { grupo, data: p.data, hora: p.hora, diaSemana: p.diaSemana, saudacao: p.saudacao };
  return String(message || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`);
}

function renderWhatsAppFormatting(text) {
  let out = escapeHtml(text);
  out = out.replace(/```([\s\S]*?)```/g, '<code>$1</code>');
  out = out.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
  out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  out = out.replace(/~([^~\n]+)~/g, '<del>$1</del>');
  return out;
}

function buildCron(horario, diasSemana) {
  const [h='12', m='00'] = String(horario || '12:00').split(':');
  const days = Array.isArray(diasSemana) && diasSemana.length ? diasSemana.join(',') : '*';
  return `${Number(m) || 0} ${Number(h) || 0} * * ${days}`;
}

function normalizeAg(ag) {
  const dias = Array.isArray(ag.diasSemana) ? ag.diasSemana.map(Number).filter(d => d >= 0 && d <= 6).sort((a,b) => a-b) : [1,2,3];
  const horario = ag.horario || '12:00';
  return { ...ag, id: ag.id || Date.now(), grupo: ag.grupo || '', grupoId: ag.grupoId || '', diasSemana: dias, horario, cron: buildCron(horario, dias) };
}

function showToast(text = 'Salvo com sucesso') {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    updateStatus(d);
  } catch(e) {}
  setTimeout(pollStatus, 3000);
}

function updateStatus(d) {
  const pill = document.getElementById('status-pill');
  const txt = document.getElementById('status-text');
  const qrImg = document.getElementById('qr-img');
  const qrPh = document.getElementById('qr-placeholder');
  const connected = document.getElementById('connected-state');

  document.getElementById('supabase-status').textContent = d.supabaseConfigured ? 'Configurado' : 'Não configurado';
  document.getElementById('supabase-path').textContent = `${d.supabaseBucket || '-'}/${d.supabaseSessionPath || '-'}`;

  const transientStates = ['starting', 'restoring', 'restarting', 'connecting', 'authenticated'];

  if (d.connected) {
    pill.className = 'status-pill connected';
    txt.textContent = 'Conectado';
    qrImg.style.display = 'none';
    qrPh.style.display = 'none';
    connected.style.display = 'block';
  } else if (transientStates.includes(d.state)) {
    pill.className = 'status-pill';
    txt.textContent = d.status || 'Conectando...';
    qrImg.style.display = 'none';
    qrPh.style.display = 'flex';
    qrPh.innerHTML = `<i class="bi bi-hourglass-split mb-2"></i><div class="mono small">${escapeHtml(d.status || 'Conectando...')}</div>`;
    connected.style.display = 'none';
  } else if (d.qr) {
    pill.className = 'status-pill qr';
    txt.textContent = 'Aguardando QR';
    qrImg.src = d.qr;
    qrImg.style.display = 'block';
    qrPh.style.display = 'none';
    connected.style.display = 'none';
  } else {
    pill.className = 'status-pill';
    txt.textContent = d.status || 'Inicializando...';
    qrImg.style.display = 'none';
    qrPh.style.display = 'flex';
    qrPh.innerHTML = '<i class="bi bi-qr-code-scan mb-2"></i><div class="mono small">Aguardando QR Code</div>';
    connected.style.display = 'none';
  }
}

async function pollLogs(skipSchedule = false) {
  try {
    const type = document.getElementById('log-type-filter')?.value || '';
    const limit = document.getElementById('log-limit-filter')?.value || '100';
    const q = document.getElementById('log-text-filter')?.value || '';
    const params = new URLSearchParams({ limit });
    if (type) params.set('type', type);
    if (q.trim()) params.set('q', q.trim());
    const r = await fetch('/api/logs?' + params.toString(), { cache: 'no-store' });
    lastLogs = await r.json();
    const box = document.getElementById('logs-box');
    box.innerHTML = lastLogs.map(l => `
      <div class="log-entry">
        <span class="log-time">${escapeHtml(l.time)}</span>
        <span class="log-type ${escapeHtml(l.type)}">${escapeHtml(l.type)}</span>
        <span>${escapeHtml(l.msg)}</span>
      </div>
    `).join('') || '<div class="muted small">Sem logs para este filtro...</div>';
  } catch(e) {}
  if (!skipSchedule) setTimeout(pollLogs, 3000);
}

function copyLogs() {
  const text = lastLogs.map(l => `[${l.time}] [${l.type}] ${l.msg}`).join('\n');
  navigator.clipboard.writeText(text || 'Sem logs');
  showToast('Logs copiados');
}

async function loadPredefinidas() {
  try {
    const r = await fetch('/api/predefinidas?t=' + Date.now(), { cache: 'no-store' });
    predefinidas = await r.json();
    if (!Array.isArray(predefinidas)) predefinidas = [];
  } catch (e) {
    predefinidas = [];
  }
  renderPredefinidas();
}

function renderPredefinidas() {
  const list = document.getElementById('predef-list');
  if (!list) return;
  if (!predefinidas.length) {
    list.innerHTML = '<div class="muted small">Nenhuma mensagem predefinida cadastrada.</div>';
    return;
  }
  list.innerHTML = predefinidas.map(p => `
    <div class="predef-card" onclick="openPredefModal('${escapeHtml(p.id)}')">
      <div class="predef-title">${escapeHtml(p.titulo || 'Sem título')}</div>
      <div class="predef-preview">${escapeHtml(p.mensagem || '')}</div>
    </div>
  `).join('');
}

function openPredefModal(id = '') {
  const item = predefinidas.find(p => String(p.id) === String(id));
  document.getElementById('predef-id').value = item?.id || '';
  document.getElementById('predef-titulo').value = item?.titulo || '';
  document.getElementById('predef-mensagem').value = item?.mensagem || '';
  document.getElementById('predef-modal-title').textContent = item ? 'Editar mensagem predefinida' : 'Nova mensagem predefinida';
  document.getElementById('btn-delete-predef').style.display = item ? 'inline-flex' : 'none';
  const result = document.getElementById('predef-result');
  result.className = 'alert d-none mb-0';
  result.textContent = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('predefModal')).show();
}

async function savePredefAtual() {
  const id = document.getElementById('predef-id').value;
  const titulo = document.getElementById('predef-titulo').value.trim();
  const mensagem = document.getElementById('predef-mensagem').value.trim();
  const result = document.getElementById('predef-result');
  if (!titulo && !mensagem) {
    result.className = 'alert alert-danger mb-0';
    result.textContent = 'Informe título ou mensagem.';
    return;
  }
  const r = await fetch('/api/predefinidas', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: id || undefined, titulo, mensagem }) });
  const d = await r.json().catch(() => ({ ok:false, msg:'Resposta inválida' }));
  if (!r.ok || d.ok === false) {
    result.className = 'alert alert-danger mb-0';
    result.textContent = d.msg || 'Erro ao salvar predefinida.';
    return;
  }
  predefinidas = d.predefinidas || predefinidas;
  renderPredefinidas();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('predefModal')).hide();
  showToast('Predefinida salva');
}

async function deletePredefAtual() {
  const id = document.getElementById('predef-id').value;
  if (!id) return;
  const r = await fetch('/api/predefinidas/' + encodeURIComponent(id), { method:'DELETE' });
  const d = await r.json().catch(() => ({ ok:false, msg:'Resposta inválida' }));
  if (!r.ok || d.ok === false) {
    const result = document.getElementById('predef-result');
    result.className = 'alert alert-danger mb-0';
    result.textContent = d.msg || 'Erro ao excluir predefinida.';
    return;
  }
  predefinidas = d.predefinidas || [];
  renderPredefinidas();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('predefModal')).hide();
  showToast('Predefinida excluída');
}

function openUsePredefModal(textareaId) {
  predefTargetTextareaId = textareaId;
  const list = document.getElementById('use-predef-list');
  if (!predefinidas.length) {
    list.innerHTML = '<div class="muted small">Nenhuma predefinida cadastrada.</div>';
  } else {
    list.innerHTML = predefinidas.map(p => `
      <button type="button" class="btn btn-soft text-start" onclick="usePredefinida('${escapeHtml(p.id)}')">
        <div class="fw-bold">${escapeHtml(p.titulo || 'Sem título')}</div>
        <div class="muted small text-truncate">${escapeHtml(p.mensagem || '')}</div>
      </button>
    `).join('');
  }
  bootstrap.Modal.getOrCreateInstance(document.getElementById('usePredefModal')).show();
}

function usePredefinida(id) {
  const item = predefinidas.find(p => String(p.id) === String(id));
  const el = document.getElementById(predefTargetTextareaId);
  if (!item || !el) return;
  el.value = item.mensagem || '';
  dispatchInput(el);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('usePredefModal')).hide();
  showToast('Predefinida aplicada');
}


async function loadConfig() {
  const r = await fetch('/api/config');
  config = await r.json();
  config.agendamentos = (config.agendamentos || []).map(normalizeAg);
  expandedAgs.clear();
  renderAgs();
}

async function loadGrupos() {
  try {
    const r = await fetch('/api/grupos?t=' + Date.now(), { cache: 'no-store' });
    const data = await r.json();
    grupos = Array.isArray(data)
      ? data
          .map(g => typeof g === 'string'
            ? { nome: g, id: '' }
            : { nome: g.nome || g.name || '', id: g.id || '' }
          )
          .filter(g => g.nome && g.id)
      : [];
    refreshGroupSelects();
  } catch(e) {
    console.error('Erro ao carregar grupos', e);
  }
  setTimeout(loadGrupos, 15000);
}

function findGrupoById(id) {
  return grupos.find(g => g.id === id) || null;
}

function findGrupoByName(nome) {
  return grupos.find(g => g.nome === nome) || null;
}

function groupSelectOptions(selectedId = '', selectedName = '') {
  const hasSelected = selectedId && grupos.some(g => g.id === selectedId);
  let html = '<option value="">Selecione um grupo</option>';

  if (selectedId && !hasSelected) {
    html += `
      <option value="" selected disabled>
        ${escapeHtml(selectedName || 'Grupo removido')} — grupo não disponível
      </option>
    `;
  }

  html += grupos.map(g => {
    const selected = hasSelected && g.id === selectedId ? 'selected' : '';
    return `<option value="${escapeHtml(g.id)}" ${selected}>${escapeHtml(g.nome)} — ${escapeHtml(g.id)}</option>`;
  }).join('');

  return html;
}

function refreshGroupSelects() {
  let configChanged = false;

  if (Array.isArray(config.agendamentos)) {
    config.agendamentos = config.agendamentos.map(ag => {
      const normalized = normalizeAg(ag);
      if (!normalized.grupoId && normalized.grupo) {
        const found = findGrupoByName(normalized.grupo);
        if (found?.id) {
          configChanged = true;
          return { ...normalized, grupoId: found.id, grupo: found.nome };
        }
      }
      return normalized;
    });
  }

  const manual = document.getElementById('manual-grupo-id');
  if (manual) {
    const current = manual.value;
    manual.innerHTML = groupSelectOptions(current, '');
    if (current) manual.value = current;
    updateManualGroupIdView();
  }

  const active = document.activeElement;
  const editingText = active && (active.tagName === 'TEXTAREA' || active.type === 'time');
  if (configChanged || !editingText) renderAgs();
}

function getManualGroup() {
  const id = document.getElementById('manual-grupo-id')?.value || '';
  const found = findGrupoById(id);
  return { grupo: found?.nome || '', grupoId: id };
}

function updateManualGroupIdView() {
  const box = document.getElementById('manual-grupo-id-view');
  if (!box) return;
  const { grupo, grupoId } = getManualGroup();
  box.textContent = grupoId ? `${grupo} · ${grupoId}` : 'Selecione o grupo para usar o ID real do WhatsApp.';
}

function onManualGroupChange() {
  updateManualGroupIdView();
  updateManualPreview();
}

function updateAgGroupById(i, grupoId) {
  const found = findGrupoById(grupoId);
  config.agendamentos[i].grupoId = grupoId || '';
  config.agendamentos[i].grupo = found?.nome || '';
  config.agendamentos[i] = normalizeAg(config.agendamentos[i]);
  renderAgs();
}
function getAgFilter() {
  return (document.getElementById('ag-filter')?.value || '').trim().toLowerCase();
}

function toggleAgFilterDay(day, checked) {
  checked ? agFilterDays.add(day) : agFilterDays.delete(day);
  renderAgs();
}

function clearAgDayFilter() {
  agFilterDays.clear();
  document.querySelectorAll('.ag-day-filter input[type="checkbox"]').forEach(el => el.checked = false);
  renderAgs();
}

function matchAgDayFilter(ag) {
  if (!agFilterDays.size) return true;
  const days = Array.isArray(ag.diasSemana) ? ag.diasSemana.map(Number) : [];
  return [...agFilterDays].some(day => days.includes(Number(day)));
}

function nextRunText(ag) {
  if (!ag.ativo || !ag.horario || !Array.isArray(ag.diasSemana) || !ag.diasSemana.length) return 'Sem próximo disparo';
  const now = new Date();
  const [hh, mm] = ag.horario.split(':').map(Number);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(now);
    d.setDate(now.getDate() + add);
    d.setHours(hh || 0, mm || 0, 0, 0);
    if (d <= now) continue;
    if (ag.diasSemana.includes(d.getDay())) {
      const label = add === 0 ? 'Hoje' : add === 1 ? 'Amanhã' : d.toLocaleDateString('pt-BR', { weekday:'long' });
      return `${label} às ${ag.horario}`;
    }
  }
  return 'Sem próximo disparo';
}

function renderAgs() {
  const list = document.getElementById('ag-list');
  const filter = getAgFilter();
  const all = config.agendamentos || [];
  const visible = all
    .map((agRaw, i) => ({ ag: normalizeAg(agRaw), i }))
    .filter(item => (!filter || `${item.ag.grupo || ''} ${item.ag.grupoId || ''}`.toLowerCase().includes(filter)) && matchAgDayFilter(item.ag));

  visible.forEach(({ ag, i }) => config.agendamentos[i] = ag);

  if (!visible.length) {
    list.innerHTML = '<div class="muted small">Nenhum agendamento encontrado.</div>';
    return;
  }

  list.innerHTML = visible.map(({ ag, i }) => {
    const isCollapsed = !expandedAgs.has(ag.id);
    return `
      <div class="ag-card ${ag.ativo ? 'active' : ''} ${isCollapsed ? 'collapsed' : ''}" id="ag-${ag.id}">
        <div class="ag-summary">
          <div class="ag-summary-left">
            <button class="btn btn-soft btn-sm" onclick="toggleAgCollapse(${ag.id})" title="Expandir/Recolher">
              <i class="bi ${isCollapsed ? 'bi-chevron-down' : 'bi-chevron-up'}"></i>
            </button>
            <div>
              <div class="ag-group-title">${escapeHtml(ag.grupo || 'Grupo não definido')}</div>
              <div class="group-id-line">${escapeHtml(ag.grupoId || 'sem ID salvo')}</div>
              <div class="muted small">${escapeHtml(ag.horario)} · ${escapeHtml(daysToText(ag.diasSemana))}</div>
              <div class="next-run small"><i class="bi bi-alarm"></i> ${escapeHtml(nextRunText(ag))}</div>
            </div>
          </div>
          <span class="status-mini ${ag.ativo ? 'active' : 'inactive'}">
            <i class="bi ${ag.ativo ? 'bi-circle-fill' : 'bi-exclamation-circle-fill'}"></i>
            ${ag.ativo ? 'Ativo' : 'Inativo'}
          </span>
        </div>

        <div class="ag-body">
          <div class="row g-3">
            <div class="col-lg-4">
              <label class="form-label">Grupo</label>
              <select class="form-select" onchange="updateAgGroupById(${i}, this.value)">
                ${groupSelectOptions(ag.grupoId, ag.grupo)}
              </select>
              <div class="group-select-help">${escapeHtml(ag.grupoId || 'selecione o grupo para salvar o ID real')}</div>
            </div>
            <div class="col-lg-3">
              <label class="form-label">Horário de Brasília</label>
              <input class="form-control" type="time" value="${escapeHtml(ag.horario)}" oninput="updateAg(${i}, 'horario', this.value)">
            </div>
            <div class="col-lg-3">
              <label class="form-label">Status</label>
              <select class="form-select" onchange="updateAg(${i}, 'ativo', this.value === 'true')">
                <option value="false" ${!ag.ativo ? 'selected' : ''}>Inativo</option>
                <option value="true" ${ag.ativo ? 'selected' : ''}>Ativo</option>
              </select>
            </div>
            <div class="col-lg-2 d-flex align-items-end gap-2">
              <button class="btn btn-soft w-50" onclick="duplicateAg(${i})" title="Duplicar"><i class="bi bi-files"></i></button>
              <button class="btn btn-danger-soft w-50" onclick="removeAg(${i})" title="Excluir"><i class="bi bi-trash3"></i></button>
            </div>
            <div class="col-12">
              <label class="form-label">Dias da semana</label>
              <div class="days-grid">
                ${dayLabels.map(d => `
                  <label class="day-check">
                    <input type="checkbox" ${ag.diasSemana.includes(d.id) ? 'checked' : ''} onchange="toggleDay(${i}, ${d.id}, this.checked)">
                    <span>${d.label}</span>
                  </label>
                `).join('')}
              </div>
            </div>
            <div class="col-lg-6">
              <label class="form-label">Mensagem</label>
              <div class="format-toolbar">
                <button type="button" class="btn btn-soft btn-sm" onclick="wrapTextareaSelection('ag-msg-${i}','*','*')"><i class="bi bi-type-bold"></i></button>
                <button type="button" class="btn btn-soft btn-sm" onclick="wrapTextareaSelection('ag-msg-${i}','_','_')"><i class="bi bi-type-italic"></i></button>
                <button type="button" class="btn btn-soft btn-sm" onclick="wrapTextareaSelection('ag-msg-${i}','~','~')"><i class="bi bi-type-strikethrough"></i></button>
                <button type="button" class="btn btn-soft btn-sm" onclick="wrapTextareaSelection('ag-msg-${i}','\`\`\`','\`\`\`')"><i class="bi bi-code-slash"></i></button>
                <button type="button" class="btn btn-soft btn-sm" onclick="insertAtCursor('ag-msg-${i}','{{saudacao}}')">Saudação</button>
                <button type="button" class="btn btn-soft btn-sm" onclick="insertAtCursor('ag-msg-${i}','{{data}}')">Data</button>
                <button type="button" class="btn btn-soft btn-sm" onclick="insertAtCursor('ag-msg-${i}','{{grupo}}')">Grupo</button>
                <button type="button" class="btn btn-soft btn-sm" onclick="openUsePredefModal('ag-msg-${i}')"><i class="bi bi-card-text"></i> Usar predefinida</button>
              </div>
              <textarea id="ag-msg-${i}" class="form-control" rows="6" placeholder="Mensagem a enviar" oninput="updateAg(${i}, 'mensagem', this.value); updateAgPreview(${i})">${escapeHtml(ag.mensagem)}</textarea>
            </div>
            <div class="col-lg-6">
              <label class="form-label">Preview da mensagem</label>
              <div class="whatsapp-preview">
                <div class="wa-top"><div class="wa-avatar"><i class="bi bi-people-fill"></i></div><div><div class="fw-bold" id="ag-preview-grupo-${i}">${escapeHtml(ag.grupo || 'Grupo')}</div><div class="small muted">agendado às ${escapeHtml(ag.horario)}</div><div class="group-id-line">${escapeHtml(ag.grupoId || 'sem ID')}</div></div></div>
                <div class="wa-chat"><div class="wa-bubble" id="ag-preview-${i}">${renderMessagePreview(ag.mensagem, ag.grupo)}</div></div>
              </div>
              <div class="mono muted small mt-2">Cron gerado: <span id="cron-${i}">${escapeHtml(ag.cron)}</span></div>
              <div class="d-flex gap-2 flex-wrap mt-2">
                <button class="btn btn-soft btn-sm" onclick="sendAgNow(${i})"><i class="bi bi-send"></i> Enviar agora este agendamento</button>
                <button class="btn btn-wa btn-sm" onclick="saveOneAg(${i})"><i class="bi bi-save"></i> Salvar este</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function daysToText(days) {
  const arr = Array.isArray(days) ? days : [];
  if (arr.length === 7) return 'Todos os dias';
  if (!arr.length) return 'Sem dias selecionados';
  return arr.map(id => dayLabels.find(d => d.id === Number(id))?.label).filter(Boolean).join(', ');
}

function toggleAgCollapse(id) {
  expandedAgs.has(id) ? expandedAgs.delete(id) : expandedAgs.add(id);
  renderAgs();
}

function renderMessagePreview(msg, grupo = '') {
  const clean = sanitizeClientMessage(applyVariablesClient(msg, grupo));
  if (!clean) return '<span class="wa-empty">A mensagem aparecerá aqui...</span>';
  return `${renderWhatsAppFormatting(clean)}<div class="wa-time">${new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}</div>`;
}

function updateAg(i, key, val) {
  config.agendamentos[i][key] = val;
  config.agendamentos[i] = normalizeAg(config.agendamentos[i]);
  const cronEl = document.getElementById(`cron-${i}`);
  if (cronEl) cronEl.textContent = config.agendamentos[i].cron;
  const item = document.getElementById(`ag-${config.agendamentos[i].id}`);
  if (item && key === 'ativo') item.classList.toggle('active', val);
  if (key === 'grupo') {
    const g = document.getElementById(`ag-preview-grupo-${i}`);
    if (g) g.textContent = val || 'Grupo';
  }
  if (['ativo','diasSemana'].includes(key)) renderAgs();
}

function toggleDay(i, day, checked) {
  const days = new Set(config.agendamentos[i].diasSemana || []);
  checked ? days.add(day) : days.delete(day);
  config.agendamentos[i].diasSemana = [...days].sort((a,b) => a-b);
  updateAg(i, 'diasSemana', config.agendamentos[i].diasSemana);
}

function updateAgPreview(i) {
  const prev = document.getElementById(`ag-preview-${i}`);
  if (prev) prev.innerHTML = renderMessagePreview(config.agendamentos[i].mensagem, config.agendamentos[i].grupo);
}

function addAg() {
  const id = Date.now();
  config.agendamentos.push({ id, grupo: '', grupoId: '', mensagem: '', horario: '08:00', diasSemana: [1,2,3,4,5], cron: '0 8 * * 1,2,3,4,5', ativo: false });
  expandedAgs.add(id);
  renderAgs();

  setTimeout(() => {
    const card = document.getElementById(`ag-${id}`);

    if (card) {
      card.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });

      const firstField =
        card.querySelector('select') ||
        card.querySelector('input') ||
        card.querySelector('textarea');

      if (firstField) {
        firstField.focus();
      }
    }
  }, 150);
}

function duplicateAg(i) {
  const ag = normalizeAg(config.agendamentos[i]);
  const id = Date.now();
  config.agendamentos.splice(i + 1, 0, { ...ag, id, ativo: false });
  expandedAgs.add(id);
  renderAgs();
}

function removeAg(i) {
  config.agendamentos.splice(i, 1);
  renderAgs();
}

function setAllActive(active) {
  config.agendamentos = config.agendamentos.map(ag => normalizeAg({ ...ag, ativo: active }));
  renderAgs();
  showToast(active ? 'Todos ativados' : 'Todos pausados');
}

function validateConfig() {
  const errors = [];
  config.agendamentos.forEach((agRaw, index) => {
    const ag = normalizeAg(agRaw);
    const hasAnyContent = ag.grupo || ag.mensagem || ag.ativo;
    if (!hasAnyContent) return;
    if (ag.ativo && !ag.grupo) errors.push(`#${index + 1}: grupo vazio`);
    if (ag.ativo && grupos.length && !ag.grupoId) errors.push(`#${index + 1}: selecione o grupo pela lista para salvar o ID real`);
    if (ag.ativo && !ag.mensagem) errors.push(`#${index + 1}: mensagem vazia`);
    if (!ag.horario || !/^\d{2}:\d{2}$/.test(ag.horario)) errors.push(`#${index + 1}: horário inválido`);
    if (ag.ativo && !ag.diasSemana.length) errors.push(`#${index + 1}: nenhum dia selecionado`);
  });
  return errors;
}


async function saveOneAg(i) {
  config.agendamentos[i] = normalizeAg(config.agendamentos[i]);
  const ag = config.agendamentos[i];
  const errors = [];
  if (ag.ativo && !ag.grupo) errors.push('grupo vazio');
  if (ag.ativo && grupos.length && !ag.grupoId) errors.push('selecione o grupo pela lista para salvar o ID real');
  if (ag.ativo && !ag.mensagem) errors.push('mensagem vazia');
  if (!ag.horario || !/^\d{2}:\d{2}$/.test(ag.horario)) errors.push('horário inválido');
  if (ag.ativo && !ag.diasSemana.length) errors.push('nenhum dia selecionado');
  if (errors.length) {
    alert('Corrija este agendamento antes de salvar:\n\n' + errors.join('\n'));
    return;
  }
  const r = await fetch('/api/agendamento', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(ag) });
  const d = await r.json().catch(() => ({ ok:false, msg:'Resposta inválida do servidor' }));
  if (!r.ok || d.ok === false) {
    alert(d.msg || 'Erro ao salvar este agendamento. Veja os logs.');
    return;
  }
  if (d.config?.agendamentos) config.agendamentos = d.config.agendamentos.map(normalizeAg);
  expandedAgs.delete(ag.id);
  renderAgs();
  showToast('Agendamento salvo');
}

async function saveConfig() {
  config.agendamentos = config.agendamentos.map(normalizeAg);
  const errors = validateConfig();
  if (errors.length) {
    alert('Corrija antes de salvar:\n\n' + errors.join('\n'));
    return;
  }
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  const d = await r.json().catch(() => ({ ok: false, msg: 'Resposta inválida do servidor' }));
  if (!r.ok || d.ok === false) {
    alert(d.msg || 'Erro ao salvar configurações. Veja os logs.');
    return;
  }
  expandedAgs.clear();
  renderAgs();
  showToast('Configurações salvas');
}

function updateManualPreview() {
  const msg = document.getElementById('manual-msg').value;
  const { grupo } = getManualGroup();
  const nome = grupo || 'Grupo';
  document.getElementById('manual-preview-grupo').textContent = nome;
  document.getElementById('manual-preview').innerHTML = renderMessagePreview(msg, nome);
}

function dispatchInput(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function wrapTextareaSelection(id, before, after) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const selected = el.value.slice(start, end) || 'texto';
  el.value = el.value.slice(0, start) + before + selected + after + el.value.slice(end);
  el.focus();
  el.selectionStart = start + before.length;
  el.selectionEnd = start + before.length + selected.length;
  dispatchInput(el);
}

function insertAtCursor(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
  dispatchInput(el);
}

document.getElementById('manual-msg').addEventListener('input', updateManualPreview);


async function enviarManual() {
  const { grupo, grupoId } = getManualGroup();
  const mensagem = document.getElementById('manual-msg').value.trim();
  const result = document.getElementById('send-result');
  const btn = document.getElementById('btn-send');

  if (!grupo || !mensagem) {
    result.className = 'alert alert-danger mt-3 mb-0';
    result.classList.remove('d-none');
    result.textContent = 'Preencha o grupo e a mensagem.';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Aguardando conexão/envio...';

  const r = await fetch('/api/enviar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grupo, grupoId, mensagem }) });
  const d = await r.json();

  result.classList.remove('d-none');
  if (d.ok) {
    result.className = 'alert alert-success mt-3 mb-0';
    result.textContent = 'Mensagem enviada com sucesso.';
    document.getElementById('manual-msg').value = '';
    updateManualPreview();
  } else {
    result.className = 'alert alert-danger mt-3 mb-0';
    result.textContent = d.msg || 'Erro ao enviar.';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-send-fill"></i> Enviar agora';
}

async function sendAgNow(i) {
  const ag = normalizeAg(config.agendamentos[i]);
  if (!ag.grupo || !ag.mensagem) {
    alert('Este agendamento precisa de grupo e mensagem.');
    return;
  }
  const r = await fetch('/api/enviar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grupo: ag.grupo, grupoId: ag.grupoId, mensagem: ag.mensagem }) });
  const d = await r.json().catch(() => ({ ok:false, msg:'Resposta inválida' }));
  showToast(d.ok ? 'Mensagem do agendamento enviada' : (d.msg || 'Erro ao enviar'));
}

async function sessionAction(action) {
  const map = { save: '/api/session/save', restore: '/api/session/restore', delete: '/api/session/delete', restart: '/api/session/restart' };
  const labels = { save: 'Salvando sessão...', restore: 'Restaurando sessão...', delete: 'Excluindo sessão...', restart: 'Atualizando sessão e grupos...' };
  const box = document.getElementById('session-result');
  box.className = 'alert alert-info';
  box.textContent = labels[action];
  box.classList.remove('d-none');

  try {
    const r = await fetch(map[action], { method: 'POST' });
    const raw = await r.text();
    let d;
    try { d = JSON.parse(raw); } catch { d = { ok:false, msg: raw || `HTTP ${r.status}` }; }
    if (!r.ok && d.ok !== true) d.ok = false;

    box.className = d.ok ? 'alert alert-success' : 'alert alert-danger';
    box.textContent = d.msg || (d.ok ? 'Operação concluída.' : `Falha na operação. HTTP ${r.status}`);
    if (d.ok) {
      showToast(d.msg || 'Operação concluída');
      if (action === 'restart') setTimeout(loadGrupos, 6000);
    }
  } catch (e) {
    box.className = 'alert alert-danger';
    box.textContent = `Falha de rede ou servidor indisponível: ${e.message}`;
  }
}

function openPairingModal() {
  document.getElementById('pairing-phone').value = '';
  document.getElementById('pairing-result').classList.add('d-none');
  document.getElementById('pairing-error').classList.add('d-none');
  document.getElementById('btn-pairing-submit').disabled = false;
  document.getElementById('btn-pairing-submit').innerHTML = '<i class="bi bi-send"></i> Gerar código';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('pairingModal')).show();
  setTimeout(() => document.getElementById('pairing-phone').focus(), 300);
}

async function gerarPairingCode() {
  const phone = document.getElementById('pairing-phone').value.replace(/\D/g, '');
  const btn = document.getElementById('btn-pairing-submit');
  const error = document.getElementById('pairing-error');
  const result = document.getElementById('pairing-result');

  if (!phone || phone.length < 10 || phone.length > 15) {
    error.className = 'alert alert-danger';
    error.textContent = 'Número inválido. Digite o número com DDD e código do país (ex: 5511999999999).';
    error.classList.remove('d-none');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Gerando...';
  error.classList.add('d-none');
  result.classList.add('d-none');

  try {
    const r = await fetch('/api/pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) {
