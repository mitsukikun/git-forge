# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mitsukikun/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mitsukikun/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process — no git binary, no
database, no outside service. It implements the git object store, packfiles, refs and
smart HTTP itself, and serves four surfaces from one in-memory store:

| Surface | Path | What it does |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack v2 + v0 (clone/fetch, shallow, ls-refs), receive-pack v0 (push) |
| REST v3 | `/api/v3` | repos, branches, commits, contents, labels, issues, pull requests, squash merge |
| GraphQL v4 | `/api/graphql` | queries, mutations, node lookup, `__type` introspection |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP, six tools (2026-07-28 discovery + legacy initialize) |

## Running it

```sh
node main.ts
```

The entry binds an ephemeral port, registers it with the environment server at
`$MAKEFUN_ENV_URL`, and serves until `GET $MAKEFUN_ENV_URL/done` answers
`{"done": true}`. Authentication is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
the token's owner is the viewer, derived from the contest's fixed scenario seed.

## Layout

- `main.ts` — lifecycle: bind, register, poll for done, exit.
- `server.ts` — HTTP plumbing, routing, auth, request ids.
- `scenario.ts` — the viewer identity, derived deterministically from the scenario seed.
- `gitcore.ts` — git object model: sha1, pkt-lines, commits/trees/tags, pack read/write.
- `store.ts` — the in-memory forge: repos, objects, refs, issues, pulls, merges, global ids.
- `githttp.ts` — smart HTTP: advertisement, ls-refs, fetch planning, receive-pack.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — a small GraphQL parser, executor and introspection surface.
- `mcp.ts` — the MCP tools.

## Notes

- Repositories belong to the token's login; the same name under another owner is a 404.
- Issues and pull requests share one number counter per repository, starting at 1.
- Pushes are fast-forward only; a non-fast-forward update is refused per ref with
  `ng <ref> non-fast-forward` while the other refs in the same push still apply.
- Fetch packs contain plain objects only (no deltas), are sorted by object id for
  determinism, and are cached per (repo, wants, haves, depth, version).
