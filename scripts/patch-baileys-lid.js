'use strict';

// Patch defensivo para builds que ainda tragam o bug de grupos LID.
// Se a versão instalada já possuir a correção, este script não altera nada.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(root, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-send.js'),
  path.join(root, 'node_modules', 'baileys', 'lib', 'Socket', 'messages-send.js'),
];

function patchFile(file) {
  if (!fs.existsSync(file)) return false;
  let code = fs.readFileSync(file, 'utf8');
  if (code.includes('participantsUseLid')) {
    console.log(`[patch-baileys-lid] já aplicado: ${file}`);
    return true;
  }

  let changed = false;
  const old1 = 'if (!participant) {\n        const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];';
  const new1 = 'let participantsUseLid = false;\n    if (!participant) {\n        const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];\n        participantsUseLid = participantsList.some(p => String(p || "").endsWith("@lid"));';
  if (code.includes(old1)) {
    code = code.replace(old1, new1);
    changed = true;
  }

  const exactPairs = [
    ["isLid ? 'lid' : 's.whatsapp.net', d.device", "(isLid || participantsUseLid) ? 'lid' : 's.whatsapp.net', d.device"],
    ["(0, WABinary_1.jidEncode)(user, isLid ? 'lid' : 's.whatsapp.net', device)", "(0, WABinary_1.jidEncode)(user, (isLid || participantsUseLid) ? 'lid' : 's.whatsapp.net', device)"],
  ];
  for (const [from, to] of exactPairs) {
    if (code.includes(from)) {
      code = code.split(from).join(to);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file + '.bak', fs.readFileSync(file));
    fs.writeFileSync(file, code);
    console.log(`[patch-baileys-lid] patch aplicado: ${file}`);
    return true;
  }
  console.log(`[patch-baileys-lid] nenhum padrão antigo encontrado; mantendo arquivo: ${file}`);
  return false;
}

try {
  const ok = targets.some(patchFile);
  if (!ok) console.log('[patch-baileys-lid] arquivo do Baileys não encontrado ou patch não necessário.');
} catch (err) {
  console.log(`[patch-baileys-lid] aviso: ${err.message}`);
}
