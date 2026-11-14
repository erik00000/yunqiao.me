/**
 * 生成一份演示数据（假 Key，不会真的发请求）。
 * 用法：node scripts/seed-demo.mjs .devdata
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.devdata');
fs.mkdirSync(path.join(dir, 'usage'), { recursive: true });

const now = new Date().toISOString();
const k = (id, label, key) => ({ id, label, key, enabled: true, weight: 1 });

const providers = [
  {
    id: 'prov_deepseek',
    name: 'DeepSeek 深度求索',
    presetId: 'deepseek',
    format: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    apiKeys: [k('k1', '主号', 'sk-demo-1234567890abcdef'), k('k2', '备用', 'sk-demo-fedcba0987654321')],
    models: [
      { id: 'deepseek-chat', contextWindow: 128000, inputPrice: 0.27, outputPrice: 1.1, capabilities: { tools: true, vision: false, thinking: false }, thinkingField: 'none' },
      { id: 'deepseek-reasoner', contextWindow: 128000, inputPrice: 0.55, outputPrice: 2.19, capabilities: { tools: true, vision: false, thinking: true }, thinkingField: 'enable_thinking' },
    ],
    enabled: true,
    priority: 20,
    color: '#4d6bfe',
    icon: '🐳',
    rateMultiplier: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'prov_kimi',
    name: 'Kimi 月之暗面',
    presetId: 'moonshot',
    format: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeys: [k('k3', '默认', 'sk-demo-kimi-0000')],
    models: [
      { id: 'kimi-k2-turbo-preview', contextWindow: 262144, inputPrice: 0.28, outputPrice: 1.15, capabilities: { tools: true, vision: true, thinking: true } },
    ],
    enabled: true,
    priority: 15,
    color: '#0f172a',
    icon: '🌙',
    rateMultiplier: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'prov_claude',
    name: 'Claude 官方',
    presetId: 'anthropic',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeys: [k('k4', '官方 Key', 'sk-ant-demo-000000')],
    models: [
      { id: 'claude-sonnet-4-5', contextWindow: 1000000, inputPrice: 3, outputPrice: 15, capabilities: { tools: true, vision: true, thinking: true } },
      { id: 'claude-haiku-4-5', contextWindow: 200000, inputPrice: 1, outputPrice: 5, capabilities: { tools: true, vision: true, thinking: true } },
    ],
    enabled: true,
    priority: 30,
    color: '#d97757',
    icon: '✳',
    rateMultiplier: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'prov_relay',
    name: '某某中转站',
    presetId: 'relay-openai',
    format: 'openai-chat',
    baseUrl: 'https://api.example-relay.com/v1',
    apiKeys: [k('k5', '倍率 0.15', 'sk-relay-demo')],
    models: [
      { id: 'gpt-5.1-codex', contextWindow: 400000, inputPrice: 1.25, outputPrice: 10, capabilities: { tools: true, vision: true, thinking: true } },
      { id: 'gpt-4.1', contextWindow: 1047576, inputPrice: 2, outputPrice: 8, capabilities: { tools: true, vision: true } },
    ],
    enabled: true,
    priority: 25,
    color: '#64748b',
    icon: '🔌',
    rateMultiplier: 0.15,
    notes: 'new-api 中转，倍率 0.15',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'prov_glm',
    name: '智谱 GLM',
    presetId: 'zhipu',
    format: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeys: [k('k6', 'Coding Plan', 'demo.glm.key')],
    models: [
      { id: 'glm-4.6', contextWindow: 200000, inputPrice: 0.6, outputPrice: 2.2, capabilities: { tools: true, vision: true, thinking: true } },
      { id: 'glm-4-flash', contextWindow: 128000, inputPrice: 0, outputPrice: 0, capabilities: { tools: true } },
    ],
    enabled: false,
    priority: 10,
    color: '#2f6bff',
    icon: '🔷',
    rateMultiplier: 1,
    createdAt: now,
    updatedAt: now,
  },
];

const groups = [
  {
    id: 'grp_coding',
    name: 'coding',
    mode: 'order',
    members: [
      { providerId: 'prov_claude', model: 'claude-sonnet-4-5', weight: 1 },
      { providerId: 'prov_relay', model: 'gpt-5.1-codex', weight: 1 },
      { providerId: 'prov_deepseek', model: 'deepseek-chat', weight: 1 },
    ],
    enabled: true,
    retries: 2,
    notes: '额度用完了自动往后走',
    createdAt: now,
  },
  {
    id: 'grp_cheap',
    name: 'cheap',
    mode: 'rotate',
    members: [
      { providerId: 'prov_deepseek', model: 'deepseek-chat', weight: 2 },
      { providerId: 'prov_kimi', model: 'kimi-k2-turbo-preview', weight: 1 },
    ],
    enabled: true,
    retries: 1,
    createdAt: now,
  },
];

const settings = {
  language: 'zh-CN',
  theme: 'dark',
  accent: '#6d8cff',
  gatewayHost: '127.0.0.1',
  gatewayPort: 3425,
  autoStartGateway: true,
  launchAtLogin: false,
  closeToTray: true,
  proxy: '',
  maskSecrets: true,
  autoTrimContext: true,
  maxRetries: 2,
  requestTimeoutMs: 600000,
  usageRetentionDays: 90,
  lanShare: false,
  gatewayToken: '',
  webdavUrl: '',
  webdavUser: '',
  webdavPass: '',
  firstByteTimeoutMs: 120000,
  logRequests: true,
  updatedAt: now,
};

const plugins = [
  { id: 'model-map', name: '模型别名', description: '把 fast 映射到便宜的模型', builtin: true, enabled: true, options: { mapping: { fast: 'deepseek/deepseek-chat' } }, updatedAt: now },
  { id: 'system-prompt', name: '统一系统提示', description: '给每个请求追加团队规范', builtin: true, enabled: false, options: { text: '始终使用简体中文回答。' }, updatedAt: now },
  { id: 'token-budget', name: '上下文裁剪', description: '超过上限丢弃最早轮次', builtin: true, enabled: true, options: { maxTokens: 180000 }, updatedAt: now },
];

const agents = {
  'claude-code': { id: 'claude-code', connected: true, providerId: 'prov_deepseek', model: 'deepseek-chat', lastSyncAt: now },
  'codex-cli': { id: 'codex-cli', connected: true, providerId: 'prov_relay', model: 'gpt-5.1-codex', lastSyncAt: now },
  'gemini-cli': { id: 'gemini-cli', connected: false },
  workbuddy: { id: 'workbuddy', connected: false },
};

// 演示用量：14 天
const models = [
  ['prov_claude', 'Claude 官方', 'claude-sonnet-4-5'],
  ['prov_deepseek', 'DeepSeek 深度求索', 'deepseek-chat'],
  ['prov_relay', '某某中转站', 'gpt-5.1-codex'],
  ['prov_kimi', 'Kimi 月之暗面', 'kimi-k2-turbo-preview'],
];
for (let d = 13; d >= 0; d--) {
  const day = new Date(Date.now() - d * 86400000);
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const lines = [];
  const n = 6 + Math.floor(Math.random() * 14);
  for (let i = 0; i < n; i++) {
    const [pid, pname, model] = models[Math.floor(Math.random() * models.length)];
    const input = 2000 + Math.floor(Math.random() * 60000);
    const output = 300 + Math.floor(Math.random() * 4000);
    const cost = (input / 1e6) * (model.includes('claude') ? 3 : 0.6) + (output / 1e6) * (model.includes('claude') ? 15 : 2);
    lines.push(
      JSON.stringify({
        ts: new Date(day.getTime() + i * 600000).toISOString(),
        agent: ['Claude Code', 'Codex', 'Gemini CLI'][Math.floor(Math.random() * 3)],
        providerId: pid,
        providerName: pname,
        model,
        requestModel: model,
        protocol: 'openai-chat',
        stream: true,
        status: Math.random() > 0.94 ? 502 : 200,
        inputTokens: input,
        outputTokens: output,
        cacheRead: Math.floor(input * 0.4),
        cacheWrite: 0,
        cost,
        latencyMs: 900 + Math.floor(Math.random() * 9000),
        firstByteMs: 200 + Math.floor(Math.random() * 1800),
        attempts: 1,
        requestId: 'req_' + Math.random().toString(36).slice(2, 12),
      }),
    );
  }
  fs.writeFileSync(path.join(dir, 'usage', `${key}.jsonl`), lines.join('\n') + '\n');
}

fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(providers, null, 2));
fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify(groups, null, 2));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify(plugins, null, 2));
fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
console.log('演示数据已写入', dir);
