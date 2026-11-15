// mcp.ts — the MCP surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, plain JSON
// replies (no SSE needed). Two eras are supported: the modern 2026-07-28 discovery
// handshake (`server/discover`, preferred) and the legacy `initialize` handshake.
// Exactly six tools, in a fixed order, byte-identical across tools/list calls.
//
// Tool results carry both a text block (JSON) and structuredContent, because the suite's
// client reads either. Failures are isError results or JSON-RPC -32601/-32602 — never
// HTTP 500. A missing bearer token is rejected with 401 by the server, before this
// module is called.

import type { Forge, Repo } from './store.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcReply {
  status: number;
  body: unknown | null;
}

const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in their fixed order. Built once, never mutated, so tools/list is byte-identical. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function result(id: string | number | null, value: unknown): JsonRpcReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcReply {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A successful tool call: a text block plus the structured object. */
function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A failed tool call: isError with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** Run one tool by name with its arguments, returning its result object. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const text = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const missing = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (value === undefined || value === null || value === '') return key;
    }
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const absent = missing(['name']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.createRepo(text('name') as string, args.private === true, text('description') ?? '');
      if (repo === undefined) return toolError(`repository ${text('name')} already exists`);
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const absent = missing(['owner', 'repo']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.repo(text('owner') as string, text('repo') as string);
      if (repo === undefined) return toolError('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const absent = missing(['owner', 'repo', 'title']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.repo(text('owner') as string, text('repo') as string);
      if (repo === undefined) return toolError('repository not found');
      const issue = forge.createIssue(repo, text('title') as string, text('body') ?? '', []);
      return toolOk({ number: issue.number, title: issue.title, body: issue.body, state: issue.state, id: issue.id });
    }
    case 'list_issues': {
      const absent = missing(['owner', 'repo']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.repo(text('owner') as string, text('repo') as string);
      if (repo === undefined) return toolError('repository not found');
      const state = text('state') ?? 'open';
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state, id: issue.id }));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const absent = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.repo(text('owner') as string, text('repo') as string);
      if (repo === undefined) return toolError('repository not found');
      const head = text('head') as string;
      const base = text('base') as string;
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return toolError('unknown head or base branch');
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (duplicate !== undefined) return toolError('a pull request for this head and base already exists');
      const pull = forge.createPull(repo, text('title') as string, text('body') ?? '', head, base);
      if (pull === undefined) return toolError('unknown head or base branch');
      return toolOk({
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const absent = missing(['owner', 'repo', 'pull_number']);
      if (absent !== null) return toolError(`missing required argument: ${absent}`);
      const repo = forge.repo(text('owner') as string, text('repo') as string);
      if (repo === undefined) return toolError('repository not found');
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      if (pull.merged) return toolError('pull request is already merged');
      if (pull.state === 'closed') return toolError('pull request is closed');
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) return toolError('head or base branch is missing');
      const merged = forge.mergeFiles(repo, baseTip, headTip);
      if (merged === null) return toolError('merge conflict');
      const tree = forge.buildTreeFromMap(repo, merged);
      const sha = forge.writeCommit(repo, tree, [baseTip], `Merge pull request #${pull.number} from ${pull.head}`);
      repo.refs.set(`refs/heads/${pull.base}`, sha);
      forge.touch(repo);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = sha;
      pull.headSha = headTip;
      pull.baseSha = sha;
      return toolOk({ number: pull.number, merged: true, state: pull.state, sha });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp request. `bodyJson` is the parsed JSON body (null when there was
 * none); `bodyBad` is true when the body was not valid JSON. Notifications (no id)
 * return status 202 with a null body.
 */
export function handleMcp(forge: Forge, bodyJson: unknown, bodyBad: boolean): JsonRpcReply {
  if (bodyBad) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (bodyJson === null || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = bodyJson as JsonRpcRequest;
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get an empty 202.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover': {
      return result(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '2025-11-25';
      const accepted = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result(id, {
        protocolVersion: accepted.includes(offered) ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return result(id, {});
    }
    case 'tools/list': {
      return result(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') return failure(id, -32602, 'tool name is required');
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) return failure(id, -32601, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return result(id, callTool(forge, name, args));
    }
    default: {
      return failure(id, -32601, `method not found: ${method}`);
    }
  }
}
