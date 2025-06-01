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
  console.log('[MCP stdout raw]', chunk.toString());
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
    // If this id was registered for an SSE stream, send it as an SSE event:
    if (ssePending.has(id)) {
      const { res: sseRes, remaining } = ssePending.get(id);

      // Build a JSON-RPC response object to send as SSE data:
      const sseMessage = JSON.stringify(parsed);
      console.log('[SSE] sending event for id=', id, 'msg=', sseMessage);
      // Send one SSE event:
      //   data: <json>\n\n
      sseRes.write(`data: ${sseMessage}\n\n`);

      // Remove this id from the “remaining” set.
      remaining.delete(id);

      // If that was the last pending id for this SSE client, close the stream:
      if (remaining.size === 0) {
        sseRes.end();
        ssePending.delete(id);
      } else {
        // otherwise, keep the entry alive under the other ids in “remaining”:
        // (no action needed here; we only remove this id)
      }
    }
  }
});

const pending = new Map(); // map<id, { res }>
const ssePending = new Map();

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
  console.log('[to-MCP] forwarding to MCP.stdin →', JSON.stringify(payload));
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
  console.log('[to-MCP] forwarding to MCP.stdin →', JSON.stringify(payload));
  mcp.stdin.write(JSON.stringify(payload) + '\n');
});

app.post('/sse', (req, res) => {
  // Must be raw JSON array or single object (JSON-RPC request[s]).
  // We expect Content-Type: application/json and a JSON-RPC object or array in req.body.
  console.log('[SSE] raw req.body =', JSON.stringify(req.body));
  console.log('[SSE] req.headers =', JSON.stringify(req.headers));
  // 1) Prepare this response as SSE:
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // (Optionally) 'Access-Control-Allow-Origin': '*' 
  });
  res.flushHeaders(); // send headers right away

  // 2) Normalize incoming JSON-RPC request(s) into an array:
  let requests = req.body;
  if (!Array.isArray(requests)) {
    requests = [requests];
  }

  // 3) Collect all request IDs for this SSE client:
  const remaining = new Set();
  for (const rpcReq of requests) {
    if (typeof rpcReq.id !== 'number') {
      // If an incoming request is missing "id", we can’t map the reply back.
      // Immediately send an error as SSE and close.
      const errBody = JSON.stringify({
        jsonrpc: '2.0',
        id: rpcReq.id || null,
        error: { code: -32600, message: 'Missing or invalid id' }
      });
      res.write(`data: ${errBody}\n\n`);
      return res.end();
    }
    remaining.add(rpcReq.id);
    // Register in ssePending so stdout handler can pick it up:
    ssePending.set(rpcReq.id, { res, remaining });
  }

  // 4) When the client closes the HTTP connection prematurely, clean up:
  req.on('close', () => {
    for (const rpcReq of requests) {
      ssePending.delete(rpcReq.id);
    }
  });

  // 5) Forward each JSON-RPC request (raw) to MCP’s stdin:
  for (const rpcReq of requests) {
    console.log('[SSE] forwarding to MCP.stdin →', JSON.stringify(rpcReq));
    mcp.stdin.write(JSON.stringify(rpcReq) + '\n');
  }
});

const PORT = 6277;
app.listen(PORT, () => {
  console.log(`MCP proxy HTTP listening on http://localhost:${PORT}`);
});
