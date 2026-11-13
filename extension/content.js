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

  const PEER_SILENT_MS = 25000;
  const PEER_GONE_MS = 5 * 60000;

  const CHAT_MAX = 500;
  const CHAT_HISTORY = 200;
  const MIN_PANEL_HEIGHT = 140;

  const ICONS = {
    sync: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
    hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
    min: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    show: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  };

  const state = {
    settings: { enabled: true, room: '', showOverlay: true, name: '', broker: '', lang: 'en' },
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
    pausedBy: null, // { mine: bool, name: string, at: number }
    drift: 0,
    remoteTitle: '',
    content: { ep: '', show: '', lang: '' },
    mismatch: null,
    root: null,
    overlay: null,
    tab: null,
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

  function L(key, vars) {
    return globalThis.PrimeSyncI18n.t(state.settings.lang, key, vars);
  }

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

  function textOf(selector) {
    const el = document.querySelector(selector);
    return el ? String(el.textContent || '').trim() : '';
  }

  function episodeKey(text) {
    const match = String(text || '').match(/(\d+)\D+?(\d+)/);
    return match ? 'S' + Number(match[1]) + 'E' + Number(match[2]) : '';
  }

  function refreshContent() {
    const subtitle = textOf('.atvwebplayersdk-subtitle-text');
    const show = textOf('.atvwebplayersdk-title-text').slice(0, 120);
    if (show) state.content.show = show;
    if (subtitle) state.content.ep = episodeKey(subtitle);
    else if (show) state.content.ep = '';
    state.content.lang = String(document.documentElement.lang || '').toLowerCase();
  }

  function differentContent(message) {
    const mine = state.content;
    if (mine.ep && message.ep && mine.ep !== message.ep) return true;
    return Boolean(
      mine.show &&
        message.show &&
        mine.lang &&
        mine.lang === message.lang &&
        mine.show !== message.show
    );
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
    }, 300);
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
      showToast(L('partnerBadNet', { name: remote.name || L('someone') }));
    } else if (!remote.slow) {
      state.peerSlowNotified = false;
    }
  }

  /*
   * Um único chip na pílula, por ordem de importância:
   * pausa (quem pausou) > sua conexão > parceiro lento > sem sinal.
   */
  function renderChip() {
    const pill = state.overlay;
    if (!pill) return;
    const chip = pill.querySelector('.ps-net');
    if (!chip) return;

    const video = state.video;
    const paused = Boolean(video && video.paused && !video.ended);

    let text = '';
    let tone = 'warn';

    if (state.mismatch && Date.now() - state.mismatch.at < 15000) {
      const { name, ep } = state.mismatch;
      text = ep ? L('otherEpisode', { name, ep }) : L('otherTitle', { name });
    } else if (paused && state.pausedBy) {
      text = state.pausedBy.mine
        ? L('youPaused')
        : L('namePaused', { name: state.pausedBy.name || L('someone') });
      tone = 'pause';
    } else if (isLocalSlow()) {
      text = L('yourConnection');
    } else if (peerHealth().silent) {
      text = L('noSignal', { name: peerHealth().name || L('someone') });
      tone = 'off';
    } else if (peerHealth().slow) {
      const name = peerHealth().name;
      text = name ? L('nameSlow', { name }) : L('someoneSlow');
    }

    chip.textContent = text;
    chip.dataset.tone = tone;
    chip.style.display = text ? 'inline-block' : 'none';
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
  /*
   * O player do Prime escuta teclado no documento. Um listener nosso no root
   * perde para a fase de captura dele; no window, em captura, ganhamos de
   * qualquer listener no document/body/player. Assim o Enter do chat não chega
   * no player. (Se o player também escutar no window, o revert() cobre.)
   */
  function guardPageEvents() {
    const inside = (event) =>
      Boolean(state.root && event.target && state.root.contains(event.target));

    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel']) {
      window.addEventListener(
        type,
        (event) => {
          if (!inside(event)) return;
          state.lastUiEventAt = Date.now();
        },
        true
      );
    }

    window.addEventListener(
      'keydown',
      (event) => {
        if (!inside(event)) return;
        state.lastUiEventAt = Date.now();
        event.stopImmediatePropagation(); // o player não vê esta tecla

        const input = state.chat.input;
        if (!input || event.target !== input) return;
        // Enter envia; Shift+Enter quebra linha. Durante IME, deixa passar.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          if (sendChat(input.value)) {
            input.value = '';
            input.style.height = '';
          }
        }
      },
      true
    );

    for (const type of ['keyup', 'keypress']) {
      window.addEventListener(
        type,
        (event) => {
          if (!inside(event)) return;
          state.lastUiEventAt = Date.now();
          event.stopImmediatePropagation();
        },
        true
      );
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
    state.content = { ep: '', show: '', lang: '' };
    state.mismatch = null;
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

    if (type === 'pause' && !state.video.ended) {
      state.pausedBy = { mine: true, name: '', at: Date.now() };
    } else if (type === 'play' || type === 'ended') {
      state.pausedBy = null;
    }

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
        ep: state.content.ep,
        show: state.content.show,
        lang: state.content.lang,
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
    if (typeof message.ep === 'string') peer.ep = message.ep.slice(0, 12);
    state.peers.set(message.who, peer);

    if (message.kind === 'health') {
      checkPeerHealth();
      renderChip();
      return;
    }

    const video = state.video;
    if (!video) return;

    refreshContent();
    if (differentContent(message)) {
      const name = peer.name || L('someone');
      if (!state.mismatch) {
        showToast(L('otherContentToast', { name }));
      }
      state.mismatch = { name, ep: message.ep || '', at: now };
      state.drift = 0;
      restoreRate(video);
      render();
      return;
    }
    if (state.mismatch) {
      state.mismatch = null;
      render();
    }

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

    // Quem pausou: só marca na transição tocando -> pausado.
    if (playing) {
      state.pausedBy = null;
    } else if (peer.playing === true || peer.playing === undefined) {
      const mineIsFresh =
        state.pausedBy &&
        state.pausedBy.mine &&
        now - state.pausedBy.at < 4000;
      if (!mineIsFresh) {
        state.pausedBy = { mine: false, name: peer.name || '', at: now };
      }
    }
    peer.playing = playing;

    applyRemoteRate(video, message.rate);

    // Play/pause é intenção pura: aplicar sempre, é barato e não rebufferiza.
    if (playing && (video.paused || video.ended)) {
      guard(() => {
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() =>
            showToast(L('autoplay'))
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
      '<button class="ps-room" title="' + L('copyRoomTitle') + '">' + L('noRoom') + '</button>' +
      '<button class="ps-sync" title="' + L('syncTitle') + '">' +
      ICONS.sync +
      '<span>' + L('sync') + '</span></button>' +
      '<button class="ps-chat" title="' + L('chatTitle') + '">' +
      ICONS.chat +
      '<span>' + L('chat') + '</span><span class="ps-badge"></span></button>' +
      '<button class="ps-hide" title="' + L('hide') + '" aria-label="' + L('hide') + '">' +
      ICONS.hide +
      '</button>';

    pill.querySelector('.ps-room').addEventListener('click', () => {
      const room = state.settings.room;
      if (!room) {
        showToast(L('needRoom'));
        return;
      }
      copy(room);
      showToast(L('codeCopied', { room }));
    });

    pill.querySelector('.ps-sync').addEventListener('click', () => {
      if (!state.settings.broker) {
        showToast(L('needServer'));
        return;
      }
      if (!state.settings.room) {
        showToast(L('needRoom'));
        return;
      }
      if (!state.settings.enabled) {
        state.settings.enabled = true;
        persistSettings();
        showToast(L('joiningRoom'));
        return;
      }
      requestRemoteState();
      showToast(L('askingPosition'));
    });

    pill.querySelector('.ps-chat').addEventListener('click', () => {
      toggleChat();
    });

    pill.querySelector('.ps-hide').addEventListener('click', () => {
      // Esconde tudo; a alça na borda traz de volta.
      state.settings.showOverlay = false;
      persistSettings();
      render();
    });

    const root = getRoot();
    root.appendChild(pill);
    root.appendChild(buildTab());
    state.overlay = pill;
    state.chat.badge = pill.querySelector('.ps-badge');
    return pill;
  }

  /*
   * "Etiqueta de roupa" na borda esquerda: única coisa visível quando a
   * interface está escondida. Clicar restaura pílula + chat (o chat volta no
   * estado em que estava).
   */
  function buildTab() {
    if (state.tab) return state.tab;
    const tab = document.createElement('div');
    tab.id = 'ps-tab';
    tab.title = L('showUi');
    tab.innerHTML =
      '<span class="ps-tab-dot"></span><span class="ps-tab-arrow">' +
      ICONS.show +
      '</span>';

    tab.addEventListener('click', () => {
      state.settings.showOverlay = true;
      persistSettings();
      render();
    });

    state.tab = tab;
    return tab;
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

    const { enabled, room, showOverlay, broker } = state.settings;
    if (state.root) {
      state.root.classList.toggle('ps-collapsed', !showOverlay);
    }

    const dot = pill.querySelector('.ps-dot');
    const label = pill.querySelector('.ps-label');
    const roomButton = pill.querySelector('.ps-room');
    const driftEl = pill.querySelector('.ps-drift');

    let color = '#888888';
    let text = 'Prime Sync';

    if (!enabled) {
      color = '#888888';
      text = L('off');
    } else if (!broker) {
      color = '#f5b942';
      text = L('setServer');
    } else if (!room) {
      color = '#f5b942';
      text = L('setRoom');
    } else if (state.status === 'connected') {
      color = '#2fd18b';
      text = L('connected');
    } else if (state.status === 'connecting') {
      color = '#f5b942';
      text = L('connecting');
    } else {
      color = '#ff6b7d';
      text = L('offline');
    }

    dot.style.background = color;
    pill.dataset.status = color === '#2fd18b' ? 'on' : '';
    label.textContent = text;
    roomButton.textContent = room || L('noRoom');

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

    renderChip();

    if (state.tab) {
      const tabDot = state.tab.querySelector('.ps-tab-dot');
      if (tabDot) {
        tabDot.style.background =
          state.chat.unread > 0 ? '#2fd18b' : color;
      }
    }

    const sub =
      state.chat.panel && state.chat.panel.querySelector('.ps-panel-sub');
    if (sub) {
      sub.textContent = room ? L('roomStatus', { room, status: text }) : text;
      state.chat.panel.querySelector('.ps-panel-dot').style.background = color;
    }

    renderPeople();
  }

  function renderPeople() {
    const box = state.chat.panel && state.chat.panel.querySelector('.ps-people');
    if (!box) return;

    const now = Date.now();
    const mine = state.content.ep;
    const people = [{ name: L('you'), ep: mine, on: true }];
    for (const peer of state.peers.values()) {
      const age = now - (peer.lastSeenAt || 0);
      if (age > PEER_GONE_MS) continue;
      people.push({
        name: peer.name || L('noName'),
        ep: peer.ep || '',
        on: age < PEER_SILENT_MS,
      });
    }

    const key = JSON.stringify(people);
    if (box.dataset.key === key) return;
    box.dataset.key = key;

    const label = document.createElement('span');
    label.className = 'ps-people-label';
    label.textContent = L('inRoom');

    const chips = people.map((person) => {
      const chip = document.createElement('span');
      chip.className = 'ps-person';
      if (person.on) chip.classList.add('ps-on');
      const name = document.createElement('b');
      name.textContent = person.name;
      chip.append(name);
      if (person.ep) {
        const ep = document.createElement('i');
        ep.textContent = person.ep;
        if (mine && person.ep !== mine) ep.classList.add('ps-diff');
        chip.append(ep);
      }
      return chip;
    });

    box.replaceChildren(label, ...chips);
  }

  /* ----------------------------------------------------------------- chat */

  function buildPanel() {
    if (state.chat.panel) return state.chat.panel;

    const panel = document.createElement('div');
    panel.id = 'ps-panel';
    panel.innerHTML =
      '<div class="ps-resize" title="' + L('resizeTitle') + '"></div>' +
      '<div class="ps-panel-head">' +
      '<span class="ps-panel-dot"></span>' +
      '<span class="ps-panel-heading">' +
      '<span class="ps-panel-title">' + L('roomChat') + '</span>' +
      '<span class="ps-panel-sub"></span>' +
      '</span>' +
      '<button class="ps-panel-min" title="' + L('minimize') + '" aria-label="' + L('minimize') + '">' +
      ICONS.min +
      '</button>' +
      '<button class="ps-panel-close" title="' + L('close') + '" aria-label="' + L('close') + '">' +
      ICONS.close +
      '</button>' +
      '</div>' +
      '<div class="ps-people"></div>' +
      '<div class="ps-msgs"></div>' +
      '<form class="ps-compose">' +
      '<textarea class="ps-input" rows="1" maxlength="' +
      CHAT_MAX +
      '" placeholder="' + L('messagePlaceholder') + '" autocomplete="off" ' +
      'autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>' +
      '<button type="submit" class="ps-send" title="' + L('send') + '" aria-label="' + L('send') + '">' +
      ICONS.send +
      '</button>' +
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
      showToast(L('noConnection'));
      return false;
    }

    const now = Date.now();
    if (now - state.chat.lastSend < 350) return false; // anti-spam
    state.chat.lastSend = now;

    const payload = {
      id: WHO + ':' + (state.chat.seq += 1),
      who: WHO,
      name: (state.settings.name || L('someone')).slice(0, 24),
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
      name: String(message.name || L('someone')).slice(0, 24),
      text: String(message.text).slice(0, CHAT_MAX),
      time: new Date().toLocaleTimeString(globalThis.PrimeSyncI18n.locale(state.settings.lang), {
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
      const latest = state.chat.messages[state.chat.messages.length - 1];
      showToast(latest.name + ': ' + truncate(latest.text, 70));
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
      empty.innerHTML = ICONS.chat;
      const line = document.createElement('span');
      line.textContent = L('emptyChat');
      empty.appendChild(line);
      list.appendChild(empty);
      return;
    }

    let previous = null;
    for (const item of state.chat.messages) {
      const continued =
        previous && previous.mine === item.mine && previous.name === item.name;
      const row = document.createElement('div');
      row.className =
        'ps-msg' + (item.mine ? ' ps-mine' : '') + (continued ? ' ps-cont' : '');

      if (!continued) {
        const meta = document.createElement('span');
        meta.className = 'ps-meta';
        meta.textContent = item.mine ? L('you') : item.name;
        row.appendChild(meta);
      }

      const text = document.createElement('span');
      text.className = 'ps-text';
      text.textContent = item.text; // textContent: nada de HTML do parceiro

      const time = document.createElement('span');
      time.className = 'ps-time';
      time.textContent = item.time;

      row.appendChild(text);
      row.appendChild(time);
      list.appendChild(row);
      previous = item;
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
        const wasConnected = state.status === 'connected';
        state.status = message.status;
        if (!wasConnected && state.status === 'connected' && state.video) {
          requestRemoteState();
        }
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
    renderChip();
    renderPeople();
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

    refreshContent();

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
    state.tab = null;
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
      const previousLang = state.settings.lang;
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
        state.peers.clear();
        renderChat(true);
      }

      if (state.settings.lang !== previousLang && state.root) {
        state.root.remove();
        ensureUI();
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

  guardPageEvents();
  installResize();
  loadSettings();
  setInterval(loop, 1000);
})();
