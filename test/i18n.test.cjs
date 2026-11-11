const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { t, locale, STRINGS } = require('../extension/i18n.js');

test('English and Portuguese have the same keys', () => {
  assert.deepStrictEqual(Object.keys(STRINGS.pt).sort(), Object.keys(STRINGS.en).sort());
});

test('every key used by the popup and the overlay exists', () => {
  const ext = path.join(__dirname, '..', 'extension');
  const html = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8');
  const scripts = ['popup.js', 'content.js']
    .map((f) => fs.readFileSync(path.join(ext, f), 'utf8'))
    .join('\n');
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...scripts.matchAll(/\bL\('([^']+)'/g)].map((m) => m[1]),
  ]);
  for (const key of used) assert.ok(key in STRINGS.en, 'missing key: ' + key);
});

test('English is the fallback and placeholders are filled', () => {
  assert.strictEqual(t(undefined, 'connected'), 'Connected');
  assert.strictEqual(t('xx', 'connected'), 'Connected');
  assert.strictEqual(t('pt', 'codeCopied', { room: 'K7QX2M' }), 'Código copiado: K7QX2M');
  assert.strictEqual(locale('pt'), 'pt-BR');
  assert.strictEqual(locale('en'), 'en-US');
});
