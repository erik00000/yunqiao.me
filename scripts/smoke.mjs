/**
 * 端到端冒烟测试：不需要任何真实 API Key。
 * 起一个假的 OpenAI 上游，再让极光网关把 Anthropic / Responses / Gemini 三种
 * 客户端协议都转过去，验证「请求→IR→上游→IR→客户端」整条链路。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-smoke-'));
const UP_PORT = 4788;
const GW_PORT = 4789;
const GW_TOKEN = 'aurora-smoke-only-token';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ---------------- 假上游：OpenAI Chat 兼容 ---------------- */
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const stream = !!parsed.stream;
    const hasTools = (parsed.messages ?? []).some((m) => m.role === 'tool' || m.tool_calls);
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '你好，我是假上游。',
                ...(hasTools
                  ? {
                      tool_calls: [
                        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
                      ],
                    }
                  : {}),
              },
              finish_reason: hasTools ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ id: 'chatcmpl-mock', model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    send({ id: 'chatcmpl-mock', model: parsed.model, choices: [{ index: 0, delta: { content: '你好' } }] });
    send({ id: 'chatcmpl-mock', model: parsed.model, choices: [{ index: 0, delta: { content: '，世界' } }] });
    send({
      id: 'chatcmpl-mock',
      model: parsed.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

/* ---------------- 工具 ---------------- */
function post(pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: GW_PORT, path: pathname, method: 'POST', headers: { authorization: `Bearer ${GW_TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: GW_PORT, path: '/health' }, resolve).on('error', reject);
      });
      if (r.statusCode === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------- 主流程 ---------------- */
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

// 预置一个指向假上游的供应商
const provider = {
  id: 'prov_mock',
  name: '假上游',
  presetId: 'relay-openai',
  format: 'openai-chat',
  baseUrl: `http://127.0.0.1:${UP_PORT}/v1`,
  apiKeys: [{ id: 'key_mock', label: 'mock', key: 'sk-mock', enabled: true, weight: 1 }],
  models: [
    { id: 'mock-model', contextWindow: 128000, inputPrice: 1, outputPrice: 2, capabilities: { tools: true, vision: true } },
  ],
  enabled: true,
  priority: 10,
  rateMultiplier: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify([provider], null, 2));
fs.writeFileSync(
  path.join(DATA, 'settings.json'),
  JSON.stringify({ gatewayPort: GW_PORT, gatewayHost: '127.0.0.1', gatewayToken: GW_TOKEN, logRequests: true, maxRetries: 1 }, null, 2),
);

const gw = spawn(process.execPath, [path.join(root, 'dist/main/gateway-cli.cjs'), '--data', DATA, '--port', String(GW_PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwLog = '';
gw.stdout.on('data', (d) => (gwLog += d));
gw.stderr.on('data', (d) => (gwLog += d));

try {
  const healthy = await waitHealth();
  check('网关启动 /health', healthy, healthy ? '' : gwLog.slice(0, 300));

  // 1. Anthropic → OpenAI Chat（流式）
  const a = await post('/v1/messages', {
    model: 'mock-model',
    max_tokens: 100,
    stream: true,
    system: '你是助手',
    messages: [{ role: 'user', content: '你好' }],
  });
  check('Anthropic 入口返回 200', a.status === 200, `status=${a.status}`);
  check('Anthropic 流含 message_start', a.text.includes('message_start'));
  check('Anthropic 流含文本增量', a.text.includes('你好'));
  check('Anthropic 流含 message_stop', a.text.includes('message_stop'));

  // 2. OpenAI Chat → 同协议（非流式）
  const b = await post('/v1/chat/completions', {
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const bj = JSON.parse(b.text);
  check('Chat 非流式内容正确', bj.choices?.[0]?.message?.content?.includes('假上游'), b.text.slice(0, 120));
  check('Chat usage 透传', bj.usage?.prompt_tokens === 12);

  // 3. Responses（Codex）流式
  const c = await post('/v1/responses', {
    model: 'mock-model',
    stream: true,
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  });
  check('Responses 入口返回 200', c.status === 200, `status=${c.status}`);
  check('Responses 含 response.created', c.text.includes('response.created'));
  check('Responses 含 output_text.delta', c.text.includes('response.output_text.delta'));
  check('Responses 含 response.completed', c.text.includes('response.completed'));

  // 4. Gemini 原生入口
  const d = await post('/v1beta/models/mock-model:generateContent', {
    contents: [{ role: 'user', parts: [{ text: '你好' }] }],
  });
  const dj = JSON.parse(d.text);
  check('Gemini 入口返回候选', !!dj.candidates?.[0]?.content?.parts?.length, d.text.slice(0, 120));

  // 5. 未知模型 → 应报错但仍然可读
  const e = await post('/v1/chat/completions', { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] });
  check('未配置模型不会被发往任意供应商', e.status === 400, `status=${e.status}`);

  // 6. 用量是否落盘
  const usageDir = path.join(DATA, 'usage');
  const files = fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : [];
  check('用量日志已写入', files.length > 0, files.join(','));
} finally {
  gw.kill();
  upstream.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('网关日志：\n' + gwLog.slice(-2000));
  process.exit(1);
}
