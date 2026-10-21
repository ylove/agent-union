import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userConfigDir } from '../state.js';
import { PACKAGE_ROOT } from '../paths.js';

const PARTS = ['bin', 'src', 'templates', 'skills', 'agents', 'package.json', 'LICENSE', 'NOTICE'];

export function packageVersion(root = PACKAGE_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

// Hooks must point at a path that outlives `npx` caches, so installers copy the package to
// ~/.agent-union/runtime/<version>/ and call it with the absolute path of the current node binary
// (GUI apps often don't see nvm or Homebrew on PATH).
export function ensureRuntime({ dryRun = false, link = false } = {}) {
  const node = process.execPath;
  if (link) return { node, root: PACKAGE_ROOT, bin: join(PACKAGE_ROOT, 'bin', 'agent-union'), copied: false };
  const root = join(userConfigDir(), 'runtime', packageVersion());
  const copied = root !== PACKAGE_ROOT;
  if (!dryRun && copied) {
    mkdirSync(root, { recursive: true });
    for (const part of PARTS) {
      const from = join(PACKAGE_ROOT, part);
      if (existsSync(from)) cpSync(from, join(root, part), { recursive: true });
    }
  }
  return { node, root, bin: join(root, 'bin', 'agent-union'), copied };
}

export function hookCommand(runtime, ...args) {
  const q = (s) => (/^[\w./:@-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);
  return [runtime.node, runtime.bin, ...args].map(q).join(' ');
}

export function readJsonFile(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it before installing.`);
  }
}

export function writeJsonFile(file, value, { dryRun = false } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) return text;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

export function copySkills(targetDir, { dryRun = false } = {}) {
  const names = ['union-init', 'union-ratify', 'union-grieve', 'union-resume'];
  if (!dryRun) {
    for (const name of names) cpSync(join(PACKAGE_ROOT, 'skills', name), join(targetDir, name), { recursive: true });
  }
  return names.map((n) => join(targetDir, n));
}
