// gitcore.ts — the git object model, on its own: hashing, the pkt-line framing,
// commit/tree/tag bytes, and packfiles. No HTTP here, no store: pure functions over
// buffers, so the HTTP layers and the tests can use them without a server.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero id: an unborn ref's old or new value. */
export const ZERO_OID = '0'.repeat(40);

/** git's largest pkt-line, header included. */
export const PKT_MAX = 65520;

/** The four object types git stores. */
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored object: its type and its exact bytes (the hash covers both). */
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** True for a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the bytes. */
export function hashObject(type: ObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** SHA-1 of a byte string, for pack trailers. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_MAX - 4) throw new Error(`pkt-line payload of ${data.length} bytes exceeds the limit`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a run of packets; the strings 'flush' and 'delim' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode a whole buffer of pkt-lines. Stops cleanly at the first non-framed byte (the
 * raw pack that follows a receive-pack command list) and reports how many bytes the
 * framed part consumed, so the caller can take the rest as the pack.
 */
export function decodePktLines(bytes: Buffer): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of every data packet, in order. */
export function packetTexts(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  return out;
}

// -------------------------------------------------------------------------------------------
// commits, trees, tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a tree's entries: `<mode> <name>\0<20-byte oid>` repeated. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit: headers up to the blank line, then the message verbatim. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headEnd = blank < 0 ? buffer.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8') };
  for (const line of buffer.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  if (!isOid(view.tree)) throw new Error('commit has no valid tree header');
  return view;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes: tree, parents, author/committer, blank line, message. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects only; the suite's client never sends deltas)
// -------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** One object's pack header: type and size in git's varint form. */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects; trailer is SHA-1 over the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read a varint size header at `start`; returns the size, the offset past it, and the first byte. */
function readPackSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/**
 * Read a packfile and resolve every object, recomputing each SHA-1 and checking the
 * trailer. Delta entries are refused: the suite's client writes plain packs only, and
 * a delta here would be a corrupt upload, not a pack to unpack.
 */
export function readPack(pack: Uint8Array): Map<string, GitObject> {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  if (trailer !== sha1Hex(buffer.subarray(0, trailerStart))) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const header = readPackSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not supported');
    const type = PACK_CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    let inflated: Buffer;
    try {
      const result = inflateSync(buffer.subarray(offset, trailerStart), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      inflated = result.buffer;
      offset += result.engine.bytesWritten;
    } catch (err) {
      throw new Error(`zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (inflated.length !== header.size) {
      throw new Error(`pack entry ${index} declares ${header.size} bytes but inflated to ${inflated.length}`);
    }
    const oid = hashObject(type, inflated);
    objects.set(oid, { type, data: inflated });
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

/** True when a pack's trailer matches its bytes. */
export function packChecksumOk(pack: Uint8Array): boolean {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return false;
  return buffer.subarray(buffer.length - 20).toString('hex') === sha1Hex(buffer.subarray(0, buffer.length - 20));
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tag -> its target,
 * tree -> entries (gitlinks skipped), blob -> nothing. Throws on a missing object.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}
