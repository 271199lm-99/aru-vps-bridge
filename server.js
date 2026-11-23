const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.BRIDGE_PORT || '8790', 10);
const ROOT = 'C:\\aru';

function readToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN.trim();
  try { return fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim(); }
  catch (e) { return ''; }
}

const TOKEN = readToken();

const TOOLS = [
  {
    name: 'run',
    description: '在 VPS 上执行 PowerShell 命令，返回 stdout 和 stderr。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell 命令' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: '读取一个 UTF-8 文本文件。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'write_file',
    description: '写入 UTF-8 文本文件，父目录不存在会自动创建。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_dir',
    description: '列出目录内容。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
];

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function runPowerShell(command, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs || 120000, windowsHide: true },
      function (err, stdout, stderr) {
        const parts = [];
        if (stdout) parts.push(String(stdout));
        if (stderr) parts.push('[stderr]\n' + String(stderr));
        if (err) parts.push('[exit] ' + String(err.message));
        resolve(parts.join('\n').trim() || '(no output)');
      }
    );
  });
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'run') {
    const cmd = String(args.command || '');
    if (!cmd) throw new Error('command is required');
    return await runPowerShell(cmd, args.timeoutMs);
  }
  if (name === 'read_file') {
    return fs.readFileSync(String(args.path), 'utf8');
  }
  if (name === 'write_file') {
    const p = String(args.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(args.content), 'utf8');
    return 'written: ' + p;
  }
  if (name === 'list_dir') {
    const p = String(args.path || ROOT);
    const items = fs.readdirSync(p, { withFileTypes: true });
    const lines = items.map(function (d) {
      return (d.isDirectory() ? '[dir]  ' : '[file] ') + d.name;
    });
    return lines.join('\n') || '(empty)';
  }
  throw new Error('unknown tool: ' + name);
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const qToken = url.searchParams.get('token') || '';
  const auth = req.headers['authorization'] || '';
  const headerToken = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
  const authed = TOKEN && (qToken === TOKEN || headerToken === TOKEN);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'aru-vps-bridge', tools: TOOLS.length });
  }
  if (!authed) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  if (req.method === 'DELETE') {
    res.writeHead(200);
    return res.end();
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', function (chunk) { raw += chunk; });
  req.on('end', async function () {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (Array.isArray(msg)) msg = msg[0];
    const id = msg.id === undefined ? null : msg.id;
    const method = msg.method;

    if (method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0', id: id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'aru-vps-bridge', version: '1.0.0' }
        }
      });
    }
    if (method === 'ping') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: id, result: {} });
    }
    if (method === 'tools/list') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const params = msg.params || {};
      try {
        const text = await callTool(params.name, params.arguments);
        return sendJson(res, 200, {
          jsonrpc: '2.0', id: id,
          result: { content: [{ type: 'text', text: String(text) }] }
        });
      } catch (e) {
        return sendJson(res, 200, {
          jsonrpc: '2.0', id: id,
          result: { content: [{ type: 'text', text: 'ERROR: ' + String(e.message) }], isError: true }
        });
      }
    }
    if (typeof method === 'string' && method.indexOf('notifications/') === 0) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 200, { jsonrpc: '2.0', id: id, result: {} });
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('aru-vps-bridge listening on ' + PORT + ' (token ' + (TOKEN ? 'loaded' : 'MISSING') + ')');
});
