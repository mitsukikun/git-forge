// rest.ts — the REST v3 surface: repositories, branches, commits, contents, labels,
// issues, pull requests and merges. Every reply is JSON and carries
// X-GitHub-Request-Id (added by the server); errors are JSON with a string message.
//
// Numbering: issues and pull requests share one counter per repository, starting at 1.
// Ownership: a repository belongs to the token's login; the same name under another
// owner is a 404, never a 403.

import { ZERO_OID, isOid, parseCommit, parseTree } from './gitcore.ts';
import { blobText, type Forge, type Issue, type Pull, type Repo } from './store.ts';

/** What a REST handler returns: status, body (JSON value, or null for an empty body). */
export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function reply(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function error(status: number, message: string): RestReply {
  return reply(status, { message });
}

/** The shape of a decoded JSON request body, or null when there was no body. */
export type BodyJson = Record<string, unknown> | null;

/** Read a string field from a JSON body, or undefined when it is absent or not a string. */
function field(body: BodyJson, name: string): string | undefined {
  if (body === null) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: BodyJson, name: string): boolean {
  if (body === null) return false;
  return body[name] === true;
}

// -------------------------------------------------------------------------------------------
// presentation
// -------------------------------------------------------------------------------------------

function repoJson(forge: Forge, repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: b64(`repo:${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function branchJson(repo: Repo, name: string, sha: string, origin: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function refJson(repo: Repo, ref: string, sha: string, origin: string): Record<string, unknown> {
  return {
    ref,
    node_id: b64(`ref:${repo.owner}/${repo.name}:${ref}`),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
    object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64(`issue:${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: forge.viewer.login },
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: b64(`pull:${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: forge.viewer.login },
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function parsePage(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice a list to one page and build the Link header (rel="next", absolute, same origin). */
function paginate<T>(items: T[], page: Page, origin: string, path: string, query: URLSearchParams): { page: T[]; link: string | null } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  let link: string | null = null;
  if (start + page.perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page.page + 1));
    next.set('per_page', String(page.perPage));
    link = `<${origin}${path}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

// -------------------------------------------------------------------------------------------
// tree reads for contents
// -------------------------------------------------------------------------------------------

type TreeLookup =
  | { kind: 'file'; oid: string; mode: string }
  | { kind: 'dir'; entries: Array<{ name: string; oid: string; mode: string; type: 'file' | 'dir' }> }
  | null;

/** Walk a tree to `path` ('' = the root): a file, a directory listing, or null. */
function lookupPath(repo: Repo, treeOid: string, path: string): TreeLookup {
  if (path === '') {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    return {
      kind: 'dir',
      entries: parseTree(object.data).map((entry) => ({
        name: entry.name,
        oid: entry.oid,
        mode: entry.mode,
        type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      })),
    };
  }
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const name = segments[i] as string;
    const entry = parseTree(object.data).find((candidate) => candidate.name === name);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (last) {
      if (entry.mode === '40000') {
        const child = repo.objects.get(entry.oid);
        if (child === undefined || child.type !== 'tree') return null;
        return {
          kind: 'dir',
          entries: parseTree(child.data).map((candidate) => ({
            name: candidate.name,
            oid: candidate.oid,
            mode: candidate.mode,
            type: candidate.mode === '40000' ? ('dir' as const) : ('file' as const),
          })),
        };
      }
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Resolve a ref name (branch, or a raw commit id) to its commit id, or the zero id. */
function resolveRef(repo: Repo, ref: string | undefined): string {
  if (ref === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (isOid(ref)) return repo.objects.has(ref) ? ref : ZERO_OID;
  return repo.refs.get(`refs/heads/${ref}`) ?? ZERO_OID;
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the path parts after /api/v3, `query` the parsed
 * query string, `origin` the request's own base URL (for absolute Link and url fields).
 * Auth is enforced by the server before this is called, except for GET / and GET /meta.
 */
export function handleRest(
  forge: Forge,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: BodyJson,
  bodyBad: boolean,
  origin: string,
): RestReply {
  if (bodyBad) return error(400, 'malformed JSON body');

  // GET /api/v3/ — the root (unauthenticated).
  if (segments.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    return reply(200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_url: `${origin}/api/v3/users/{user}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta (unauthenticated).
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return error(404, 'Not Found');
    return reply(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user and /api/v3/user/repos.
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      return reply(200, { login: forge.viewer.login, id: 1000, type: 'User' });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const page = parsePage(query);
        const all = forge.listRepos().map((repo) => repoJson(forge, repo, origin));
        const { page: slice, link } = paginate(all, page, origin, '/api/v3/user/repos', query);
        return reply(200, slice, link === null ? undefined : { Link: link });
      }
      if (method === 'POST') {
        const name = field(body, 'name');
        if (name === undefined || name === '') return error(422, 'name is required');
        const repo = forge.createRepo(name, boolField(body, 'private'), field(body, 'description') ?? '');
        if (repo === undefined) return error(422, `Repository ${name} already exists`);
        return reply(201, repoJson(forge, repo, origin));
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // Everything below is /repos/{owner}/{name}[/...].
  if (segments[0] !== 'repos' || segments.length < 3) return error(404, 'Not Found');
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = forge.repo(owner, name);
  if (repo === undefined) return error(404, 'Not Found');
  const rest = segments.slice(3);

  // /repos/{o}/{r} — read, update, delete.
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoJson(forge, repo, origin));
    if (method === 'PATCH') {
      const description = field(body, 'description');
      if (description !== undefined) repo.description = description;
      return reply(200, repoJson(forge, repo, origin));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(name);
      return reply(204, null);
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/branches
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
      names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a.localeCompare(b)));
      return reply(200, names.map((branch) => branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) as string, origin)));
    }
    if (rest.length === 2) {
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (method !== 'GET' || sha === undefined) return error(404, 'Not Found');
      return reply(200, branchJson(repo, branch, sha, origin));
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits') {
    if (method !== 'GET' || rest.length > 1) return error(404, 'Not Found');
    const tip = resolveRef(repo, query.get('sha') ?? undefined);
    if (tip === ZERO_OID) return reply(200, []);
    const list = forge.commitList(repo, tip).map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message },
      author: { login: forge.viewer.login },
      committer: { login: forge.viewer.login },
      parents: (() => {
        const object = repo.objects.get(commit.sha);
        if (object === undefined || object.type !== 'commit') return [];
        return parseCommit(object.data).parents.map((parent) => ({ sha: parent }));
      })(),
    }));
    const page = parsePage(query);
    const { page: slice, link } = paginate(list, page, origin, `/api/v3/repos/${owner}/${name}/commits`, query);
    return reply(200, slice, link === null ? undefined : { Link: link });
  }

  // /repos/{o}/{r}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = field(body, 'ref');
      const sha = field(body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return error(422, 'ref and sha are required');
      if (!repo.objects.has(sha)) return error(422, 'unknown sha');
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      forge.touch(repo);
      return reply(201, refJson(repo, ref, sha, origin));
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return error(404, 'Not Found');
      return reply(200, refJson(repo, ref, sha, origin));
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/contents[/{path}]
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponentSafe).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, query.get('ref') ?? undefined);
      if (tip === ZERO_OID) return error(404, 'Not Found');
      const object = repo.objects.get(tip);
      if (object === undefined || object.type !== 'commit') return error(404, 'Not Found');
      const found = lookupPath(repo, parseCommit(object.data).tree, path);
      if (found === null) return error(404, 'Not Found');
      if (found.kind === 'file') {
        const blob = repo.objects.get(found.oid);
        const data = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
        return reply(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: data.toString('base64'),
          sha: found.oid,
          url: `${origin}/api/v3/repos/${owner}/${name}/contents/${path}`,
          html_url: `${origin}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
          download_url: null,
        });
      }
      return reply(200, found.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        url: `${origin}/api/v3/repos/${owner}/${name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
      })));
    }
    if (method === 'PUT') {
      const message = field(body, 'message') ?? `Update ${path}`;
      const content = field(body, 'content');
      if (content === undefined) return error(422, 'content is required');
      let data: Buffer;
      try {
        data = Buffer.from(content, 'base64');
      } catch {
        return error(400, 'content is not valid base64');
      }
      const branch = field(body, 'branch') ?? repo.defaultBranch;
      let branchRef = `refs/heads/${branch}`;
      if (!repo.refs.has(branchRef)) {
        const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
      }
      const tip = repo.refs.get(branchRef) ?? ZERO_OID;
      let existing: string | null = null;
      if (tip !== ZERO_OID) {
        const object = repo.objects.get(tip);
        if (object !== undefined && object.type === 'commit') {
          const found = lookupPath(repo, parseCommit(object.data).tree, path);
          if (found !== null && found.kind === 'file') existing = found.oid;
        }
      }
      const sha = field(body, 'sha');
      if (existing !== null) {
        if (sha === undefined) return error(422, 'sha is required to update a file');
        if (sha !== existing) return error(409, 'sha does not match the current file');
      }
      const { commit, blob } = forge.commitFile(repo, branch, path, data, message);
      return reply(existing === null ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blob, size: data.length, encoding: 'base64' },
        commit: { sha: commit, message },
      });
    }
    if (method === 'DELETE') {
      const message = field(body, 'message') ?? `Delete ${path}`;
      const branch = field(body, 'branch') ?? repo.defaultBranch;
      const branchRef = `refs/heads/${branch}`;
      const tip = repo.refs.get(branchRef) ?? ZERO_OID;
      if (tip === ZERO_OID) return error(404, 'Not Found');
      const object = repo.objects.get(tip);
      if (object === undefined || object.type !== 'commit') return error(404, 'Not Found');
      const found = lookupPath(repo, parseCommit(object.data).tree, path);
      if (found === null || found.kind !== 'file') return error(404, 'Not Found');
      const sha = field(body, 'sha');
      if (sha !== undefined && sha !== found.oid) return error(409, 'sha does not match the current file');
      const { commit } = forge.commitFile(repo, branch, path, null, message);
      return reply(200, { commit: { sha: commit, message } });
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return reply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST' && rest.length === 1) {
      const name = field(body, 'name');
      const color = field(body, 'color') ?? '000000';
      if (name === undefined || name === '') return error(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return reply(201, { name: existing.name, color: existing.color });
      repo.labels.set(name, { name, color });
      return reply(201, { name, color });
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues...
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const page = parsePage(query);
        const { page: slice, link } = paginate(list.map((issue) => issueJson(forge, repo, issue, origin)), page, origin, `/api/v3/repos/${owner}/${name}/issues`, query);
        return reply(200, slice, link === null ? undefined : { Link: link });
      }
      if (method === 'POST') {
        const title = field(body, 'title');
        if (title === undefined || title === '') return error(422, 'title is required');
        const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return error(422, `unknown label: ${label}`);
        }
        const issue = forge.createIssue(repo, title, field(body, 'body') ?? '', labels);
        return reply(201, issueJson(forge, repo, issue, origin));
      }
      return error(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return error(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return reply(200, issueJson(forge, repo, issue, origin));
      if (method === 'PATCH') {
        const state = field(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = field(body, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = field(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        return reply(200, issueJson(forge, repo, issue, origin));
      }
      return error(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        return reply(200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: b64(`comment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`),
          body: comment.body,
          user: { login: forge.viewer.login },
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        })));
      }
      if (method === 'POST') {
        const text = field(body, 'body');
        if (text === undefined) return error(422, 'body is required');
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: text };
        issue.comments.push(comment);
        return reply(201, {
          id: comment.id,
          node_id: b64(`comment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`),
          body: comment.body,
          user: { login: forge.viewer.login },
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // /repos/{o}/{r}/pulls...
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = parsePage(query);
        const { page: slice, link } = paginate(list.map((pull) => pullJson(forge, repo, pull, origin)), page, origin, `/api/v3/repos/${owner}/${name}/pulls`, query);
        return reply(200, slice, link === null ? undefined : { Link: link });
      }
      if (method === 'POST') {
        const title = field(body, 'title');
        const head = field(body, 'head');
        const base = field(body, 'base');
        if (title === undefined || head === undefined || base === undefined) return error(422, 'title, head and base are required');
        if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) return error(422, 'unknown head or base branch');
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
        if (duplicate !== undefined) return error(422, 'a pull request for this head and base already exists');
        const pull = forge.createPull(repo, title, field(body, 'body') ?? '', head, base);
        if (pull === undefined) return error(422, 'unknown head or base branch');
        return reply(201, pullJson(forge, repo, pull, origin));
      }
      return error(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return error(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return reply(200, pullJson(forge, repo, pull, origin));
      return error(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return error(404, 'Not Found');
      return reply(200, forge.pullFiles(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return error(404, 'Not Found');
      if (pull.merged) return error(405, 'pull request is already merged');
      if (pull.state === 'closed') return error(405, 'pull request is closed');
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
      if (baseTip === ZERO_OID || headTip === ZERO_OID) return error(405, 'head or base branch is missing');
      const merged = forge.mergeFiles(repo, baseTip, headTip);
      if (merged === null) return error(405, 'merge conflict');
      const tree = forge.buildTreeFromMap(repo, merged);
      const message = `Merge pull request #${pull.number} from ${pull.head}`;
      const sha = forge.writeCommit(repo, tree, [baseTip], message);
      repo.refs.set(`refs/heads/${pull.base}`, sha);
      forge.touch(repo);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = sha;
      pull.headSha = headTip;
      pull.baseSha = sha;
      return reply(200, { sha, merged: true, message });
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

/** decodeURIComponent that falls back to the raw segment on bad escapes. */
function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export { blobText };
