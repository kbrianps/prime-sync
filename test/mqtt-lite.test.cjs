const test = require('node:test');
const assert = require('node:assert');

const sockets = [];

class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    setImmediate(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    });
  }

  send(bytes) {
    this.sent.push(Uint8Array.from(bytes));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setImmediate(() => this.onclose && this.onclose());
  }

  receive(bytes) {
    this.onmessage({ data: Uint8Array.from(bytes).buffer });
  }
}

globalThis.WebSocket = FakeWebSocket;
const { MqttLite } = require('../extension/mqtt-lite.js');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function mqttString(value) {
  const bytes = encoder.encode(value);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function remainingLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function publishPacket(topic, message) {
  const body = [...mqttString(topic), ...encoder.encode(message)];
  return [0x30, ...remainingLength(body.length), ...body];
}

function lastSocket() {
  return sockets[sockets.length - 1];
}

function waitForSocketOpen() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function client(options) {
  return new MqttLite('wss://broker.test/mqtt', {
    clientId: 'test-client',
    autoReconnect: false,
    ...options,
  });
}

test('CONNECT without credentials uses only the clean session flag', async () => {
  const c = client();
  const pending = c.connect();
  await waitForSocketOpen();
  const packet = lastSocket().sent[0];

  assert.strictEqual(packet[0], 0x10);
  assert.deepStrictEqual(lastSocket().protocols, ['mqtt']);
  const flags = packet[2 + 6 + 1];
  assert.strictEqual(flags, 0x02);

  lastSocket().receive([0x20, 0x02, 0x00, 0x00]);
  await pending;
  assert.strictEqual(c.connected, true);
  c.close();
});

test('CONNECT with username and password sets both flags and appends them', async () => {
  const c = client({ username: 'ana', password: 's3nh@' });
  const pending = c.connect();
  await waitForSocketOpen();
  const packet = lastSocket().sent[0];

  const flags = packet[2 + 6 + 1];
  assert.strictEqual(flags, 0xc2);
  const tail = decoder.decode(packet.subarray(packet.length - 14));
  assert.ok(tail.endsWith('ana\u0000\u0005s3nh@'));

  lastSocket().receive([0x20, 0x02, 0x00, 0x00]);
  await pending;
  c.close();
});

test('password without username is not sent', async () => {
  const c = client({ password: 'orphan' });
  c.connect().catch(() => {});
  await waitForSocketOpen();
  const packet = lastSocket().sent[0];
  assert.strictEqual(packet[2 + 6 + 1], 0x02);
  assert.ok(!decoder.decode(packet).includes('orphan'));
  c.close();
});

test('refused CONNACK rejects connect with the return code', async () => {
  const c = client({ username: 'ana', password: 'wrong' });
  const pending = c.connect();
  await waitForSocketOpen();
  lastSocket().receive([0x20, 0x02, 0x00, 0x05]);

  await assert.rejects(pending, (err) => err.code === 5);
  assert.strictEqual(c.connected, false);
});

test('socket closed before CONNACK rejects instead of hanging', async () => {
  const c = client();
  const pending = c.connect();
  await waitForSocketOpen();
  lastSocket().close();
  await assert.rejects(pending);
});

test('subscribe after connect sends SUBSCRIBE with QoS 0', async () => {
  const c = client();
  const pending = c.connect();
  await waitForSocketOpen();
  lastSocket().receive([0x20, 0x02, 0x00, 0x00]);
  await pending;

  c.subscribe('primesync/v1/ROOM');
  const packet = lastSocket().sent[lastSocket().sent.length - 1];
  assert.strictEqual(packet[0], 0x82);
  assert.strictEqual(packet[packet.length - 1], 0x00);
  assert.ok(decoder.decode(packet).includes('primesync/v1/ROOM'));
  c.close();
});

test('PUBLISH split across frames and with a multi-byte length is reassembled', async () => {
  const received = [];
  const c = client({ onMessage: (topic, message) => received.push({ topic, message }) });
  const pending = c.connect();
  await waitForSocketOpen();
  lastSocket().receive([0x20, 0x02, 0x00, 0x00]);
  await pending;

  const big = JSON.stringify({ v: 1, title: 'x'.repeat(3000) });
  const packet = publishPacket('primesync/v1/ROOM', big);
  const small = publishPacket('primesync/v1/ROOM/chat', '{"v":1,"text":"oi"}');
  const stream = [...packet, ...small];

  lastSocket().receive(stream.slice(0, 2));
  lastSocket().receive(stream.slice(2, 1500));
  assert.strictEqual(received.length, 0);
  lastSocket().receive(stream.slice(1500));

  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[0].topic, 'primesync/v1/ROOM');
  assert.strictEqual(received[0].message, big);
  assert.strictEqual(received[1].topic, 'primesync/v1/ROOM/chat');
  assert.strictEqual(JSON.parse(received[1].message).text, 'oi');
  c.close();
});
