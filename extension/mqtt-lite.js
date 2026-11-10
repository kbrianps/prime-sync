/*
 * mqtt-lite.js
 * Cliente MQTT 3.1.1 mínimo sobre WebSocket, somente QoS 0.
 * Sem dependências. Funciona em Service Worker (MV3), página e Node 22+.
 */
(function (root) {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function encodeLength(n) {
    const out = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Uint8Array.from(out);
  }

  function encodeString(value) {
    const bytes = encoder.encode(String(value));
    const out = new Uint8Array(bytes.length + 2);
    out[0] = (bytes.length >> 8) & 0xff;
    out[1] = bytes.length & 0xff;
    out.set(bytes, 2);
    return out;
  }

  function concat(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function buildPacket(type, flags, body) {
    return concat([
      Uint8Array.from([(type << 4) | flags]),
      encodeLength(body.length),
      body,
    ]);
  }

  class MqttLite {
    constructor(url, options) {
      const opts = options || {};
      this.url = url;
      this.clientId =
        opts.clientId ||
        'primesync-' + Math.random().toString(36).slice(2, 10);
      this.keepalive = opts.keepalive || 30;
      this.autoReconnect = opts.autoReconnect !== false;
      this.onMessage = opts.onMessage || null;
      this.onStatus = opts.onStatus || null;

      this.ws = null;
      this.buffer = new Uint8Array(0);
      this.subscriptions = new Set();
      this.connected = false;
      this.closedByUser = false;
      this.retries = 0;
      this.pingTimer = null;
      this.reconnectTimer = null;
      this.packetId = 1;
      this.connectWaiters = [];
    }

    _status(state, detail) {
      try {
        if (this.onStatus) this.onStatus(state, detail || '');
      } catch (err) {
        /* ignorado */
      }
    }

    connect() {
      this.closedByUser = false;
      this._status('connecting');

      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        let ws;
        try {
          // O subprotocolo "mqtt" é exigido por vários brokers (EMQX, Mosquitto).
          ws = new WebSocket(this.url, ['mqtt']);
        } catch (err) {
          this._scheduleReconnect();
          done(err);
          return;
        }

        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        ws.onopen = () => {
          this._sendConnect();
        };

        ws.onmessage = (event) => {
          const data =
            typeof event.data === 'string'
              ? encoder.encode(event.data)
              : new Uint8Array(event.data);
          this._handleChunk(data);
          if (this.connected) {
            this.retries = 0;
            done(null);
          }
        };

        ws.onclose = () => {
          const wasConnected = this.connected;
          this.connected = false;
          this._stopPing();
          this._status('disconnected');
          if (wasConnected) done(null);
          if (!this.closedByUser) this._scheduleReconnect();
        };

        ws.onerror = () => {
          this._status('error');
          if (!this.connected) done(new Error('falha ao conectar em ' + this.url));
        };
      });
    }

    _sendConnect() {
      const body = concat([
        encodeString('MQTT'),
        Uint8Array.from([
          0x04, // protocol level 3.1.1
          0x02, // clean session
          (this.keepalive >> 8) & 0xff,
          this.keepalive & 0xff,
        ]),
        encodeString(this.clientId),
      ]);
      this._rawSend(buildPacket(1, 0, body));
    }

    _rawSend(bytes) {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(bytes);
        return true;
      }
      return false;
    }

    subscribe(topic) {
      this.subscriptions.add(topic);
      if (!this.connected) return false;
      this.packetId = (this.packetId % 65535) + 1;
      const body = concat([
        Uint8Array.from([(this.packetId >> 8) & 0xff, this.packetId & 0xff]),
        encodeString(topic),
        Uint8Array.from([0x00]), // QoS 0
      ]);
      return this._rawSend(buildPacket(8, 0x02, body));
    }

    publish(topic, message) {
      if (!this.connected) return false;
      const body = concat([
        encodeString(topic),
        encoder.encode(String(message)),
      ]);
      return this._rawSend(buildPacket(3, 0x00, body));
    }

    close() {
      this.closedByUser = true;
      this.connected = false;
      this._stopPing();
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.ws) {
        try {
          this.ws.close();
        } catch (err) {
          /* ignorado */
        }
      }
      this.ws = null;
    }

    _scheduleReconnect() {
      if (!this.autoReconnect || this.closedByUser) return;
      if (this.reconnectTimer) return;
      const delay = Math.min(1000 * Math.pow(2, this.retries), 15000);
      this.retries += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => {
          /* o próximo close/reconnect cuida disso */
        });
      }, delay);
    }

    _startPing() {
      this._stopPing();
      const interval = Math.max(5000, (this.keepalive * 1000) / 2);
      this.pingTimer = setInterval(() => {
        this._rawSend(Uint8Array.from([0xc0, 0x00]));
      }, interval);
    }

    _stopPing() {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    _handleChunk(data) {
      this.buffer = this.buffer.length
        ? concat([this.buffer, data])
        : new Uint8Array(data);

      for (;;) {
        if (this.buffer.length < 2) return;

        let multiplier = 1;
        let remaining = 0;
        let index = 1;
        let byte;

        do {
          if (index >= this.buffer.length) return;
          byte = this.buffer[index++];
          remaining += (byte & 0x7f) * multiplier;
          multiplier *= 128;
          if (multiplier > 128 * 128 * 128) {
            this.close();
            return;
          }
        } while (byte & 0x80);

        const total = index + remaining;
        if (this.buffer.length < total) return;

        const header = this.buffer[0];
        const payload = this.buffer.subarray(index, total);
        this.buffer = this.buffer.slice(total);
        this._handlePacket(header >> 4, header & 0x0f, payload);
      }
    }

    _handlePacket(type, flags, payload) {
      if (type === 2) {
        // CONNACK
        if (payload[1] === 0) {
          this.connected = true;
          this._startPing();
          for (const topic of this.subscriptions) this.subscribe(topic);
          this._status('connected');
          const waiters = this.connectWaiters.splice(0);
          waiters.forEach((fn) => fn());
        } else {
          this._status('error', 'CONNACK ' + payload[1]);
        }
        return;
      }

      if (type === 3) {
        // PUBLISH (QoS 0)
        const topicLength = (payload[0] << 8) | payload[1];
        const topic = decoder.decode(payload.subarray(2, 2 + topicLength));
        const message = decoder.decode(payload.subarray(2 + topicLength));
        if (this.onMessage) {
          try {
            this.onMessage(topic, message, flags);
          } catch (err) {
            /* ignorado */
          }
        }
        return;
      }

      // SUBACK (9), PINGRESP (13), PUBACK (4): nada a fazer
    }
  }

  const api = { MqttLite };
  root.MqttLite = MqttLite;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
