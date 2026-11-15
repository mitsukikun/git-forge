// githttp.ts — git smart HTTP: ref advertisement (v0 and v2), ls-refs, fetch
// (upload-pack v2 and v0) and push (receive-pack v0). The object model lives in
// gitcore.ts; this module turns requests into packs and reports.
//
// Protocol notes the implementation leans on:
//   - info/refs answers v2 only when the client asked with `Git-Protocol: version=2`;
//     receive-pack is v0-only, always.
//   - a fetch sends exactly the objects reachable from the wants that the client does
//     not already hold, cut at the requested depth; shallow boundaries are reported in
//     shallow-info, and old boundaries whose parents have arrived are unshallowed.
//   - a push is refused per ref with `ng <ref> non-fast-forward` when the new tip is
//     not a descendant of the old one; the refused ref never moves, the accepted ones do.

import {
  PKT_DELIM,
  PKT_FLUSH,
  PKT_MAX,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  isOid,
  packetTexts,
  parseCommit,
  parseTag,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { blobText, type Forge, type Repo } from './store.ts';

export const UPLOAD_PACK = 'git-upload-pack';
export const RECEIVE_PACK = 'git-receive-pack';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** One HTTP answer this module produces: status, content type and body bytes. */
export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function answer(status: number, contentType: string, body: Buffer): GitAnswer {
  return { status, contentType, body };
}

function jsonAnswer(status: number, body: unknown): GitAnswer {
  return answer(status, 'application/json', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

// -------------------------------------------------------------------------------------------
// refs
// -------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  unborn?: boolean;
}

/** Every ref of a repo, HEAD first, the rest alphabetical, tags peeled. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const names = [...repo.refs.keys()].sort();
  const hasRefs = names.length > 0;
  if (hasRefs) {
    const tip = repo.refs.get(defaultRef) ?? '';
    if (tip !== '') lines.push({ oid: tip, name: 'HEAD' });
  }
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled !== undefined) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** An annotated tag peeled to the commit it names (through nested tags), or undefined. */
function peelTag(repo: Repo, oid: string): string | undefined {
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

// -------------------------------------------------------------------------------------------
// advertisement
// -------------------------------------------------------------------------------------------

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=gitforge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=gitforge/1.0 symref=HEAD:refs/heads/main';

/** The v2 capability advertisement for upload-pack. */
function advertiseV2(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'agent=gitforge/1.0\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement: service preamble, then `<oid> <ref>` lines, caps on the first. */
function advertiseV0(repo: Repo, service: string): Buffer {
  const caps = service === RECEIVE_PACK ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${first}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return pktLines(lines);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — 404 when the repo is missing, else
 * the advertisement for the protocol the client asked for.
 */
export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolHeader: string | undefined,
): GitAnswer {
  const repo = forge.repo(owner, repoName);
  if (repo === undefined) return jsonAnswer(404, { message: 'Not Found' });
  if (service === RECEIVE_PACK) {
    return answer(200, RECEIVE_ADVERTISEMENT, advertiseV0(repo, RECEIVE_PACK));
  }
  if (service !== UPLOAD_PACK) return jsonAnswer(400, { message: 'unknown service' });
  const wantsV2 = gitProtocolHeader !== undefined && gitProtocolHeader.toLowerCase().includes('version=2');
  if (wantsV2) return answer(200, UPLOAD_ADVERTISEMENT, advertiseV2());
  return answer(200, UPLOAD_ADVERTISEMENT, advertiseV0(repo, UPLOAD_PACK));
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse an ls-refs request body into its arguments. */
function parseLsRefs(body: Buffer): LsRefsArgs | null {
  const { packets } = decodePktLines(body);
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let sawCommand = false;
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!sawDelim) {
      if (line === 'command=ls-refs\n') sawCommand = true;
      continue;
    }
    if (line === 'peel\n') args.peel = true;
    else if (line === 'symrefs\n') args.symrefs = true;
    else if (line === 'unborn\n') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  return sawCommand ? args : null;
}

/** POST git-upload-pack with command=ls-refs: the ref list, honouring ref-prefix. */
export function handleLsRefs(repo: Repo, body: Buffer): GitAnswer {
  const args = parseLsRefs(body);
  if (args === null) return jsonAnswer(400, { message: 'bad ls-refs request' });
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const refs = refLines(repo);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:${defaultRef}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        if (args.symrefs) out.push(`${ref.oid} HEAD symref-target:${defaultRef}\n`);
        else out.push(`${ref.oid} HEAD\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  const parts: Buffer[] = out.map((line) => pktLine(line));
  parts.push(PKT_FLUSH);
  return answer(200, UPLOAD_RESULT, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// fetch
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowOld: string[];
  depth: number | null;
}

/** Parse a fetch request body (v2 or v0) into wants, haves, shallow boundaries and depth. */
function parseFetch(body: Buffer, isV2: boolean): FetchArgs | null {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallowOld: [], depth: null };
  let sawCommand = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (isV2) {
      if (section === 0) {
        if (line === 'command=fetch') sawCommand = true;
        continue;
      }
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallowOld.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
      continue;
    }
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim().split(/\s+/);
        const oid = rest[0] as string;
        if (isOid(oid)) args.wants.push(oid);
      } else if (line.startsWith('shallow ')) args.shallowOld.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  if (isV2 && !sawCommand) return null;
  if (args.wants.length === 0) return null;
  return args;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * What the client already holds, from its haves: the full closure of each have,
 * except that a have that is one of the client's shallow boundaries stops the walk —
 * the client holds that commit and its tree, but not its parents. (Without the cut,
 * a deepen fetch would conclude the client already holds the parent it is asking for.)
 */
function collectHeld(repo: Repo, haves: string[], shallowOld: string[]): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(shallowOld);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      try {
        for (const treeOid of collectReachable([commit.tree], lookup)) held.add(treeOid);
      } catch {
        // A commit whose tree is missing cannot be held in full; the pack will be short.
      }
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      try {
        for (const treeOid of collectReachable([oid], lookup)) held.add(treeOid);
      } catch {
        // A tree that references missing objects cannot be held in full.
      }
    }
  }
  return held;
}

/**
 * Work out what a fetch sends: the objects reachable from the wants, minus what the
 * client already holds, cut at the depth. Commits at the cut are the new shallow
 * boundary; old boundaries whose parents have now arrived are unshallowed.
 */
function planFetch(repo: Repo, forge: Forge, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveClosure = collectHeld(repo, args.haves, args.shallowOld);
  // Full closure of the wants, for the ACK decision — only needed when the client
  // sent haves (with none, the answer is NAK and the walk is wasted work).
  const wantFull = new Set<string>();
  if (args.haves.length > 0) {
    for (const want of args.wants) {
      try {
        for (const oid of collectReachable([want], lookup)) wantFull.add(oid);
      } catch {
        // An unknown want is answered by the caller with a 400.
      }
    }
  }
  // Depth-limited walk: commits at distance < depth, with their tree closures.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const seenCommit = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.add(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') queue.push({ oid: target, distance: 0 });
      else if (targetObject !== undefined) included.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
    } else {
      included.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift() as { oid: string; distance: number };
    const known = seenCommit.get(oid);
    if (known !== undefined && known <= distance) continue;
    seenCommit.set(oid, distance);
    if (args.depth !== null && distance >= args.depth) continue;
    included.add(oid);
    if (args.depth !== null && distance === args.depth - 1) boundary.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    try {
      for (const treeOid of collectReachable([commit.tree], lookup)) included.add(treeOid);
    } catch {
      // A commit whose tree is missing cannot be served; the pack will be short.
    }
    if (args.depth === null || distance + 1 < args.depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  const send = new Set<string>();
  for (const oid of included) if (!haveClosure.has(oid)) send.add(oid);
  const heldAfter = new Set<string>([...haveClosure, ...send]);
  const shallow: string[] = [];
  for (const oid of boundary) {
    if (send.has(oid) || haveClosure.has(oid)) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (!parents.every((parent) => heldAfter.has(parent))) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const old of args.shallowOld) {
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => heldAfter.has(parent))) unshallow.push(old);
  }
  const common = args.haves.filter((have) => wantFull.has(have));
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const cacheKey = [
    repo.name,
    String(repo.version),
    JSON.stringify({ w: [...args.wants].sort(), h: [...args.haves].sort(), s: [...args.shallowOld].sort(), d: args.depth }),
  ].join('\n');
  let pack = forge.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = writePack(objects);
    if (forge.packCache.size > 64) forge.packCache.clear();
    forge.packCache.set(cacheKey, pack);
  }
  return { pack, shallow, unshallow, acks: common, nak: common.length === 0 };
}

/** Split pack bytes into sideband band-1 packets (65515 data bytes each, at most). */
function sideband(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = PKT_MAX - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** POST git-upload-pack: ls-refs or fetch, by the first command line. */
export function handleUploadPack(repo: Repo, forge: Forge, body: Buffer, gitProtocolHeader: string | undefined): GitAnswer {
  const isV2 = gitProtocolHeader !== undefined && gitProtocolHeader.toLowerCase().includes('version=2');
  const { packets } = decodePktLines(body);
  const first = (packetTexts(packets)[0] ?? '').replace(/\n$/, '');
  if (first === 'command=ls-refs') return handleLsRefs(repo, body);
  if (isV2 && first !== 'command=fetch') return jsonAnswer(400, { message: 'bad upload-pack request' });
  if (!isV2 && !first.startsWith('want ')) return jsonAnswer(400, { message: 'bad upload-pack request' });
  const args = parseFetch(body, isV2);
  if (args === null) return jsonAnswer(400, { message: 'bad fetch request' });
  for (const want of args.wants) {
    if (!repo.objects.has(want)) return jsonAnswer(400, { message: `want ${want} not found` });
  }
  const plan = planFetch(repo, forge, args);
  const parts: Buffer[] = [];
  if (isV2) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) parts.push(pktLine('NAK\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (plan.acks.length > 0) parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sideband(plan.pack));
    parts.push(PKT_FLUSH);
  } else {
    if (plan.nak) parts.push(pktLine('NAK\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sideband(plan.pack));
    parts.push(PKT_FLUSH);
  }
  return answer(200, UPLOAD_RESULT, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: the command list, then the raw pack bytes after the flush. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const { packets, consumed } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return null;
  return { commands, pack: body.subarray(consumed) };
}

/** POST git-receive-pack: unpack, validate each command, apply the ok ones, report. */
export function handleReceivePack(repo: Repo, forge: Forge, body: Buffer): GitAnswer {
  const parsed = parsePush(body);
  if (parsed === null) return jsonAnswer(400, { message: 'bad receive-pack request' });
  const { commands, pack } = parsed;
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackDetail: string | null = null;
  if (needsPack) {
    if (pack.length === 0) {
      unpackDetail = 'no pack received';
    } else {
      try {
        const objects = readPack(pack);
        forge.putObjects(repo, objects);
      } catch (err) {
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const reportLines: string[] = [];
  if (unpackDetail !== null) {
    reportLines.push(`unpack ${unpackDetail}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let reason: string | null = null;
      if (command.oldOid !== current) {
        reason = command.oldOid === ZERO_OID ? 'already exists' : current === ZERO_OID ? 'no such ref' : 'old value does not match';
      } else if (command.newOid === ZERO_OID) {
        // A delete: the old value already matched, so it applies.
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'missing object';
      } else if (command.ref.startsWith('refs/heads/')) {
        const peeled = forge.peelToCommit(repo, command.newOid);
        if (peeled === undefined) {
          reason = 'not a commit';
        } else if (current !== ZERO_OID && !forge.isAncestor(repo, current, peeled)) {
          reason = 'non-fast-forward';
        }
      }
      if (reason !== null) {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
    forge.touch(repo);
  }
  const report = pktLines([...reportLines, 'flush']);
  const framed: Buffer[] = [];
  const chunkSize = 65520 - 4 - 1;
  for (let offset = 0; offset < report.length; offset += chunkSize) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + chunkSize))])));
  }
  framed.push(PKT_FLUSH);
  return answer(200, RECEIVE_RESULT, Buffer.concat(framed));
}

/** A repo's objects, for the surfaces that read blobs (contents, merges). */
export function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export { blobText };
