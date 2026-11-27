// Assembles the agent plugins from the built servers (run npm run build and npm run build:windows first):
//   plugins/meeting-assistant           macOS
//   plugins/meeting-assistant-windows   Windows
// plus the marketplace files that let Codex and Claude Code install them straight from this repository.
import { cp, mkdir, readFile, writeFile, rm, chmod, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const repository = 'https://github.com/JacobeanJiang/meeting-plugin';
const description = 'Record meetings from the microphone with local transcription, a live self-organising board, Q&A about what was said, work handed to the agent during the meeting, and structured minutes.';
const keywords = ['meeting', 'minutes', 'transcription', 'whisper', 'whiteboard', 'mind-map', 'mcp'];
const passEnv = ['MEETING_LLM_API_KEY', 'MEETING_LLM_BASE_URL', 'MEETING_LLM_MODEL', 'OPENAI_API_KEY', 'MEETING_ASR_MODEL', 'MEETING_ASR_BASE_URL', 'MEETING_ASR_API_KEY', 'MEETING_ASR_TIMEOUT_MS', 'MEETING_VOICE_STREAM_URL', 'MEETING_VOICE_STREAM_API_KEY', 'MEETING_LIVE_CAPTIONS', 'MEETING_LIVE_INTERVAL_MS', 'MEETING_TASK_RUNNER', 'MEETING_ASSISTANT_NAME', 'MEETING_WAKE_WORDS', 'MEETING_TASK_CWD', 'MEETING_ASSISTANT_HOME', 'MEETING_OPEN_BROWSER', 'MEETING_NODE'];
const pluginRoot = '${CLAUDE_PLUGIN_ROOT}';
const targets = [
  { from: 'macos', name: 'meeting-assistant', label: 'Meeting Assistant', os: 'macOS', codex: { command: 'sh', args: ['./bin/start.sh'] }, claude: { command: 'sh', args: [pluginRoot + '/bin/start.sh'] } },
  { from: 'windows', name: 'meeting-assistant-windows', label: 'Meeting Assistant (Windows)', os: 'Windows', codex: { command: 'node', args: ['./server/index.mjs'] }, claude: { command: 'node', args: [pluginRoot + '/server/index.mjs'] } },
];
await rm(path.join(root, 'plugins'), { recursive: true, force: true });
for (const target of targets) {
  const from = path.join(root, 'dist-mcp', target.from);
  await access(path.join(from, 'server/index.mjs')).catch(() => { throw Error('Build ' + target.from + ' first (npm run build' + (target.from === 'windows' ? ':windows' : '') + ')'); });
  const out = path.join(root, 'plugins', target.name);
  await cp(from, out, { recursive: true });
  await mkdir(path.join(out, 'bin'), { recursive: true });
  await cp(path.join(root, 'scripts/start.sh'), path.join(out, 'bin/start.sh')); await chmod(path.join(out, 'bin/start.sh'), 0o755);
  // Only the icon goes into the installed plugin; the README's demo video stays in the repository.
  await mkdir(path.join(out, 'assets'), { recursive: true });
  await cp(path.join(root, 'assets/icon.png'), path.join(out, 'assets/icon.png'));
  await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  const shared = { version: pkg.version, description: description + ' (' + target.os + ')', author: { name: 'JacobeanJiang', url: 'https://github.com/JacobeanJiang' }, homepage: repository, repository, license: 'MIT', keywords };
  await mkdir(path.join(out, '.codex-plugin'));
  await writeFile(path.join(out, '.codex-plugin/plugin.json'), JSON.stringify({ name: target.name, ...shared, mcpServers: './.mcp.json', skills: './skills/',
    interface: { displayName: target.label, shortDescription: 'Meetings: live transcription, board and minutes', longDescription: description, developerName: 'JacobeanJiang', category: 'Productivity', capabilities: ['Interactive', 'Read', 'Write'], websiteURL: repository,
      defaultPrompt: ['开始开会，主题是本周项目同步', '刚才会上定了哪些事？', '生成会议纪要'], brandColor: '#17161A', composerIcon: './assets/icon.png', logo: './assets/icon.png', logoDark: './assets/icon.png', screenshots: [] } }, null, 2) + '\n');
  await writeFile(path.join(out, '.mcp.json'), JSON.stringify({ mcpServers: { 'meeting-assistant': { ...target.codex, cwd: '.', env_vars: passEnv, tool_timeout_sec: 120 } } }, null, 2) + '\n');
  await mkdir(path.join(out, '.claude-plugin'));
  await writeFile(path.join(out, '.claude-plugin/plugin.json'), JSON.stringify({ name: target.name, displayName: target.label, ...shared, icon: './assets/icon.png', mcpServers: { 'meeting-assistant': target.claude }, skills: './skills/' }, null, 2) + '\n');
}
await mkdir(path.join(root, '.agents/plugins'), { recursive: true });
await writeFile(path.join(root, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'meeting-assistant', interface: { displayName: 'Meeting Assistant' },
  plugins: targets.map(target => ({ name: target.name, source: { source: 'local', path: './plugins/' + target.name }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' })) }, null, 2) + '\n');
await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
await writeFile(path.join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'meeting-assistant', owner: { name: 'JacobeanJiang', url: 'https://github.com/JacobeanJiang' }, metadata: { description: 'Meeting Assistant plugins' },
  plugins: targets.map(target => ({ name: target.name, source: './plugins/' + target.name, description: description + ' (' + target.os + ')', category: 'productivity', homepage: repository, keywords })) }, null, 2) + '\n');
console.log('Plugins written to ' + path.join(root, 'plugins'));
