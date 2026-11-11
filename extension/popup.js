/* popup.js — configurações do Prime Sync */
(() => {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0, 1
  const PUBLIC_BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const DEFAULTS = {
    enabled: true,
    room: '',
    showOverlay: true,
    name: '',
    broker: '',
    username: '',
    password: '',
    lang: 'en',
  };

  const els = {
    room: document.getElementById('room'),
    name: document.getElementById('name'),
    enabled: document.getElementById('enabled'),
    showOverlay: document.getElementById('showOverlay'),
    status: document.getElementById('status'),
    version: document.getElementById('version'),
    server: document.getElementById('server'),
    broker: document.getElementById('broker'),
    brokerUrl: document.getElementById('brokerUrl'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    serverHint: document.getElementById('serverHint'),
    suggest: document.getElementById('suggest'),
    usePublic: document.getElementById('usePublic'),
    publicWarn: document.getElementById('publicWarn'),
    generate: document.getElementById('generate'),
    copy: document.getElementById('copy'),
    leave: document.getElementById('leave'),
    ok: document.getElementById('ok'),
    langButtons: document.querySelectorAll('[data-lang]'),
  };

  let settings = Object.assign({}, DEFAULTS);
  let leaveTimer = null;
  let lastInfo = { status: 'idle' };

  function L(key, vars) {
    return globalThis.PrimeSyncI18n.t(settings.lang, key, vars);
  }

  function applyLanguage() {
    document.documentElement.lang = settings.lang === 'pt' ? 'pt-BR' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = L(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      el.innerHTML = L(el.dataset.i18nHtml);
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      el.title = L(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      el.placeholder = L(el.dataset.i18nPlaceholder);
    }
    for (const button of els.langButtons) {
      button.classList.toggle('active', button.dataset.lang === settings.lang);
    }
    resetLeave();
    renderBroker();
    renderStatus(lastInfo);
  }

  function generateRoom() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function normalize(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12);
  }

  function isValidBroker(url) {
    return /^wss?:\/\/[^\s/]+/i.test(String(url || '').trim());
  }

  function brokerHost(url) {
    return String(url || '')
      .trim()
      .replace(/^wss?:\/\//i, '')
      .replace(/\/.*$/, '');
  }

  function save() {
    chrome.storage.local.set({ settings });
  }

  function setStatus(text, tone) {
    els.status.className = 'status ' + (tone || '');
    els.status.querySelector('b').textContent = text;
  }

  function renderStatus(info) {
    lastInfo = info;
    if (!settings.enabled) return setStatus(L('off'), '');
    if (!isValidBroker(settings.broker)) return setStatus(L('noServer'), 'wait');
    if (!settings.room) return setStatus(L('noRoom'), 'wait');

    const map = {
      connected: [L('connected'), 'on'],
      connecting: [L('connecting'), 'wait'],
      offline: [L('offline'), 'off'],
      idle: [L('off'), ''],
    };
    const entry = map[info.status] || map.idle;
    setStatus(entry[0], entry[1]);

    if (info.error === 'auth') {
      showServerHint(L('authError'), true);
    } else if (info.error === 'unreachable' && info.status !== 'connected') {
      showServerHint(L('unreachable'), true);
    } else {
      showServerHint(L('serverHint'), false);
    }
  }

  function showServerHint(text, isError) {
    els.serverHint.textContent = text;
    els.serverHint.classList.toggle('error', isError);
    if (isError) els.server.open = true;
  }

  function renderBroker() {
    const valid = isValidBroker(settings.broker);
    els.broker.textContent = valid ? brokerHost(settings.broker) : L('notConfigured');
    els.broker.classList.toggle('missing', !valid);
    els.brokerUrl.classList.toggle(
      'invalid',
      Boolean(settings.broker) && !valid
    );
    const isPublic = brokerHost(settings.broker) === brokerHost(PUBLIC_BROKER);
    els.publicWarn.hidden = !isPublic;
    els.suggest.hidden = valid;
  }

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'get-status' }, (info) => {
      if (chrome.runtime.lastError || !info) return;
      renderStatus(info);
    });
  }

  function debounced(fn, wait) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  els.version.textContent = 'v' + chrome.runtime.getManifest().version;

  chrome.storage.local.get(['settings'], (result) => {
    if (result && result.settings) {
      settings = Object.assign(settings, result.settings);
    }
    els.room.value = settings.room || '';
    els.name.value = settings.name || '';
    els.brokerUrl.value = settings.broker || '';
    els.username.value = settings.username || '';
    els.password.value = settings.password || '';
    els.enabled.checked = settings.enabled !== false;
    els.showOverlay.checked = settings.showOverlay !== false;
    els.server.open = !isValidBroker(settings.broker);
    applyLanguage();
    refreshStatus();
  });

  for (const button of els.langButtons) {
    button.addEventListener('click', () => {
      settings.lang = button.dataset.lang;
      save();
      applyLanguage();
    });
  }

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
    navigator.clipboard.writeText(settings.room).catch(() => {});
    els.copy.classList.add('done');
    els.copy.title = L('copied');
    setTimeout(() => {
      els.copy.classList.remove('done');
      els.copy.title = L('copyCode');
    }, 1200);
  });

  const saveName = debounced(save, 300);
  els.name.addEventListener('input', () => {
    settings.name = els.name.value.slice(0, 24);
    saveName();
  });

  const saveServer = debounced(() => {
    settings.broker = els.brokerUrl.value.trim();
    settings.username = els.username.value.trim();
    settings.password = els.password.value;
    renderBroker();
    if (settings.broker && !isValidBroker(settings.broker)) return;
    save();
    refreshStatus();
  }, 700);

  for (const input of [els.brokerUrl, els.username, els.password]) {
    input.addEventListener('input', saveServer);
  }

  els.usePublic.addEventListener('click', () => {
    els.brokerUrl.value = PUBLIC_BROKER;
    els.username.value = '';
    els.password.value = '';
    settings.broker = PUBLIC_BROKER;
    settings.username = '';
    settings.password = '';
    renderBroker();
    save();
    refreshStatus();
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

  function resetLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    els.leave.classList.remove('confirm');
    els.leave.textContent = L('leaveRoom');
  }

  els.leave.addEventListener('click', () => {
    if (!settings.room) {
      setStatus(L('noRoom'), 'wait');
      return;
    }
    if (!leaveTimer) {
      els.leave.classList.add('confirm');
      els.leave.textContent = L('confirmLeave');
      leaveTimer = setTimeout(resetLeave, 3500);
      return;
    }
    resetLeave();
    settings.room = '';
    els.room.value = '';
    save();
    refreshStatus();
  });

  setInterval(refreshStatus, 1500);
})();
