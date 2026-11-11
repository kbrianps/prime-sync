const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'extension');
const problems = [];

const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (manifest.manifest_version !== 3) problems.push('manifest_version precisa ser 3');
if (manifest.version !== pkg.version) {
  problems.push(`versão diferente: manifest ${manifest.version}, package.json ${pkg.version}`);
}
if ((manifest.description || '').length > 132) {
  problems.push('description do manifest passa de 132 caracteres');
}

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
];
for (const file of new Set(referenced)) {
  if (!fs.existsSync(path.join(ext, file))) problems.push('arquivo não encontrado: ' + file);
}

const scripts = [
  ...fs.readdirSync(ext).filter((f) => f.endsWith('.js')).map((f) => path.join(ext, f)),
  ...['tools', 'test'].flatMap((dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((f) => /\.c?js$/.test(f))
      .map((f) => path.join(root, dir, f))
  ),
];
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push('erro de sintaxe em ' + path.relative(root, file) + '\n' + err.stderr);
  }
}

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`✓ manifest ${manifest.version} ok, ${scripts.length} scripts sem erro de sintaxe`);
