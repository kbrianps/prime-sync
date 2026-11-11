/* popup.js — configurações do Prime Sync */
(() => {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0, 1
  const DEFAULTS = { enabled: true, room: '', showOverlay: true, name: '' };

  const els = {
    room: document.getElementById('room'),
    name: document.getElementById('name'),
    enabled: document.getElementById('enabled'),
    showOverlay: document.getElementById('showOverlay'),
    status: document.getElementById('status'),
    broker: document.getElementById('broker'),
    generate: document.getElementById('generate'),
    copy: document.getElementById('copy'),
    leave: document.getElementById('leave'),
    ok: document.getElementById('ok'),
  };

  let settings = Object.assign({}, DEFAULTS);

  function generateRoom() {
    let out = '';
    for (let i = 0; i < 6; i += 1) {
      out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return out;
  }

  function normalize(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12);
  }

  function save() {
    chrome.storage.local.set({ settings });
  }

  function renderStatus(info) {
    const map = {
      connected: ['conectado', 'on'],
      connecting: ['conectando…', ''],
      offline: ['offline', 'off'],
      idle: ['desligado', 'off'],
    };
    const entry = map[info.status] || map.idle;
    els.status.textContent = entry[0];
    els.status.className = 'status ' + entry[1];
    els.broker.textContent = info.broker
      ? info.broker.replace(/^wss:\/\//, '').replace(/\/mqtt$/, '')
      : '';
  }

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'get-status' }, (info) => {
      if (chrome.runtime.lastError || !info) return;
      renderStatus(info);
    });
  }

  chrome.storage.local.get(['settings'], (result) => {
    if (result && result.settings) {
      settings = Object.assign(settings, result.settings);
    }
    els.room.value = settings.room || '';
    els.name.value = settings.name || '';
    els.enabled.checked = settings.enabled !== false;
    els.showOverlay.checked = settings.showOverlay !== false;
    refreshStatus();
  });

  els.room.addEventListener('input', () => {
    const value = normalize(els.room.value);
    els.room.value = value;
    settings.room = value;
    save();
    refreshStatus();
  });

  els.generate.addEventListener('click', () => {
    const room = generateRoom();
    els.room.value = room;
    settings.room = room;
    settings.enabled = true;
    els.enabled.checked = true;
    save();
    refreshStatus();
  });

  els.copy.addEventListener('click', () => {
    if (!settings.room) return;
    navigator.clipboard.writeText(settings.room);
    const original = els.copy.textContent;
    els.copy.textContent = 'Copiado!';
    setTimeout(() => {
      els.copy.textContent = original;
    }, 1200);
  });

  let nameTimer = null;
  els.name.addEventListener('input', () => {
    settings.name = els.name.value.slice(0, 24);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(save, 300);
  });

  els.enabled.addEventListener('change', () => {
    settings.enabled = els.enabled.checked;
    save();
    refreshStatus();
  });

  els.showOverlay.addEventListener('change', () => {
    settings.showOverlay = els.showOverlay.checked;
    save();
  });

  els.ok.addEventListener('click', () => {
    window.close(); // fecha o popup da extensão
  });

  // Enter no campo do nome também fecha, como um "salvar e sair".
  els.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') window.close();
  });

  els.leave.addEventListener('click', () => {
    if (!settings.room) {
      els.status.textContent = 'sem sala';
      return;
    }
    const ok = confirm(
      'Sair da sala ' +
        settings.room +
        '?\n\nO chat será limpo e a sincronização para. Para voltar, é só usar o mesmo código de novo.'
    );
    if (!ok) return;
    settings.room = '';
    els.room.value = '';
    save();
    refreshStatus();
  });

  setInterval(refreshStatus, 1500);
})();
