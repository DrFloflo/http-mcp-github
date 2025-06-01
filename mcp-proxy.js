// mcp-proxy.js
//
// A tiny stdio→HTTP bridge for GitHub’s MCP Server Docker image.
//
// Usage:   export GITHUB_PERSONAL_ACCESS_TOKEN="⟨your_token⟩"
//          node mcp-proxy.js
//
// Then point any HTTP client (VS Code, n8n, curl…) at http://localhost:6277/tools or /execute.

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');

if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
  console.error('ERROR: GITHUB_PERSONAL_ACCESS_TOKEN is not set');
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

// Spawn the MCP server as a Docker container in stdio mode.
// • We rely on the image’s default command: “ghcr.io/github/github-mcp-server” (which does MCP stdio by default).
// • You do NOT pass “http” or “github-mcp-server” here—just the image name.
const mcp = spawn('docker', [
  'run', '-i', '--rm',
  '-e', `GITHUB_PERSONAL_ACCESS_TOKEN=${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
  '-e', 'GITHUB_TOOLSETS=repos,issues',
  'ghcr.io/github/github-mcp-server'
], {
  env: process.env
});

mcp.stderr.on('data', (d) => {
  // Docker + MCP logs everything to stderr/stdout. If the token is invalid or something crashes,
  // you’ll see it here immediately.
  console.error('[MCP stderr]', d.toString());
});

// We’ll buffer incoming data from MCP stdout until we can parse a full JSON-RPC frame.
let stdoutBuffer = '';
mcp.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  // The MCP server writes exactly one JSON object per line, so we can split on "\n".
  // If you see multiple JSON objects, this will handle them in sequence.
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      console.error('[MCP parse error]', e, 'line=', line);
      continue;
    }
    const { id, result, error } = parsed;
    if (pending.has(id)) {
      const { res } = pending.get(id);
      pending.delete(id);
      if (error) {
        res.status(500).json({ error });
      } else {
        res.json(result);
      }
    }
  }
});

const pending = new Map(); // map<id, { res }>

let nextId = 1;

// List tools: maps GET /tools → JSON list
app.get('/tools', (req, res) => {
  const id = nextId++;
  const payload = {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {}
  };
  pending.set(id, { res });
  mcp.stdin.write(JSON.stringify(payload) + '\n');
});

// Execute a tool: expects { "tool": "name", "args": { … } }
app.post('/execute', (req, res) => {
  const { tool, args } = req.body;
  console.log('[to-MCP] payload.params.tool =', tool);
  if (typeof tool !== 'string' || typeof args !== 'object') {
    return res.status(400).json({ error: 'Body must have { tool: string, args: object }' });
  }
  const id = nextId++;
  const payload = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: tool, arguments: args }
  };
  console.log('[to-MCP] full JSON-RPC →', JSON.stringify(payload));
  pending.set(id, { res });
  mcp.stdin.write(JSON.stringify(payload) + '\n');
});

const PORT = 6277;
app.listen(PORT, () => {
  console.log(`MCP proxy HTTP listening on http://localhost:${PORT}`);
});
