#!/usr/bin/env bash
# Shared chain test vectors: generate once from SQL (REGEN=1), then check BOTH implementations against the file.
set -u; DB=evvec; F=docs/spec/test-vectors/chain.json; dropdb --if-exists $DB 2>/dev/null; createdb $DB
psql -X -q -v ON_ERROR_STOP=1 $DB -f db/migrations/shared/0001_core.sql >/dev/null || exit 1
if [ "${REGEN:-0}" = 1 ] || [ ! -f $F ]; then psql -X -q -tA $DB > $F << 'SQL'
CREATE FUNCTION pg_temp.vec() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE prev bytea := digest('main','sha256'); h bytea; arr jsonb := '[]'; i int; id uuid; ct bytea;
BEGIN FOR i IN 1..4 LOOP id := ('a0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid; ct := '\x00112233'::bytea || int4send(i); h := ballots.entry_hash(prev,'main',id,ct,i);
  arr := arr || jsonb_build_object('seq',i,'id',id,'ciphertext',encode(ct,'hex'),'prev',encode(prev,'hex'),'hash',encode(h,'hex')); prev := h; END LOOP;
  RETURN jsonb_build_object('chain','main','encoding','sha256(lp(prev)||lp(chain)||lp(id)||lp(ciphertext)||lp(uint64be(seq)))','entries',arr); END$$;
SELECT jsonb_pretty(pg_temp.vec());
SQL
fi
node packages/cli/ev.mjs vectors --file $F
OK=$(psql -X -q -tA -v j="$(cat $F)" $DB << 'SQL'
SELECT bool_and(ballots.entry_hash(decode(e->>'prev','hex'), j->>'chain', (e->>'id')::uuid, decode(e->>'ciphertext','hex'), (e->>'seq')::bigint) = decode(e->>'hash','hex'))
  FROM (SELECT :'j'::jsonb AS j) q, jsonb_array_elements(j->'entries') e;
SQL
)
[ "$OK" = t ] && echo "OK SQL matches the same vectors" || { echo "FAIL SQL differs"; exit 1; }
