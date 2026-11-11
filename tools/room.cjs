/*
 * room.cjs — monitor/emissor de uma sala do Prime Sync, pelo terminal.
 *
 *   node tools/room.cjs ABC123                    # escuta sync + chat
 *   node tools/room.cjs ABC123 --say "oi"         # manda uma mensagem no chat
 *   node tools/room.cjs ABC123 --pause 123.4      # manda "pausar" em 123.4s
 *   node tools/room.cjs ABC123 --play 123.4       # manda "tocar" em 123.4s
 *
 * Serve para conferir que a extensão está publicando e recebendo, sem precisar
 * de uma segunda pessoa (ou de um segundo navegador).
 */
const { MqttLite } = require('../extension/mqtt-lite.js');

const BROKER = process.env.BROKER || '';
const AUTH = { username: process.env.BROKER_USER || '', password: process.env.BROKER_PASS || '' };

if (!/^wss?:\/\//.test(BROKER)) {
  console.error('Defina BROKER, ex.: BROKER=wss://seu-broker:8084/mqtt [BROKER_USER=... BROKER_PASS=...]');
  process.exit(1);
}
const WHO = 'cli-' + Math.random().toString(36).slice(2, 8);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const room = String(process.argv[2] || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

if (room.length < 4) {
  console.error(
    'Uso: node tools/room.cjs <CODIGO-DA-SALA> [--say "texto"] [--pause 10.5] [--play 10.5]'
  );
  process.exit(1);
}

const BASE = 'primesync/v1/' + room;
const CHAT = BASE + '/chat';

const say = arg('--say');
const pause = arg('--pause');
const play = arg('--play');

function clock() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtTime(t) {
  const total = Math.max(0, Number(t) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function log(label, text) {
  console.log(`[${clock()}] ${label.padEnd(5)} ${text}`);
}

console.log('Prime Sync — monitor de sala');
console.log('  sala  :', room);
console.log('  broker:', BROKER.replace(/^wss:\/\//, ''));
console.log('  quem  :', WHO);
console.log('');
log('INFO', 'deixe rodando e dê play no Prime Video...');
console.log('');

const client = new MqttLite(BROKER, {
  keepalive: 20,
    ...AUTH,
  autoReconnect: true,
  onStatus: (state) => {
    if (state === 'connected') log('REDE', 'conectado ao broker');
    if (state === 'disconnected') log('REDE', 'caiu, tentando reconectar...');
  },
  onMessage: (topic, message) => {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (err) {
      return;
    }
    if (!payload || payload.v !== 1) return;

    if (topic === CHAT) {
      const mine = payload.who === WHO;
      log('CHAT', `${payload.name || 'Alguém'}${mine ? ' (você)' : ''}: ${payload.text}`);
      return;
    }

    if (topic !== BASE) return;
    if (payload.kind === 'health') {
      log(
        'REDE',
        `${payload.name || payload.who}: ${payload.slow ? 'INTERNET RUIM' : 'ok'}`
      );
      return;
    }
    if (payload.kind === 'hello') {
      log('SYNC', `pedido de posição de ${payload.who}`);
      return;
    }
    const mine = payload.who === WHO ? ' (você)' : '';
    log(
      'SYNC',
      `${payload.playing ? '▶ tocando' : '⏸ pausado'} em ${fmtTime(payload.t)}` +
        `${payload.rate && payload.rate !== 1 ? ` @${payload.rate}x` : ''}` +
        `${payload.slow ? ' ⚠ internet ruim' : ''}${mine}` +
        `${payload.title ? ` — "${String(payload.title).slice(0, 50)}"` : ''}`
    );
  },
});

(async () => {
  await client.connect();
  client.subscribe(BASE);
  client.subscribe(CHAT);

  // tempo para o SUBACK chegar antes de publicar
  await new Promise((r) => setTimeout(r, 600));

  if (say) {
    client.publish(
      CHAT,
      JSON.stringify({ v: 1, id: WHO + ':1', who: WHO, name: 'Terminal', text: String(say) })
    );
  }

  const target = pause !== undefined ? pause : play;
  if (target !== undefined) {
    client.publish(
      BASE,
      JSON.stringify({
        v: 1,
        kind: 'event',
        who: WHO,
        seq: 1,
        ts: Date.now(),
        t: Number(target),
        playing: play !== undefined,
        rate: 1,
        title: '(comando do terminal)',
      })
    );
  }

  if (say || target !== undefined) {
    setTimeout(() => {
      console.log('');
      log('INFO', 'comando enviado. Use Ctrl+C para sair.');
    }, 400);
  }
})();

process.on('SIGINT', () => {
  client.close();
  process.exit(0);
});
