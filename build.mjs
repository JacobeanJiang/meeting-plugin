import { build } from 'esbuild';
import { copyFile, mkdir, writeFile, mkdtemp, rm, readFile, cp, chmod, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { allowLocalBoardEmbedding, signalBoardReady } from './scripts/board-embedding.mjs';
// Standalone MCP server for any agent (Codex, Claude Code, Cursor …).
// node build.mjs           -> dist-mcp/macos     (voxtype + Swift recorder)
// node build.mjs windows   -> dist-mcp/windows   (whisper-cli + C recorder, cross-compiled with zig)
const target = process.argv[2] === 'windows' ? 'windows' : 'macos';
const root = fileURLToPath(new URL('./', import.meta.url));
const output = path.join(root, 'dist-mcp', target);
if (await access(output).then(() => true, () => false)) throw Error(output + ' already exists; move it away first');
await mkdir(output, { recursive: true });
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await build({ absWorkingDir: root, entryPoints: ['src/mcp/server.ts'], outfile: path.join(output, 'server/index.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', legalComments: 'none',
  banner: { js: "import { createRequire as meetingCreateRequire } from 'node:module'; const require = meetingCreateRequire(import.meta.url);" },
  plugins: [{ name: 'meeting-vendor', setup(b) { b.onResolve({ filter: /vendor\/open-artifact\.mjs$/ }, () => ({ path: '../vendor/open-artifact.mjs', external: true })); } }] });
await mkdir(path.join(output, 'native'));
let natives;
if (target === 'macos') {
  if (process.platform !== 'darwin') throw Error('Build the macOS capture helper on macOS');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'meeting-native-'));
  try {
    for (const arch of ['arm64', 'x86_64']) execFileSync('xcrun', ['swiftc', '-O', '-target', arch + '-apple-macosx12.0', path.join(root, 'native/MeetingRecorder.swift'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(root, 'native/Info.plist'), '-o', path.join(scratch, arch)], { stdio: 'inherit' });
    const helper = path.join(output, 'native/meeting-recorder');
    execFileSync('lipo', ['-create', path.join(scratch, 'arm64'), path.join(scratch, 'x86_64'), '-output', helper]);
    execFileSync('codesign', ['--force', '--sign', '-', helper], { stdio: 'inherit' });
  } finally { await rm(scratch, { recursive: true, force: true }); }
  // voxtype 1.2.2 official macOS universal release, shipped unchanged; not kept in git, fetched once and checksum-verified.
  const voxtype = path.join(root, 'native/voxtype-1.2.2-macos-universal');
  if (!await readFile(voxtype).then(() => true, () => false)) { const response = await fetch('https://github.com/peteonrails/voxtype/releases/download/v1.2.2/voxtype-1.2.2-macos-universal'); if (!response.ok) throw Error('download voxtype failed: ' + response.status); await writeFile(voxtype, Buffer.from(await response.arrayBuffer())); }
  if (await sha256(voxtype) !== '3dfd45551538fb53f2d11321172da9298c57d0cf5dee347ffd09805286f3ca98') throw Error('voxtype binary does not match the v1.2.2 release checksum');
  await copyFile(voxtype, path.join(output, 'native/voxtype')); await chmod(path.join(output, 'native/voxtype'), 0o755);
  await copyFile(path.join(root, 'native/LICENSE.voxtype'), path.join(output, 'native/LICENSE.voxtype'));
  natives = ['native/meeting-recorder', 'native/voxtype'];
} else {
  execFileSync('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-o', path.join(output, 'native/meeting-recorder.exe'), path.join(root, 'native/windows/meeting-recorder.c'), '-lwinmm'], { stdio: 'inherit' });
  await rm(path.join(output, 'native/meeting-recorder.pdb'), { force: true });
  const sums = Object.fromEntries((await readFile(path.join(root, 'native/windows/SHA256SUMS'), 'utf8')).trim().split('\n').map(line => line.split(/\s+/).reverse()));
  for (const name of ['whisper-cli.exe', 'whisper-cli-compat.exe']) {
    const file = path.join(root, 'native/windows', name);
    if (await sha256(file) !== sums[name]) throw Error(name + ' does not match native/windows/SHA256SUMS; rebuild with scripts/build-whisper-windows.sh');
    await copyFile(file, path.join(output, 'native', name));
  }
  await copyFile(path.join(root, 'native/windows/LICENSE.whisper.cpp'), path.join(output, 'native/LICENSE.whisper.cpp'));
  natives = ['native/meeting-recorder.exe', 'native/whisper-cli.exe', 'native/whisper-cli-compat.exe'];
}
await cp(path.join(root, 'vendor'), path.join(output, 'vendor'), { recursive: true, filter: file => !file.endsWith('.ts') && !file.endsWith('adapter-source.ts.txt') && !file.endsWith('.d.mts') });
const boardBundle = path.join(output, 'vendor/open-artifact.mjs');
await writeFile(boardBundle, allowLocalBoardEmbedding(await readFile(boardBundle, 'utf8')));
const boardEditor = path.join(output, 'vendor/assets/editors/whiteboard/index.html');
await writeFile(boardEditor, signalBoardReady(await readFile(boardEditor, 'utf8')));
await cp(path.join(root, 'web'), path.join(output, 'web'), { recursive: true });
await cp(path.join(root, 'skills/meeting-assistant'), path.join(output, 'skills/meeting-assistant'), { recursive: true });
await mkdir(path.join(output, 'docs'), { recursive: true });
await copyFile(path.join(root, 'docs/voice-stream.md'), path.join(output, 'docs/voice-stream.md'));
await mkdir(path.join(output, 'licenses/ws'), { recursive: true });
await copyFile(path.join(root, 'node_modules/ws/LICENSE'), path.join(output, 'licenses/ws/LICENSE'));
const docs = root;
for (const name of ['README.md', 'NOTICE.md']) await copyFile(path.join(await access(path.join(docs, name)).then(() => docs, () => root), name), path.join(output, name));
await mkdir(path.join(output, 'licenses/opencc-js'), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.md', 'LICENSES/Apache-2.0.txt']) await copyFile(path.join(root, 'node_modules/opencc-js', name), path.join(output, 'licenses/opencc-js', path.basename(name)));
for (const name of ['server/index.mjs', 'web/index.html', 'skills/meeting-assistant/SKILL.md', ...natives]) await readFile(path.join(output, name));
console.log('Built Meeting Assistant MCP server (' + target + '): ' + output);

