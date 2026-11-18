#!/usr/bin/env bash
# Ceremony + sealer + verifier + tally test. SQL and JS must agree byte for byte on the chain. Run from repo root.
set -u; DB=evcli; EV="node packages/cli/ev.mjs"; W=/tmp/cer; rm -rf $W; dropdb --if-exists $DB 2>/dev/null; createdb $DB
psql -X -q -v ON_ERROR_STOP=1 $DB -f db/migrations/shared/0001_core.sql >/dev/null || exit 1
$EV keygen --out $W; E=$(python3 -c "import uuid;print(uuid.uuid4())")
node -e '
import("./packages/cli/node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js").then(async m=>{const S=m.default;await S.ready;const fs=require("fs");
const pk=new Uint8Array(Buffer.from(fs.readFileSync(process.argv[1]+"/election.pub","utf8"),"base64"));
const ballots=[["a"],["a"],["a"],["a"],["b"],["b"],[]]; // last one abstains
ballots.forEach(c=>{const pt=Buffer.from(JSON.stringify({round:1,selections:[{contestId:"c1",candidateIds:c,abstain:c.length===0}]}));
const p=Buffer.alloc(2048);p.writeUInt16BE(pt.length);pt.copy(p,2);const ct=Buffer.from(S.crypto_box_seal(p,pk)).toString("hex");
console.log(`INSERT INTO ballots.inbox(election_id,round,receipt,ciphertext) VALUES (\x27${process.argv[2]}\x27,1,\x27\\x00\x27,\x27\\x${ct}\x27);`)})})' $W $E 2>/dev/null | psql -X -q $DB
echo "inbox before seal: $(psql -X -tA $DB -c 'select count(*) from ballots.inbox')"
psql -X -q $DB -c "CALL ballots.seal('$E','main',1,true)"
psql -X -tA $DB -c "SELECT json_build_object('chain','main','inboxCount',(SELECT count(*) FROM ballots.inbox),'ballots',COALESCE(json_agg(json_build_object('id',id,'seq',seq,'ciphertext',encode(ciphertext,'hex'),'prev',encode(prev_hash,'hex'),'hash',encode(entry_hash,'hex')) ORDER BY seq),'[]'::json)) FROM ballots.ballots WHERE election_id='$E' AND chain_id='main'" > $W/export.json
$EV verify --ballots $W/export.json
$EV tally --ballots $W/export.json --shares $W/share-1.txt,$W/share-3.txt,$W/share-5.txt --sign $W/signing.key --out $W/results.json && python3 -c "import json;print(json.loads(json.load(open('$W/results.json'))['body'])['counts'])"
$EV verify-results --results $W/results.json --pub $W/signing.pub
echo "-- negative cases"
$EV tally --ballots $W/export.json --shares $W/share-1.txt,$W/share-2.txt --sign $W/signing.key --out /tmp/x.json 2>&1 | head -1
$EV tally --ballots $W/export.json --shares $W/share-1.txt,$W/share-2.txt,$W/share-2.txt --sign $W/signing.key --out /tmp/x.json 2>&1 | head -1
python3 - << PY
import json;d=json.load(open('$W/export.json'));c=bytearray.fromhex(d['ballots'][2]['ciphertext']);c[10]^=1;d['ballots'][2]['ciphertext']=c.hex();json.dump(d,open('$W/tampered.json','w'))
d=json.load(open('$W/export.json'));d['inboxCount']=1;json.dump(d,open('$W/inbox.json','w'));r=json.load(open('$W/results.json'));r['body']=r['body'].replace('"ballots":7','"ballots":8');json.dump(r,open('$W/results-bad.json','w'))
PY
$EV verify --ballots $W/tampered.json 2>&1 | head -1
$EV tally --ballots $W/tampered.json --shares $W/share-1.txt,$W/share-3.txt,$W/share-5.txt --sign $W/signing.key --out /tmp/x.json 2>&1 | head -1
$EV tally --ballots $W/inbox.json --shares $W/share-1.txt,$W/share-3.txt,$W/share-5.txt --sign $W/signing.key --out /tmp/x.json 2>&1 | head -1
$EV verify-results --results $W/results-bad.json --pub $W/signing.pub 2>&1 | head -1
