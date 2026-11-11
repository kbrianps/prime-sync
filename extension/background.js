/*
 * background.js — service worker do Prime Sync.
 * Mantém UMA conexão MQTT e faz ponte entre ela e as abas do Prime Video.
 */
importScripts('mqtt-lite.js');

const TOPIC_PREFIX = 'primesync/v1/';
const RECONNECT_DELAY = 3000;

let settings = {
  enabled: true,
  room: '',
  showOverlay: true,
  broker: '',
  username: '',
  password: '',
};
let client = null;
let currentBroker = '';
let currentStatus = 'idle';
let lastError = '';
let reconnectTimer = null;
const ports = new Set();

/* ---------------------------------------------------------------- status */

function topicFor(room) {
  return TOPIC_PREFIX + String(room).trim().toUpperCase();
}

function chatTopicFor(room) {
  return topicFor(room) + '/chat';
}

function isValidBroker(url) {
  return /^wss?:\/\/[^\s/]+/i.test(String(url || '').trim());
}

function statusMessage() {
  return {
    type: 'status',
    status: currentStatus,
    room: settings.room,
    broker: currentBroker,
    error: lastError,
  };
}

function setStatus(status) {
  currentStatus = status;
  if (status === 'connected' || status === 'idle') lastError = '';
  try {
    chrome.action.setBadgeText({
      text: status === 'connected' ? 'ON' : '',
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1f8f4e' });
  } catch (err) {
    /* ignorado */
  }
  broadcast(statusMessage());
}

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch (err) {
      ports.delete(port);
    }
  }
}

/* ------------------------------------------------------------- conexão */

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (client) {
    try {
      client.close();
    } catch (err) {
      /* ignorado */
    }
    client = null;
  }
  setStatus('idle');
}

function scheduleReconnect(delay) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!client) connect();
  }, delay || RECONNECT_DELAY);
}

function connect() {
  if (!settings.enabled || !settings.room || !isValidBroker(settings.broker)) {
    currentBroker = '';
    setStatus('idle');
    return;
  }
  if (client) return;

  const broker = settings.broker.trim();
  currentBroker = broker;
  setStatus('connecting');

  const active = new MqttLite(broker, {
    keepalive: 30,
    autoReconnect: false,
    username: settings.username || '',
    password: settings.password || '',
    onMessage: handleIncoming,
    onStatus: (state, detail) => {
      if (client !== active) return;
      if (state === 'connected') {
        setStatus('connected');
      } else if (state === 'disconnected') {
        setStatus('offline');
        client = null;
        scheduleReconnect(RECONNECT_DELAY);
      } else if (state === 'error') {
        lastError = /^CONNACK [45]$/.test(detail) ? 'auth' : 'unreachable';
        setStatus('offline');
      }
    },
  });

  client = active;

  active
    .connect()
    .then(() => {
      if (client !== active) return;
      active.subscribe(topicFor(settings.room));
      active.subscribe(chatTopicFor(settings.room));
      setStatus('connected');
    })
    .catch((err) => {
      if (client === active) client = null;
      if (err && (err.code === 4 || err.code === 5)) lastError = 'auth';
      else if (!lastError) lastError = 'unreachable';
      setStatus('offline');
      scheduleReconnect(RECONNECT_DELAY);
    });
}

function handleIncoming(topic, message) {
  let payload;
  try {
    payload = JSON.parse(message);
  } catch (err) {
    return;
  }
  if (!payload || payload.v !== 1) return;

  if (topic === chatTopicFor(settings.room)) {
    broadcast({ type: 'chat', payload });
  } else if (topic === topicFor(settings.room)) {
    broadcast({ type: 'remote', payload });
  }
}

function publish(payload) {
  if (!client || !client.connected) return false;
  payload.v = 1;
  return client.publish(topicFor(settings.room), JSON.stringify(payload));
}

function publishChat(payload) {
  if (!client || !client.connected) return false;
  payload.v = 1;
  return client.publish(chatTopicFor(settings.room), JSON.stringify(payload));
}

/* -------------------------------------------------------------- settings */

function loadSettings() {
  return chrome.storage.local
    .get(['settings'])
    .then((result) => {
      if (result && result.settings) {
        settings = Object.assign({}, settings, result.settings);
      }
      return settings;
    })
    .catch(() => settings);
}

/* --------------------------------------------------------------- portas */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'primesync') return;
  ports.add(port);

  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });

  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'publish' && message.payload) {
      publish(message.payload);
    } else if (message.type === 'publish-chat' && message.payload) {
      publishChat(message.payload);
    } else if (message.type === 'hello') {
      publish({ kind: 'hello', who: message.who, ts: Date.now() });
    } else if (message.type === 'get-status') {
      port.postMessage(statusMessage());
    }
  });

  port.postMessage(statusMessage());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'get-status') {
    sendResponse(statusMessage());
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = Object.assign({}, settings, changes.settings.newValue || {});
  const needsReconnect = ['room', 'enabled', 'broker', 'username', 'password'].some(
    (key) => next[key] !== settings[key]
  );
  settings = next;
  if (needsReconnect) {
    lastError = '';
    disconnect();
    connect();
  }
});

chrome.alarms.create('primesync-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'primesync-keepalive') return;
  if (!settings.enabled || !settings.room || !settings.broker) return;
  if (!client) connect();
});

chrome.runtime.onInstalled.addListener(() => {
  loadSettings().then(connect);
});

loadSettings().then(connect);
