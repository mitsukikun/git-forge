// store.ts — the forge's whole state, in memory: repositories, their object stores
// and refs, labels, issues, pull requests and comments. Everything a surface reads
// or writes goes through here, so the four surfaces can never disagree about a repo.
//
// One token owns every repository (the suite's single bearer token); a repository is
// addressed as <viewer>/<name>, and any other owner is a 404, never a 403.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  compareTreeEntries,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitcore.ts';
import type { ViewerIdentity } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  /** Creation sequence of each object id (commit ordering for GET /commits). */
  objectCreated: Map<string, number>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One counter for issues and pull requests together, as GitHub numbers them. */
  numberSeq: number;
  commentSeq: number;
  /** Bumped on every mutation; the fetch pack cache keys on it. */
  version: number;
}

/** A flat file map: path -> the blob (or subtree) entry at that path. */
export type FileMap = Map<string, { oid: string; mode: string }>;

/** The forge: one viewer, one token, every repository. */
export class Forge {
  readonly viewer: ViewerIdentity;
  /** The bearer token the entry was handed; '' when none was configured. */
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private objectSeq = 10000;
  private globalSeq = 0;
  /** Fetch packs cached by (repo, wants, haves, depth, shallow, version). */
  readonly packCache = new Map<string, Buffer>();

  constructor(viewer: ViewerIdentity, token: string) {
    this.viewer = viewer;
    this.token = token;
  }

  /** The next global sequence number: creation order across the whole forge. */
  nextSeq(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  /** The next stable numeric id for an issue, pull request or comment. */
  nextObjectId(): number {
    this.objectSeq += 1;
    return this.objectSeq;
  }

  /** Whether the Authorization header names this forge's token. */
  tokenOk(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (match === null) return false;
    const presented = match[1] as string;
    if (this.token === '') return presented !== '';
    return presented === this.token;
  }

  /** The repository <viewer>/<name>, or undefined. Any other owner is not a lookup. */
  repo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(name);
  }

  /** Create a repository owned by the viewer; undefined when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | undefined {
    if (this.repos.has(name)) return undefined;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: this.viewer.login,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      objectCreated: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      numberSeq: 0,
      commentSeq: 0,
      version: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Delete a repository and drop its cached packs. */
  deleteRepo(name: string): boolean {
    if (!this.repos.has(name)) return false;
    this.repos.delete(name);
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(`${name}\n`)) this.packCache.delete(key);
    }
    return true;
  }

  /** All of the viewer's repositories, oldest first. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------------------------------------
  // objects and refs
  // -------------------------------------------------------------------------------------------

  /** Store one object, returning its id. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.objectCreated.set(oid, this.nextSeq());
    }
    return oid;
  }

  /** Store many objects at once (a pushed pack). */
  putObjects(repo: Repo, objects: ReadonlyMap<string, GitObject>): void {
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        repo.objectCreated.set(oid, this.nextSeq());
      }
    }
  }

  /** Bump a repo's version (invalidates its cached fetch packs). */
  touch(repo: Repo): void {
    repo.version += 1;
  }

  /** The tip of a ref, or the zero id when it does not exist. */
  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  /** Peel a ref's object to the commit it names (through annotated tags), or undefined. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let steps = 0; steps < 16; steps += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** True when `descendant` is `ancestor` itself or has it among its commit ancestors. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The commits reachable from a tip, newest first (by creation order). */
  commitList(repo: Repo, tip: string): Array<{ sha: string; message: string; createdSeq: number }> {
    const order = new Map<string, number>();
    const queue: string[] = [tip];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.set(oid, repo.objectCreated.get(oid) ?? 0);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const out: Array<{ sha: string; message: string; createdSeq: number }> = [];
    for (const oid of order.keys()) {
      const object = repo.objects.get(oid) as GitObject;
      const parsed = parseCommit(object.data);
      out.push({ sha: oid, message: parsed.message.replace(/\n$/, ''), createdSeq: order.get(oid) as number });
    }
    out.sort((a, b) => b.createdSeq - a.createdSeq);
    return out;
  }

  /** Flatten a tree into path -> entry, recursing into subtrees. */
  flattenTree(repo: Repo, treeOid: string): FileMap {
    const out: FileMap = new Map();
    const walk = (tree: string, prefix: string): void => {
      const object = repo.objects.get(tree);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat file map, returning the root tree id. */
  buildTreeFromMap(repo: Repo, files: FileMap): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      entries.sort(compareTreeEntries);
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The `author ... <ts> +0000` line for a commit the forge itself writes. */
  identityLine(): string {
    const stamp = Math.floor(Date.now() / 1000);
    return `${this.viewer.name} <${this.viewer.email}> ${stamp} +0000`;
  }

  /** Write a commit object on top of `parents` with `tree`, returning its id. */
  writeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const who = this.identityLine();
    const data = buildCommit({ tree, parents, author: who, committer: who, message: message.endsWith('\n') ? message : `${message}\n` });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Commit one file change on a branch: set `path` to `content` (or delete it when
   * `content` is null), building the new tree from the branch tip's tree. Returns the
   * new commit id and the new blob id (null on a delete).
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commit: string; blob: string | null } {
    const tip = this.refTip(repo, `refs/heads/${branch}`);
    let baseFiles: FileMap = new Map();
    const parents: string[] = [];
    if (tip !== ZERO_OID) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') {
        baseFiles = this.flattenTree(repo, parseCommit(commit.data).tree);
        parents.push(tip);
      }
    }
    let blob: string | null = null;
    if (content !== null) {
      blob = this.putObject(repo, 'blob', content);
      baseFiles.set(path, { oid: blob, mode: '100644' });
    } else {
      baseFiles.delete(path);
    }
    const tree = this.buildTreeFromMap(repo, baseFiles);
    const commit = this.writeCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    this.touch(repo);
    return { commit, blob };
  }

  // -------------------------------------------------------------------------------------------
  // merges
  // -------------------------------------------------------------------------------------------

  /**
   * The three-way merge of a pull request's head into its base, at file granularity.
   * Returns the merged file map, or null when both sides changed the same path
   * differently (a conflict).
   */
  mergeFiles(repo: Repo, baseTip: string, headTip: string): FileMap | null {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (baseCommit === undefined || headCommit === undefined) return null;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    const ancestorTree = mergeBase === null ? '' : parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const ancestorFiles = ancestorTree === '' ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, ancestorTree);
    const merged: FileMap = new Map(baseFiles);
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const head = headFiles.get(path);
      const current = baseFiles.get(path);
      const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
      const baseChanged = (current?.oid ?? null) !== (ancestor?.oid ?? null);
      if (!headChanged) continue;
      if (!baseChanged) {
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
        continue;
      }
      if ((head?.oid ?? null) === (current?.oid ?? null)) continue;
      return null;
    }
    return merged;
  }

  /** The best common ancestor of two commits (the newest commit reachable from both). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push(parent);
      }
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (fromA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push(parent);
      }
    }
    return null;
  }

  /** True when merging `headTip` into `baseTip` would conflict. */
  mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
    return this.mergeFiles(repo, baseTip, headTip) === null;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  /** Create an issue; labels must already exist (callers check). */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.numberSeq += 1;
    const issue: Issue = {
      id: this.nextObjectId(),
      number: repo.numberSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  /** Create a pull request from `head` into `base`; undefined when the head is unknown. */
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | undefined {
    const headSha = this.refTip(repo, `refs/heads/${head}`);
    const baseSha = this.refTip(repo, `refs/heads/${base}`);
    if (headSha === ZERO_OID || baseSha === ZERO_OID) return undefined;
    repo.numberSeq += 1;
    const pull: Pull = {
      id: this.nextObjectId(),
      number: repo.numberSeq,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** The file changes between a pull request's base tip and its head tip. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseCommit = repo.objects.get(pull.baseSha);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit === undefined || headCommit === undefined) return [];
    const baseFiles = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFiles = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before === undefined && after !== undefined) {
        const text = blobText(repo, after.oid);
        const lines = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (before !== undefined && after === undefined) {
        const text = blobText(repo, before.oid);
        const lines = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
        const counts = diffLines(blobText(repo, before.oid), blobText(repo, after.oid));
        out.push({ filename: path, status: 'modified', additions: counts.added, deletions: counts.removed, changes: counts.added + counts.removed });
      }
    }
    return out;
  }
}

/** A blob's text, or '' when it is not a blob. */
export function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** Added/removed line counts between two texts (LCS diff; falls back to counts on big files). */
export function diffLines(before: string, after: string): { added: number; removed: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { added: Math.max(0, b.length - a.length), removed: Math.max(0, a.length - b.length) };
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + (j + 1)] as number) + 1 : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + (j + 1)] as number);
    }
  }
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + (j + 1)] as number)) {
      removed += 1;
      i += 1;
    } else {
      added += 1;
      j += 1;
    }
  }
  removed += a.length - i;
  added += b.length - j;
  return { added, removed };
}

// -------------------------------------------------------------------------------------------
// Relay global ids: opaque, stable, never the bare database id or number.
// -------------------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return b64url(`repo:${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return b64url(`issue:${owner}/${name}:${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return b64url(`pull:${owner}/${name}:${number}`);
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return b64url(`comment:${owner}/${name}:${issueNumber}:${commentId}`);
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number; extra: number } | null {
  const text = unb64url(id);
  if (text === null) return null;
  const repo = /^repo:([^/]+)\/(.+)$/.exec(text);
  if (repo !== null) return { kind: 'repo', owner: repo[1] as string, name: repo[2] as string, number: 0, extra: 0 };
  const issue = /^issue:([^/]+)\/(.+):(\d+)$/.exec(text);
  if (issue !== null) return { kind: 'issue', owner: issue[1] as string, name: issue[2] as string, number: Number(issue[3]), extra: 0 };
  const pull = /^pull:([^/]+)\/(.+):(\d+)$/.exec(text);
  if (pull !== null) return { kind: 'pull', owner: pull[1] as string, name: pull[2] as string, number: Number(pull[3]), extra: 0 };
  const comment = /^comment:([^/]+)\/(.+):(\d+):(\d+)$/.exec(text);
  if (comment !== null) return { kind: 'comment', owner: comment[1] as string, name: comment[2] as string, number: Number(comment[3]), extra: Number(comment[4]) };
  return null;
}
