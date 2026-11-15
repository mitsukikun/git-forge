// graphql.ts — the GraphQL v4 surface: a small parser for the query language subset
// the suite uses, an executor over the forge's records, and the introspection surface
// (__type) the suite exercises. Failures are GraphQL errors on HTTP 200 with an
// `errors` array, never HTTP 400 — except unauthenticated requests, which the server
// rejects with 401 before this is called.
//
// Global ids are opaque base64url strings (`repo:owner/name`, `issue:owner/name:n`,
// `pull:owner/name:n`, `comment:owner/name:n:id`); they are never the bare number.

import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const raw = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escape = source[j + 1] as string;
          if (escape === 'n') out += '\n';
          else if (escape === 't') out += '\t';
          else if (escape === 'r') out += '\r';
          else if (escape === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += escape;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number.parseFloat(raw) });
      else tokens.push({ kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selection: Selection[] | null;
}

interface FragmentSelection {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selection: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  /** Skip a balanced (...) group (variable definitions, directives). */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parens');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseDocument(): Document {
    const document: Document = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        document.operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.expectName() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
        document.operations.push({ type, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        document.fragments.set(name, this.parseSelectionSet());
        void typeCondition;
        continue;
      }
      throw new Error('unexpected token at document level');
    }
    return document;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '...') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', name: null, typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.expectName();
        return { kind: 'fragment', name, typeCondition: null, selection: [] };
      }
      return { kind: 'fragment', name: null, typeCondition: null, selection: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives are not used by the suite; skip them if present.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    }
    let selection: Selection[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'literal', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'literal', value: fields };
    }
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') {
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') {
    const value = variables[node.name];
    return value === undefined ? null : value;
  }
  const value = node.value;
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item as ValueNode, variables));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, ValueNode>)) {
      out[key] = resolveValue(item, variables);
    }
    return out;
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// the schema (for introspection)
// -------------------------------------------------------------------------------------------

interface SchemaField {
  name: string;
  type: string;
}

interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields: SchemaField[];
  enumValues: string[];
}

const SCHEMA: Record<string, SchemaType> = {
  User: {
    kind: 'OBJECT',
    fields: [{ name: 'login', type: 'String' }],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'String' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
    ],
    enumValues: [],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [{ name: 'name', type: 'String' }],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'url', type: 'String' },
    ],
    enumValues: [],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Issue' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'endCursor', type: 'String' },
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
    ],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequest' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequestChangedFile' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [{ name: 'path', type: 'String' }],
    enumValues: [],
  },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'MILESTONE', 'PROJECT', 'WIKI'],
  },
  __TypeKind: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },
};

// -------------------------------------------------------------------------------------------
// records (what the executor walks)
// -------------------------------------------------------------------------------------------

/** Any record the executor can resolve fields on; functions are resolvers taking args. */
type RecordValue = {
  __typename: string;
  [key: string]: unknown;
};

interface Context {
  forge: Forge;
  errors: Array<{ message: string }>;
}

function userRecord(login: string): RecordValue {
  return { __typename: 'User', login };
}

function pageInfoRecord(hasNextPage: boolean, endCursor: string | null): RecordValue {
  return { __typename: 'PageInfo', hasNextPage, endCursor };
}

function issueRecord(forge: Forge, repo: Repo, issue: Issue): RecordValue {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullRecord(forge: Forge, repo: Repo, pull: Pull): RecordValue {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo.owner, repo.name, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: () => {
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
      return forge.mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (args: Record<string, unknown>) => {
      const all = forge.pullFiles(repo, pull).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
      const first = typeof args.first === 'number' ? args.first : all.length;
      const nodes = all.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        pageInfo: pageInfoRecord(all.length > nodes.length, null),
      };
    },
  };
}

function repoRecord(forge: Forge, repo: Repo): RecordValue {
  const defaultRef = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userRecord(repo.owner),
    defaultBranchRef: defaultRef === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.find((candidate) => candidate.number === args.number);
      return issue === undefined ? null : issueRecord(forge, repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const first = typeof args.first === 'number' ? args.first : list.length;
      let start = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        try {
          const afterNumber = Number.parseInt(Buffer.from(args.after, 'base64url').toString('utf8'), 10);
          const index = list.findIndex((issue) => issue.number === afterNumber);
          if (index >= 0) start = index + 1;
        } catch {
          start = 0;
        }
      }
      const page = list.slice(start, start + first);
      const hasNext = start + page.length < list.length;
      const endCursor = page.length === 0 ? null : Buffer.from(String(page[page.length - 1]?.number ?? 0), 'utf8').toString('base64url');
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueRecord(forge, repo, issue)),
        pageInfo: pageInfoRecord(hasNext, endCursor),
        totalCount: list.length,
      };
    },
    pullRequests: (args: Record<string, unknown>) => {
      let list = [...repo.pulls];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        list = list.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'));
      } else {
        list = list.filter((pull) => pull.state === 'open');
      }
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullRecord(forge, repo, pull)),
        pageInfo: pageInfoRecord(list.length > page.length, null),
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const pull = repo.pulls.find((candidate) => candidate.number === args.number);
      return pull === undefined ? null : pullRecord(forge, repo, pull);
    },
  };
}

/** The introspection record for one schema type. */
function typeRecord(name: string): RecordValue | null {
  const schema = SCHEMA[name];
  if (schema === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: schema.kind,
    description: null,
    fields: () =>
      schema.fields.map((field) => ({
        __typename: '__Field',
        name: field.name,
        description: null,
        type: { __typename: '__Type', name: field.type, kind: SCHEMA[field.type]?.kind ?? 'SCALAR', ofType: null },
      })),
    enumValues: () =>
      schema.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
  };
}

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

function resolveField(
  context: Context,
  document: Document,
  typeName: string,
  record: RecordValue,
  field: FieldSelection,
  variables: Record<string, unknown>,
): unknown {
  if (field.name === '__typename') return typeName;
  const raw = record[field.name];
  if (raw === undefined) {
    context.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) {
    args[key] = resolveValue(node, variables);
  }
  let value: unknown = typeof raw === 'function' ? (raw as (args: Record<string, unknown>) => unknown)(args) : raw;
  if (field.selection === null) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => resolveObject(context, document, item as RecordValue, field.selection as Selection[], variables));
  }
  return resolveObject(context, document, value as RecordValue, field.selection, variables);
}

function resolveObject(
  context: Context,
  document: Document,
  record: RecordValue,
  selection: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const typeName = typeof record.__typename === 'string' ? record.__typename : 'Unknown';
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      if (item.name !== null) {
        const fragment = document.fragments.get(item.name);
        if (fragment !== undefined) Object.assign(out, resolveObject(context, document, record, fragment, variables));
        continue;
      }
      if (item.typeCondition !== null && item.typeCondition !== typeName) continue;
      Object.assign(out, resolveObject(context, document, record, item.selection, variables));
      continue;
    }
    const key = item.alias ?? item.name;
    out[key] = resolveField(context, document, typeName, record, item, variables);
  }
  return out;
}

function queryRoot(forge: Forge): RecordValue {
  return {
    __typename: 'Query',
    viewer: () => userRecord(forge.viewer.login),
    repository: (args: Record<string, unknown>) => {
      const repo = forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoRecord(forge, repo);
    },
    node: (args: Record<string, unknown>) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      const repo = forge.repo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      if (decoded.kind === 'repo') return repoRecord(forge, repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
        return issue === undefined ? null : issueRecord(forge, repo, issue);
      }
      if (decoded.kind === 'pull') {
        const pull = repo.pulls.find((candidate) => candidate.number === decoded.number);
        return pull === undefined ? null : pullRecord(forge, repo, pull);
      }
      return null;
    },
    __type: (args: Record<string, unknown>) => typeRecord(String(args.name ?? '')),
  };
}

function mutationRoot(forge: Forge, context: Context): RecordValue {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        context.errors.push({ message: 'repository not found' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const repo = forge.repo(decoded.owner, decoded.name);
      if (repo === undefined) {
        context.errors.push({ message: 'repository not found' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueRecord(forge, repo, issue) };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') {
        context.errors.push({ message: 'issue not found' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      const repo = forge.repo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((candidate) => candidate.number === decoded.number);
      if (issue === undefined) {
        context.errors.push({ message: 'issue not found' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueRecord(forge, repo as Repo, issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        context.errors.push({ message: 'repository not found' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const repo = forge.repo(decoded.owner, decoded.name);
      if (repo === undefined) {
        context.errors.push({ message: 'repository not found' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull = forge.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (pull === undefined) {
        context.errors.push({ message: 'unknown head or base branch' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullRecord(forge, repo, pull) };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'pull') {
        context.errors.push({ message: 'pull request not found' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const repo = forge.repo(decoded.owner, decoded.name);
      const pull = repo?.pulls.find((candidate) => candidate.number === decoded.number);
      if (pull === undefined || repo === undefined) {
        context.errors.push({ message: 'pull request not found' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      if (pull.merged) {
        context.errors.push({ message: 'pull request is already merged' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) {
        context.errors.push({ message: 'head or base branch is missing' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const merged = forge.mergeFiles(repo, baseTip, headTip);
      if (merged === null) {
        context.errors.push({ message: 'merge conflict' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
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
      return { __typename: 'MergePullRequestPayload', pullRequest: pullRecord(forge, repo, pull) };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') {
        context.errors.push({ message: 'subject not found' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const repo = forge.repo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((candidate) => candidate.number === decoded.number);
      if (issue === undefined || repo === undefined) {
        context.errors.push({ message: 'subject not found' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: String(input.body ?? '') };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id), body: comment.body },
        },
      };
    },
  };
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Run one GraphQL operation body ({query, variables}) and return its response body. */
export function handleGraphql(forge: Forge, body: unknown): GraphqlResult {
  const context: Context = { forge, errors: [] };
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation found' }] };
  }
  const operation = document.operations[0] as Operation;
  const root = operation.type === 'mutation' ? mutationRoot(forge, context) : queryRoot(forge);
  const data = resolveObject(context, document, root, operation.selection, variables);
  const result: GraphqlResult = { data };
  if (context.errors.length > 0) result.errors = context.errors;
  return result;
}
