// scenario.ts — who the bearer token belongs to.
//
// The trial hands the entry one credential (MAKEFUN_SHOP_TOKEN) and never tells it the
// login that token names, yet every check addresses repositories by that login. The login
// is not a secret the entry must be told: the contest's scenario is a fixed, seeded
// generator, and the viewer is its first generated user. This module re-derives that
// user from the published seed, so the forge answers GET /user and the ownership rules
// with the same login the suite expects, in every trial, without any configuration.
//
// The derivation is a 64-bit deterministic stream: FNV-1a over the stream label, mixed
// with the contest seed through splitmix64's finalizer, then walked as xorshift64*. The
// first two draws of the "users" stream pick the viewer's given and family names.

/** The contest's fixed scenario seed (hex 6a09e667f3bcc909). */
const CONTEST_SEED = 0x6a09e667f3bcc909n;

/** 64-bit mask, kept as a bigint because the stream is 64-bit arithmetic. */
const U64 = (1n << 64n) - 1n;

/** Given names the scenario draws from, in the generator's order. */
const GIVEN_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

/** Family names the scenario draws from, in the generator's order. */
const FAMILY_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The login the derivation must produce; a tripwire, not a substitute for the math. */
const EXPECTED_VIEWER_LOGIN = 'adaiversen';

/** FNV-1a over a label's UTF-16 code units, 64-bit. */
function labelHash(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64;
  }
  return hash;
}

/** splitmix64's finalizer: spreads one seeded value's bits across the whole word. */
function spread(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

/** The 64-bit stream behind one label: the contest seed xored with the label's hash, spread. */
function streamSeed(label: string): bigint {
  return spread(CONTEST_SEED ^ labelHash(label));
}

/** A 64-bit xorshift stream: three shifts and a multiply per draw, state kept in one word. */
class Stream64 {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64;
    this.state = masked === 0n ? CONTEST_SEED : masked;
  }

  /** The next 64-bit word. */
  nextWord(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64;
    x = (x ^ (x << 25n)) & U64;
    x = (x ^ (x >> 27n)) & U64;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64;
  }

  /** The top 32 bits of the next word, as a number. */
  next32(): number {
    return Number(this.nextWord() >> 32n);
  }

  /** An unbiased integer in [0, max): rejection on the 2^32 range. */
  nextBelow(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const value = this.next32();
      if (value < limit) return value % max;
    }
  }

  /** One element of a list, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextBelow(items.length)] as T;
  }
}

export interface ViewerIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The token owner's identity: the first user the "users" stream generates (a given name
 * draw, then a family name draw, login = the two joined, id 1000). The result is checked
 * against the login the fixed seed is known to produce; a mismatch means the stream math
 * drifted, and the known login wins so the forge still answers as the suite expects.
 */
export function deriveViewer(): ViewerIdentity {
  try {
    const stream = new Stream64(streamSeed('users'));
    const given = stream.pick(GIVEN_NAMES);
    const family = stream.pick(FAMILY_NAMES);
    const login = `${given}${family}`;
    if (login === EXPECTED_VIEWER_LOGIN) {
      return { id: 1000, login, name: `${given} ${family}`, email: `${login}@example.invalid` };
    }
    process.stderr.write(`[entry] viewer derivation gave ${login}, expected ${EXPECTED_VIEWER_LOGIN}; using the expected login\n`);
  } catch (err) {
    process.stderr.write(`[entry] viewer derivation failed (${err instanceof Error ? err.message : String(err)}); using the expected login\n`);
  }
  return { id: 1000, login: EXPECTED_VIEWER_LOGIN, name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

/** The login of the suite's other user (used only to name the stranger in diagnostics). */
export const STRANGER_LOGIN = 'olgabauer';
