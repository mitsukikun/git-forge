// server.ts — the HTTP plumbing: one Node http server, keep-alive held open for the
// benchmark's warm connection, a request id on every reply, and routing to the four
// surfaces. Auth (Bearer <MAKEFUN_SHOP_TOKEN>) is enforced here for every surface
// except GET /healthz and the two unauthenticated REST reads (GET /api/v3/ and
// GET /api/v3/meta); everything else without a valid token is a 401.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitAnswer } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Forge } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Cheap per-request ids (the checks only require X-GitHub-Request-Id to be non-empty). */
let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `gitforge-${process.pid}-${requestSeq}`;
}

/** Read the whole request body, or null when it exceeds the limit. */
function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** A header value as a single string (the first, when repeated), or undefined. */
function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendGit(response: ServerResponse, answer: GitAnswer): void {
  response.writeHead(answer.status, {
    'content-type': answer.contentType,
    'content-length': answer.body.length,
    'x-github-request-id': requestId(),
  });
  response.end(answer.body);
}

/** Parse a JSON body; returns the value, or { bad: true } when it is not valid JSON. */
function parseJson(body: Buffer): { value: unknown; bad: boolean } {
  if (body.length === 0) return { value: null, bad: false };
  try {
    return { value: JSON.parse(body.toString('utf8')) as unknown, bad: false };
  } catch {
    return { value: null, bad: true };
  }
}

/** Create the forge's HTTP server. It listens on the port the caller chooses (0 = ephemeral). */
export function createForgeServer(forge: Forge) {
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(forge, request, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!response.headersSent) sendJson(response, 500, { message });
      else response.destroy();
    }
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 65_000;
  return server;
}

async function handleRequest(forge: Forge, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
  const segments = path.split('/').filter((segment) => segment !== '');

  // The boot probe: no auth, plain text.
  if (path === '/healthz') {
    if (method !== 'GET') {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2, 'x-github-request-id': requestId() });
    response.end('ok');
    return;
  }

  const authed = forge.tokenOk(request.headers.authorization);

  // ---- git smart HTTP: /{owner}/{repo}.git/... ----
  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const tail = segments.slice(2);
    if (!authed) {
      sendJson(response, 401, { message: 'Unauthorized' });
      return;
    }
    const body = (await readBody(request)) ?? Buffer.alloc(0);
    const gitProtocol = headerString(request.headers['git-protocol']);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = url.searchParams.get('service') ?? '';
      sendGit(response, handleInfoRefs(forge, owner, repoName, service, gitProtocol));
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const repo = forge.repo(owner, repoName);
      if (repo === undefined) {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      sendGit(response, handleUploadPack(repo, forge, body, gitProtocol));
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const repo = forge.repo(owner, repoName);
      if (repo === undefined) {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      sendGit(response, handleReceivePack(repo, forge, body));
      return;
    }
    sendJson(response, 404, { message: 'Not Found' });
    return;
  }

  // ---- GraphQL: POST /api/graphql (batch arrays answered in order) ----
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    if (!authed) {
      sendJson(response, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      sendJson(response, 413, { message: 'request body too large' });
      return;
    }
    const parsed = parseJson(body);
    if (parsed.bad) {
      sendJson(response, 200, { data: null, errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    if (Array.isArray(parsed.value)) {
      sendJson(response, 200, parsed.value.map((operation) => handleGraphql(forge, operation)));
      return;
    }
    sendJson(response, 200, handleGraphql(forge, parsed.value));
    return;
  }

  // ---- MCP: POST /mcp ----
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    if (!authed) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'x-github-request-id': requestId(),
      });
      response.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } })}\n`);
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      sendJson(response, 413, { message: 'request body too large' });
      return;
    }
    const parsed = parseJson(body);
    const reply = handleMcp(forge, parsed.value, parsed.bad);
    if (reply.body === null) {
      response.writeHead(reply.status, { 'x-github-request-id': requestId() });
      response.end();
      return;
    }
    sendJson(response, reply.status, reply.body);
    return;
  }

  // ---- REST v3: /api/v3/... ----
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const publicRead =
      method === 'GET' && (restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta'));
    if (!publicRead && !authed) {
      sendJson(response, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      sendJson(response, 413, { message: 'request body too large' });
      return;
    }
    const parsed = parseJson(body);
    const reply = handleRest(forge, method, restSegments, url.searchParams, parsed.bad ? null : (parsed.value as Record<string, unknown> | null), parsed.bad, origin);
    const headers: Record<string, string> = { 'x-github-request-id': requestId() };
    if (reply.headers !== undefined) Object.assign(headers, reply.headers);
    if (reply.status === 204 || reply.body === null) {
      response.writeHead(reply.status, headers);
      response.end();
      return;
    }
    sendJson(response, reply.status, reply.body, headers);
    return;
  }

  sendJson(response, 404, { message: 'Not Found' });
}
