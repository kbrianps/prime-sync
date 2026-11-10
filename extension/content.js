/*
 * content.js — Prime Sync.
 * Encontra o <video> do player, publica o estado local, aplica o estado remoto
 * de forma suave e mantém a barra lateral de chat da sala.
 */
(() => {
  'use strict';

  const WHO = 'c' + Math.random().toString(36).slice(2, 10);
  const TICK_PLAYING = 2500;
  const TICK_IDLE = 4000;

  // Correção de posição
  const TOLERANCE_PLAYING = 0.6; // até aqui, deixa como está
  const TOLERANCE_PAUSED = 0.4;
  const HARD_SEEK_AFTER = 1.6; // acima disso, reposiciona
  const SEEK_COOLDOWN_MS = 4000; // depois de um seek, deixa o player respirar
  const RATE_MAX = 0.08; // aceleração/desaceleração máxima (8%)
  const CORRECTION_MS = 15000; // teto para voltar a 1x

  const LOCAL_PRIORITY_MS = 700; // janela em que uma ação local vence
  const UI_GUARD_MS = 400; // clique/tecla no chat não pode mexer no player

  const CHAT_MAX = 500;
  const CHAT_HISTORY = 200;
  const MIN_PANEL_HEIGHT = 140;

  const state = {
    settings: { enabled: true, room: '', showOverlay: true, name: '' },
    port: null,
    video: null,
    status: 'idle',
    applying: false,
    lastSend: 0,
    seq: 0,
    localPriorityUntil: 0,
    peers: new Map(), // who -> { seq, lastSeenAt, slow, name }
    lastStallAt: 0,
    peerSlowNotified: false,
    drift: 0,
    remoteTitle: '',
    root: null,
    overlay: null,
    toastTimer: null,
    priorityTimer: null,

    // correção suave
    buffering: false,
    correcting: false,
    correctingTimer: null,
    correctionUntil: 0,
    cooldownUntil: 0,
    userRate: 1,

    // interferência do player em cliques/teclas do chat
    lastUiEventAt: 0,
    reverting: false,
    revertTimer: null,

    chat: {
      open: false,
      minimized: false,
      unread: 0,
      messages: [],
      seen: new Set(),
      seq: 0,
      lastSend: 0,
      panel: null,
      list: null,
      input: null,
      badge: null,
    },
  };

  let guardTimer = null;

  /* ------------------------------------------------------------- helpers */

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  function shortTitle() {
    return String(document.title || '')
      .replace(/\s*[|\-–]\s*(Amazon )?Prime Video.*$/i, '')
      .replace(/\s*[|\-–]\s*Amazon\.\w+.*$/i, '')
      .trim()
      .slice(0, 120);
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function guard(action) {
    state.applying = true;
    try {
      action();
    } catch (err) {
      /* ignorado */
    }
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      state.applying = false;
    }, 500);
  }

  /*
   * Depois de uma ação local (play/pause/seek), mensagens do parceiro que
   * saíram antes dela chegam atrasadas e puxariam o vídeo de volta. Durante
   * essa janela elas são ignoradas; o próximo tick (<=4s) recoloca tudo em dia.
   */
  function markLocalAction() {
    state.localPriorityUntil = Date.now() + LOCAL_PRIORITY_MS;
    clearTimeout(state.priorityTimer);
    state.priorityTimer = setTimeout(() => {
      state.localPriorityUntil = 0;
    }, LOCAL_PRIORITY_MS);
  }

  function copy(text) {
    try {
      navigator.clipboard.writeText(text);
    } catch (err) {
      /* ignorado */
    }
  }

  /* -------------------------------------------------- correção de posição */

  function setPlaybackRate(video, rate) {
    const value = Math.round(rate * 1000) / 1000;
    if (Math.abs(video.playbackRate - value) < 0.004) return;
    state.correcting = true; // silencia o ratechange para não virar eco
    try {
      video.playbackRate = value;
    } catch (err) {
      /* ignorado */
    }
    clearTimeout(state.correctingTimer);
    state.correctingTimer = setTimeout(() => {
      state.correcting = false;
    }, 200);
  }

  function restoreRate(video) {
    state.correctionUntil = 0;
    const base = state.userRate || 1;
    if (Math.abs(video.playbackRate - base) >= 0.004) {
      setPlaybackRate(video, base);
    }
  }

  /*
   * Para diferenças pequenas, acelerar/desacelerar um pouco é invisível e não
   * rebufferiza — mil vezes melhor que ficar dando seek.
   */
  function smoothRate(video, drift) {
    const base = state.userRate || 1;
    const delta = Math.max(-RATE_MAX, Math.min(RATE_MAX, drift / 6));
    setPlaybackRate(video, base + delta);
    state.correctionUntil = Date.now() + CORRECTION_MS;
  }

  function applyRemoteRate(video, rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return;
    if (Math.abs(value - (state.userRate || 1)) < 0.01) return;
    state.userRate = value;
    setPlaybackRate(video, value);
  }

  function canSeekTo(video, time) {
    if (!Number.isFinite(time) || time < 0) return false;
    const duration = video.duration;
    if (Number.isFinite(duration) && duration > 0 && time > duration - 0.4) {
      return false;
    }
    const ranges = video.seekable;
    if (!ranges || !ranges.length) return true;
    for (let i = 0; i < ranges.length; i += 1) {
      if (time >= ranges.start(i) - 1 && time <= ranges.end(i) + 1) return true;
    }
    return false;
  }

  function hardSeek(video, time) {
    if (!canSeekTo(video, time)) return;
    restoreRate(video);
    guard(() => {
      video.currentTime = time;
    });
    state.cooldownUntil = Date.now() + SEEK_COOLDOWN_MS;
  }

  /* ------------------------------------------------------- saúde da rede */

  function isLocalSlow() {
    if (state.buffering) return true;
    return state.lastStallAt > 0 && Date.now() - state.lastStallAt < 8000;
  }

  // Aviso imediato de "comecei a travar" / "voltei".
  function sendHealth() {
    if (!state.port || !state.settings.enabled || !state.settings.room) return;
    state.seq += 1;
    state.port.postMessage({
      type: 'publish',
      payload: {
        kind: 'health',
        who: WHO,
        seq: state.seq,
        ts: Date.now(),
        name: (state.settings.name || '').slice(0, 24),
        slow: isLocalSlow(),
      },
    });
  }

  function peerHealth() {
    const now = Date.now();
    let slow = false;
    let name = '';
    let lastSeen = 0;

    for (const peer of state.peers.values()) {
      if (!peer.lastSeenAt) continue;
      if (peer.lastSeenAt > lastSeen) lastSeen = peer.lastSeenAt;
      if (peer.slow && now - peer.lastSeenAt < 15000) {
        slow = true;
        if (!name) name = peer.name || '';
      }
    }

    if (!name) {
      for (const peer of state.peers.values()) {
        if (peer.name) name = peer.name;
      }
    }

    const silent =
      lastSeen > 0 && now - lastSeen > 25000 && now - lastSeen < 5 * 60000;
    return { slow, silent, name, lastSeen };
  }

  function checkPeerHealth() {
    const remote = peerHealth();
    if (remote.slow && !state.peerSlowNotified) {
      state.peerSlowNotified = true;
      showToast((remote.name || 'Seu parceiro') + ' está com a internet ruim.');
    } else if (!remote.slow) {
      state.peerSlowNotified = false;
    }
  }

  function renderNet() {
    const pill = state.overlay;
    if (!pill) return;
    const netEl = pill.querySelector('.ps-net');
    if (!netEl) return;

    const remote = peerHealth();
    let text = '';
    let tone = 'warn';

    if (isLocalSlow()) {
      text = '⚠ sua conexão';
    } else if (remote.silent) {
      text = '⚠ ' + (remote.name || 'parceiro') + ' sem sinal';
      tone = 'off';
    } else if (remote.slow) {
      text = '⚠ ' + (remote.name || 'parceiro') + ' lenta';
    }

    netEl.textContent = text;
    netEl.dataset.tone = tone;
    netEl.style.display = text ? 'inline-block' : 'none';
  }

  /* --------------------------------------------------------------- raiz */

  function getRoot() {
    if (state.root && state.root.isConnected) return state.root;
    const root = document.createElement('div');
    root.id = 'ps-root';
    appendRoot(root);

    // O player do Prime escuta clique/teclado no documento; nada nosso deve
    // vazar para lá (senão clicar no chat pausaria o vídeo).
    for (const event of [
      'click',
      'mousedown',
      'pointerdown',
      'keydown',
      'keyup',
      'keypress',
    ]) {
      root.addEventListener(event, (e) => e.stopPropagation());
    }

    state.root = root;
    return root;
  }

  function appendRoot(root) {
    const target = document.fullscreenElement;
    const usable = target && !(target instanceof HTMLVideoElement);
    (usable ? target : document.body).appendChild(root);
  }

  function moveRootForFullscreen() {
    if (!state.root) return;
    const target = document.fullscreenElement;
    const parent =
      target && !(target instanceof HTMLVideoElement) ? target : document.body;
    if (state.root.parentElement !== parent) parent.appendChild(state.root);
  }

  /*
   * Alguns players escutam clique/tecla em fase de captura no window, o que
   * acontece antes de qualquer stopPropagation nosso. Aqui só marcamos "o
   * usuário mexeu no chat"; a ação indevida é desfeita em reverts().
   */
  function watchUiEvents() {
    const mark = (event) => {
      if (!state.root || !event.target) return;
      if (state.root.contains(event.target)) {
        state.lastUiEventAt = Date.now();
      }
    };
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
      window.addEventListener(type, mark, true);
    }
  }

  function revertInterference() {
    const video = state.video;
    if (!video) return;
    state.reverting = true;
    try {
      if (video.paused && !video.ended) {
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } else {
        video.pause();
      }
    } catch (err) {
      /* ignorado */
    }
    clearTimeout(state.revertTimer);
    state.revertTimer = setTimeout(() => {
      state.reverting = false;
    }, UI_GUARD_MS);
  }

  /* --------------------------------------------------------------- vídeo */

  const EVENTS = [
    'play',
    'pause',
    'seeked',
    'ratechange',
    'ended',
    'playing',
    'waiting',
    'stalled',
    'canplay',
  ];

  function pickVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestScore = -1;

    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 180) continue;
      let score = rect.width * rect.height;
      if (!video.paused) score *= 2;
      if (video.readyState >= 2) score *= 1.2;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function detach() {
    if (!state.video) return;
    for (const event of EVENTS) {
      state.video.removeEventListener(event, onLocalEvent, true);
    }
    state.video = null;
  }

  function attach(video) {
    if (state.video === video) return;
    detach();
    state.video = video;
    state.buffering = false;
    state.cooldownUntil = 0;
    if (!video) return;
    for (const event of EVENTS) {
      video.addEventListener(event, onLocalEvent, true);
    }
  }

  function onLocalEvent(event) {
    const type = event && event.type;

    if (type === 'waiting' || type === 'stalled') {
      const wasBuffering = state.buffering;
      state.buffering = true;
      state.lastStallAt = Date.now();
      if (!wasBuffering) sendHealth();
      return;
    }
    if (type === 'canplay') {
      if (state.buffering) {
        state.buffering = false;
        sendHealth();
      }
      return;
    }
    if (type === 'playing' && state.buffering) {
      state.buffering = false;
      sendHealth();
    }
    if (state.reverting) return;
    if (type === 'ratechange' && state.correcting) return;
    if (state.applying) return;

    // Clique/tecla no chat que acabou mexendo no player: desfaz sem avisar.
    if (
      (type === 'play' || type === 'pause') &&
      Date.now() - state.lastUiEventAt < UI_GUARD_MS
    ) {
      revertInterference();
      return;
    }

    if (type === 'ratechange') state.userRate = state.video.playbackRate || 1;

    markLocalAction();
    sendState('event');
    render();
  }

  /* ------------------------------------------------------------ envio */

  function sendState(kind) {
    const video = state.video;
    if (!video) return;
    if (!state.port || !state.settings.enabled || !state.settings.room) return;

    const now = Date.now();
    if (kind !== 'tick' && now - state.lastSend < 150) return;
    state.lastSend = now;
    state.seq += 1;

    state.port.postMessage({
      type: 'publish',
      payload: {
        kind,
        who: WHO,
        seq: state.seq,
        ts: now,
        t: round(video.currentTime),
        playing: !video.paused && !video.ended,
        rate: state.userRate || 1,
        title: shortTitle(),
        name: (state.settings.name || '').slice(0, 24),
        slow: isLocalSlow(),
      },
    });
  }

  function requestRemoteState() {
    if (!state.port) return;
    if (!state.settings.enabled || !state.settings.room) return;
    state.port.postMessage({ type: 'hello', who: WHO });
  }

  /* --------------------------------------------------------- recebimento */

  function applyRemote(message) {
    if (!message || typeof message !== 'object') return;
    if (message.who === WHO) return;

    // 'hello' pede que a sessão existente se apresente.
    if (message.kind === 'hello') {
      sendState('event');
      return;
    }

    const now = Date.now();

    // Presença e saúde valem mesmo sem vídeo ou durante ação local.
    const seq = Number(message.seq) || 0;
    const peer = state.peers.get(message.who) || { seq: 0 };
    if (seq && seq <= peer.seq) return;
    if (seq) peer.seq = seq;
    peer.lastSeenAt = now;
    if (message.name) peer.name = String(message.name).slice(0, 24);
    if (typeof message.slow === 'boolean') peer.slow = message.slow;
    state.peers.set(message.who, peer);

    if (message.kind === 'health') {
      checkPeerHealth();
      renderNet();
      return;
    }

    const video = state.video;
    if (!video) return;

    // Janela pós-ação local: ignora estados que saíram antes dela.
    if (now < state.localPriorityUntil) return;

    const playing = Boolean(message.playing);
    const expected = Number(message.t);
    if (!Number.isFinite(expected)) return;

    /*
     * Sem depender do relógio do outro computador: `t` é a posição do parceiro
     * no instante em que ele enviou. O atraso de rede entra como drift e fica
     * dentro da tolerância.
     */
    const drift = expected - video.currentTime;
    state.drift = drift;
    state.remoteTitle = message.title || '';

    applyRemoteRate(video, message.rate);

    // Play/pause é intenção pura: aplicar sempre, é barato e não rebufferiza.
    if (playing && (video.paused || video.ended)) {
      guard(() => {
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() =>
            showToast('Clique no player uma vez para liberar o autoplay.')
          );
        }
      });
    } else if (!playing && !video.paused) {
      guard(() => video.pause());
    }

    /*
     * Nunca corrigir posição com o player carregando: é exatamente isso que
     * transforma um buffer ruim num engasgo contínuo.
     */
    if (state.buffering || video.seeking || video.readyState < 3) {
      render();
      return;
    }

    if (!playing) {
      restoreRate(video);
      if (Math.abs(drift) > TOLERANCE_PAUSED) hardSeek(video, expected);
    } else if (Date.now() < state.cooldownUntil) {
      // acabamos de reposicionar: deixa o player se recuperar
    } else if (Math.abs(drift) >= HARD_SEEK_AFTER) {
      hardSeek(video, expected);
    } else if (Math.abs(drift) > TOLERANCE_PLAYING) {
      smoothRate(video, drift);
    } else {
      restoreRate(video);
    }

    render();
  }

  /* ------------------------------------------------------- pílula/estado */

  function buildOverlay() {
    if (state.overlay) return state.overlay;

    const pill = document.createElement('div');
    pill.id = 'ps-pill';
    pill.innerHTML =
      '<span class="ps-dot"></span>' +
      '<span class="ps-label">Prime Sync</span>' +
      '<span class="ps-drift"></span>' +
      '<span class="ps-net"></span>' +
      '<button class="ps-room" title="Copiar código da sala">sem sala</button>' +
      '<button class="ps-sync" title="Puxar a posição do parceiro">Sincronizar</button>' +
      '<button class="ps-chat" title="Abrir chat da sala">Chat<span class="ps-badge"></span></button>' +
      '<button class="ps-hide" title="Esconder">×</button>';

    pill.querySelector('.ps-room').addEventListener('click', () => {
      const room = state.settings.room;
      if (!room) {
        showToast('Abra o ícone do Prime Sync e gere um código de sala.');
        return;
      }
      copy(room);
      showToast('Código copiado: ' + room);
    });

    pill.querySelector('.ps-sync').addEventListener('click', () => {
      requestRemoteState();
      showToast('Pedindo a posição atual do parceiro…');
    });

    pill.querySelector('.ps-chat').addEventListener('click', () => {
      toggleChat();
    });

    pill.querySelector('.ps-hide').addEventListener('click', () => {
      state.settings.showOverlay = false;
      persistSettings();
      pill.classList.add('ps-hidden');
      toggleChat(false);
    });

    getRoot().appendChild(pill);
    state.overlay = pill;
    state.chat.badge = pill.querySelector('.ps-badge');
    return pill;
  }

  function persistSettings() {
    try {
      chrome.storage.local.set({ settings: state.settings });
    } catch (err) {
      /* ignorado */
    }
  }

  function showToast(text) {
    const root = getRoot();
    let toast = root.querySelector('#ps-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ps-toast';
      root.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('ps-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.classList.remove('ps-visible');
    }, 3500);
  }

  function render() {
    const pill = state.overlay;
    if (!pill) return;

    const { enabled, room, showOverlay } = state.settings;
    pill.classList.toggle('ps-hidden', !showOverlay);

    const dot = pill.querySelector('.ps-dot');
    const label = pill.querySelector('.ps-label');
    const roomButton = pill.querySelector('.ps-room');
    const driftEl = pill.querySelector('.ps-drift');

    let color = '#888888';
    let text = 'Prime Sync';

    if (!enabled) {
      color = '#888888';
      text = 'desligado';
    } else if (!room) {
      color = '#c9a227';
      text = 'configure a sala';
    } else if (state.status === 'connected') {
      color = '#26c281';
      text = 'conectado';
    } else if (state.status === 'connecting') {
      color = '#c9a227';
      text = 'conectando…';
    } else {
      color = '#e04f5f';
      text = 'offline';
    }

    dot.style.background = color;
    label.textContent = text;
    roomButton.textContent = room || 'sem sala';

    if (state.drift && Math.abs(state.drift) > 1.2) {
      driftEl.textContent =
        (state.drift > 0 ? '+' : '') + state.drift.toFixed(1) + 's';
      driftEl.style.display = 'inline';
    } else {
      driftEl.style.display = 'none';
    }

    const badge = state.chat.badge;
    if (badge) {
      const unread = state.chat.unread;
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }

    renderNet();

    const sub =
      state.chat.panel && state.chat.panel.querySelector('.ps-panel-sub');
    if (sub) {
      const parts = [];
      if (room) parts.push(room);
      parts.push(
        state.status === 'connected'
          ? 'conectado'
          : state.status === 'connecting'
            ? 'conectando…'
            : 'offline'
      );
      sub.textContent = parts.join(' · ');
    }
  }

  /* ----------------------------------------------------------------- chat */

  function buildPanel() {
    if (state.chat.panel) return state.chat.panel;

    const panel = document.createElement('div');
    panel.id = 'ps-panel';
    panel.innerHTML =
      '<div class="ps-resize" title="Arraste para redimensionar (duplo clique volta ao padrão)"></div>' +
      '<div class="ps-panel-head">' +
      '<span class="ps-panel-title">Chat</span>' +
      '<span class="ps-panel-sub"></span>' +
      '<button class="ps-panel-min" title="Minimizar (só o cabeçalho)">–</button>' +
      '<button class="ps-panel-close" title="Fechar">×</button>' +
      '</div>' +
      '<div class="ps-msgs"></div>' +
      '<form class="ps-compose">' +
      '<textarea class="ps-input" rows="1" maxlength="' +
      CHAT_MAX +
      '" placeholder="Mensagem para a sala…" autocomplete="off" ' +
      'autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>' +
      '<button type="submit" class="ps-send">Enviar</button>' +
      '</form>';

    getRoot().appendChild(panel);

    const list = panel.querySelector('.ps-msgs');
    const input = panel.querySelector('.ps-input');
    const form = panel.querySelector('.ps-compose');
    const head = panel.querySelector('.ps-panel-head');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (sendChat(input.value)) {
        input.value = '';
        input.style.height = '';
      }
      input.focus();
    });

    // Enter envia, Shift+Enter quebra linha.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (sendChat(input.value)) {
          input.value = '';
          input.style.height = '';
        }
      }
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    });

    panel.querySelector('.ps-panel-min').addEventListener('click', () => {
      setMinimized(!state.chat.minimized);
    });

    panel.querySelector('.ps-panel-close').addEventListener('click', () => {
      toggleChat(false);
    });

    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      setMinimized(!state.chat.minimized);
    });

    // Redimensionar livremente: arrasta o pegador do topo (a base fica fixa).
    const grip = panel.querySelector('.ps-resize');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizeDrag = {
        y: e.clientY,
        height: panel.getBoundingClientRect().height,
      };
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignorado */
      }
    });
    grip.addEventListener('dblclick', () => {
      panel.style.height = '';
      persistChatHeight(null);
    });

    try {
      chrome.storage.local.get(['psChatHeight'], (result) => {
        const saved = result && Number(result.psChatHeight);
        if (saved && saved >= MIN_PANEL_HEIGHT) {
          panel.style.height = Math.min(saved, maxPanelHeight()) + 'px';
        }
      });
    } catch (err) {
      /* ignorado */
    }

    state.chat.panel = panel;
    state.chat.list = list;
    state.chat.input = input;
    return panel;
  }

  let resizeDrag = null;

  function maxPanelHeight() {
    return Math.round(window.innerHeight * 0.92);
  }

  function persistChatHeight(height) {
    try {
      if (height == null) chrome.storage.local.remove('psChatHeight');
      else chrome.storage.local.set({ psChatHeight: height });
    } catch (err) {
      /* ignorado */
    }
  }

  function installResize() {
    window.addEventListener('pointermove', (e) => {
      if (!resizeDrag) return;
      const panel = state.chat.panel;
      if (!panel) return;
      const next = Math.min(
        Math.max(resizeDrag.height + (resizeDrag.y - e.clientY), MIN_PANEL_HEIGHT),
        maxPanelHeight()
      );
      panel.style.height = next + 'px';
      if (state.chat.minimized) setMinimized(false);
    });

    window.addEventListener('pointerup', () => {
      if (!resizeDrag) return;
      resizeDrag = null;
      const panel = state.chat.panel;
      if (!panel) return;
      persistChatHeight(Math.round(panel.getBoundingClientRect().height));
    });
  }

  function setMinimized(value) {
    state.chat.minimized = Boolean(value);
    const panel = state.chat.panel;
    if (panel) panel.classList.toggle('ps-min', state.chat.minimized);
    if (!state.chat.minimized && state.chat.open) {
      renderChat(true);
      setTimeout(() => {
        try {
          state.chat.input.focus();
        } catch (err) {
          /* ignorado */
        }
      }, 60);
    }
  }

  function toggleChat(force) {
    const panel = buildPanel();
    state.chat.open = typeof force === 'boolean' ? force : !state.chat.open;
    panel.classList.toggle('ps-open', state.chat.open);
    if (!state.chat.open) setMinimized(false);

    if (state.chat.open) {
      state.chat.unread = 0;
      renderChat(true);
      setTimeout(() => {
        try {
          state.chat.input.focus();
        } catch (err) {
          /* ignorado */
        }
      }, 60);
    }
    render();
  }

  function sendChat(text) {
    const value = String(text || '').trim().slice(0, CHAT_MAX);
    if (!value) return false;

    if (!state.port || state.status !== 'connected') {
      showToast('Sem conexão com a sala. Verifique o código e a internet.');
      return false;
    }

    const now = Date.now();
    if (now - state.chat.lastSend < 350) return false; // anti-spam
    state.chat.lastSend = now;

    const payload = {
      id: WHO + ':' + (state.chat.seq += 1),
      who: WHO,
      name: (state.settings.name || 'Alguém').slice(0, 24),
      text: value,
    };

    state.port.postMessage({ type: 'publish-chat', payload });
    addMessage(payload); // eco local imediato; o eco do broker é deduplicado
    return true;
  }

  function addMessage(message) {
    if (!message || !message.text) return;
    const id = message.id || message.who + ':' + Math.random();
    if (state.chat.seen.has(id)) return;
    state.chat.seen.add(id);

    state.chat.messages.push({
      id,
      mine: message.who === WHO,
      name: String(message.name || 'Parceiro').slice(0, 24),
      text: String(message.text).slice(0, CHAT_MAX),
      time: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    });

    if (state.chat.messages.length > CHAT_HISTORY) {
      const removed = state.chat.messages.shift();
      state.chat.seen.delete(removed.id);
    }

    renderChat();

    if (!state.chat.open && message.who !== WHO) {
      state.chat.unread += 1;
      showToast(message.name + ': ' + truncate(message.text, 70));
    }
    render();
  }

  function renderChat(forceBottom) {
    const list = state.chat.list;
    if (!list) return;

    const atBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 48 ||
      !list.children.length;

    while (list.firstChild) list.removeChild(list.firstChild);

    if (!state.chat.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'ps-empty';
      empty.textContent = 'Nada por aqui ainda. Diga oi.';
      list.appendChild(empty);
      return;
    }

    for (const item of state.chat.messages) {
      const row = document.createElement('div');
      row.className = 'ps-msg' + (item.mine ? ' ps-mine' : '');

      const meta = document.createElement('span');
      meta.className = 'ps-meta';
      meta.textContent = (item.mine ? 'você' : item.name) + ' · ' + item.time;

      const text = document.createElement('span');
      text.className = 'ps-text';
      text.textContent = item.text; // textContent: nada de HTML do parceiro

      row.appendChild(meta);
      row.appendChild(text);
      list.appendChild(row);
    }

    if (atBottom || forceBottom) list.scrollTop = list.scrollHeight;
  }

  /* --------------------------------------------------------------- porta */

  function openPort() {
    closePort();
    try {
      state.port = chrome.runtime.connect({ name: 'primesync' });
    } catch (err) {
      state.port = null;
      return;
    }

    state.port.onMessage.addListener((message) => {
      if (!message) return;
      if (message.type === 'status') {
        state.status = message.status;
        render();
      } else if (message.type === 'remote') {
        applyRemote(message.payload);
      } else if (message.type === 'chat') {
        addMessage(message.payload);
      }
    });

    state.port.onDisconnect.addListener(() => {
      state.port = null;
      state.status = 'offline';
      render();
      setTimeout(() => {
        if (state.settings.enabled && state.settings.room) openPort();
      }, 1500);
    });

    // Se o vídeo já existe (porta reconectou), combina a posição imediatamente.
    if (state.video) requestRemoteState();
  }

  function closePort() {
    if (!state.port) return;
    try {
      state.port.disconnect();
    } catch (err) {
      /* ignorado */
    }
    state.port = null;
  }

  /* ------------------------------------------------------- ciclo de vida */

  function loop() {
    ensureUI();
    renderNet();
    checkPeerHealth();

    const video = pickVideo();
    if (video !== state.video) {
      attach(video);
      if (video) {
        buildOverlay();
        render();
        /*
         * Um player recém-encontrado não é autoridade sobre a sessão: em vez de
         * publicar sua posição (que quase sempre é 0), pede a posição atual do
         * parceiro e se alinha a ela.
         */
        requestRemoteState();
      }
    }

    if (!video) return;

    // rede de segurança: se o 'waiting' nunca foi seguido de 'playing'
    if (state.buffering && video.readyState >= 3) state.buffering = false;

    // desfaz correção de velocidade pendente
    if (state.correctionUntil && Date.now() > state.correctionUntil) {
      restoreRate(video);
    }
    if (video.paused && Math.abs(video.playbackRate - (state.userRate || 1)) >= 0.004) {
      restoreRate(video);
    }

    const playing = !video.paused && !video.ended;
    const interval = playing ? TICK_PLAYING : TICK_IDLE;
    if (Date.now() - state.lastSend >= interval) {
      sendState('tick');
    }
  }

  /*
   * Se o Prime recriar o body (troca de episódio, por exemplo), nossos nós
   * saem do documento. Reconstrói a interface preservando o chat aberto.
   */
  function ensureUI() {
    if (!state.overlay || state.overlay.isConnected) return;
    const wasOpen = state.chat.open;
    const wasMin = state.chat.minimized;
    state.root = null;
    state.overlay = null;
    state.chat.panel = null;
    state.chat.list = null;
    state.chat.input = null;
    state.chat.badge = null;
    buildOverlay();
    if (wasOpen) {
      toggleChat(true);
      setMinimized(wasMin);
    }
    render();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(['settings'], (result) => {
        if (result && result.settings) {
          state.settings = Object.assign({}, state.settings, result.settings);
        }
        if (state.settings.enabled && state.settings.room) openPort();
        render();
      });
    } catch (err) {
      /* extensão recarregada: contexto inválido */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const previousRoom = state.settings.room;
      state.settings = Object.assign(
        {},
        state.settings,
        changes.settings.newValue || {}
      );

      if (state.settings.room !== previousRoom) {
        // Trocar (ou sair) de sala troca de conversa.
        state.chat.messages = [];
        state.chat.seen = new Set();
        state.chat.unread = 0;
        renderChat(true);
      }

      if (!state.settings.enabled || !state.settings.room) {
        closePort();
        state.status = 'idle';
      } else if (!state.port) {
        openPort();
      }
      render();
    });
  } catch (err) {
    /* ignorado */
  }

  document.addEventListener('fullscreenchange', moveRootForFullscreen);
  document.addEventListener('webkitfullscreenchange', moveRootForFullscreen);

  watchUiEvents();
  installResize();
  loadSettings();
  setInterval(loop, 1000);
})();
