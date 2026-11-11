/*
 * Teste de integração: dois clientes, dois tópicos (sincronização e chat),
 * mensagens reais pelo broker configurado em BROKER.
 * Roda com: BROKER=wss://... npm run test:broker
 */
const assert = require('node:assert');
const { MqttLite } = require('../extension/mqtt-lite.js');

const BROKER = process.env.BROKER || '';
const AUTH = { username: process.env.BROKER_USER || '', password: process.env.BROKER_PASS || '' };

if (!/^wss?:\/\//.test(BROKER)) {
  console.error('Defina BROKER, ex.: BROKER=wss://seu-broker:8084/mqtt [BROKER_USER=... BROKER_PASS=...]');
  process.exit(1);
}
const ROOM = 'TEST' + Math.random().toString(36).slice(2, 7).toUpperCase();
const SYNC_TOPIC = 'primesync/v1/' + ROOM;
const CHAT_TOPIC = SYNC_TOPIC + '/chat';

function makeClient(name, received) {
  return new MqttLite(BROKER, {
    keepalive: 20,
    ...AUTH,
    autoReconnect: false,
    onMessage: (topic, message) => {
      received.push({ name, topic, message: JSON.parse(message) });
    },
    onStatus: (state) => console.log(`[${name}] ${state}`),
  });
}

function waitFor(predicate, timeout = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

(async () => {
  const aReceived = [];
  const bReceived = [];

  const a = makeClient('A', aReceived);
  const b = makeClient('B', bReceived);

  await a.connect();
  a.subscribe(SYNC_TOPIC);
  a.subscribe(CHAT_TOPIC);
  await b.connect();
  b.subscribe(SYNC_TOPIC);
  b.subscribe(CHAT_TOPIC);

  await new Promise((r) => setTimeout(r, 500));

  a.publish(SYNC_TOPIC, JSON.stringify({ v: 1, kind: 'event', who: 'A', t: 12.5 }));
  b.publish(SYNC_TOPIC, JSON.stringify({ v: 1, kind: 'event', who: 'B', t: 13.75 }));

  // MQTT 3.1.1 também devolve a própria mensagem para quem publicou
  // (não existe "no local" antes do MQTT 5), por isso filtramos por `who`.
  await waitFor(
    () =>
      aReceived.some((m) => m.message.who === 'B') &&
      bReceived.some((m) => m.message.who === 'A')
  );

  const seenByA = aReceived.find((m) => m.message.who === 'B');
  const seenByB = bReceived.find((m) => m.message.who === 'A');

  assert.strictEqual(seenByB.message.t, 12.5);
  assert.strictEqual(seenByA.message.t, 13.75);
  assert.strictEqual(seenByA.topic, SYNC_TOPIC);

  // chat separado da sincronização
  a.publish(
    CHAT_TOPIC,
    JSON.stringify({ v: 1, id: 'A:1', who: 'A', name: 'Bia', text: 'oi, tá me ouvindo?' })
  );

  await waitFor(() => bReceived.some((m) => m.message.id === 'A:1'));

  const chatSeen = bReceived.find((m) => m.message.id === 'A:1');
  assert.strictEqual(chatSeen.topic, CHAT_TOPIC);
  assert.strictEqual(chatSeen.message.text, 'oi, tá me ouvindo?');

  const chatOnWrongTopic = bReceived.filter(
    (m) => m.message.id === 'A:1' && m.topic !== CHAT_TOPIC
  );
  assert.strictEqual(chatOnWrongTopic.length, 0);

  // payload grande (título longo) para validar comprimento variável
  const big = 'x'.repeat(3000);
  a.publish(SYNC_TOPIC, JSON.stringify({ v: 1, kind: 'tick', who: 'A', title: big }));
  await waitFor(() => bReceived.some((m) => m.message.title === big));

  console.log('OK — sync e chat separados, bidirecional, payload de 3 KB.');

  a.close();
  b.close();
  process.exit(0);
})().catch((err) => {
  console.error('FALHOU:', err);
  process.exit(1);
});
