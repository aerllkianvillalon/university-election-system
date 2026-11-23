# Ballot hash chain (normative)
One chain per `(election, chain_id)`: `main` for central, one per lab (e.g. `lab-<id>`). Ballots are never re-sealed into another chain.

**Encoding.** `lp(b) = uint32_be(len(b)) || b`. Integers are unsigned 64-bit big-endian. Text is UTF-8.

```
prev_0     = SHA-256(utf8(chain_id))
entry_hash = SHA-256( lp(prev) || lp(utf8(chain_id)) || lp(utf8(ballot_id)) || lp(ciphertext) || lp(uint64_be(seq)) )
```
`ballot_id` is the lowercase hyphenated UUID text. `seq` starts at 1 and has no gaps. `prev` of entry n is `entry_hash` of entry n-1.

**Verification.** Recompute every entry in `seq` order; any mismatch of `seq`, `prev`, or `entry_hash` is a failure and freezes the election (or lab).

**Implementations that must agree byte for byte:** SQL `ballots.entry_hash`, the verifier/tally CLI `packages/cli/ev.mjs`, and (to build) the lab worker and the package importer.
**Test vectors:** `docs/spec/test-vectors/chain.json`; check with `bash server/vectors-test.sh`.
**Not yet specified:** signed checkpoint format, package manifest (`docs/spec/PACKAGE.md`).
