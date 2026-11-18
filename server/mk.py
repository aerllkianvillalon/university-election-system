import json,os,sys
g=json.loads(os.environ['G']); cs=g['contests']; mode=sys.argv[1]
pick=lambda c,n=1:{'contestId':c['id'],'candidateIds':[k['id'] for k in c['candidates'][:n]],'abstain':False}
sel=[pick(c) for c in cs]
if mode=='tamper': sel.append({'contestId':os.environ['BSED'],'candidateIds':[],'abstain':True})
if mode=='over': sel[0]=pick(cs[0],2)
if mode=='missing': sel=sel[:-1]
if mode=='titles': print(', '.join(c['positionTitle'] for c in cs)); sys.exit()
print(json.dumps({'nonce':os.environ.get('N','11111111-1111-1111-1111-111111111111'),'round':1,'selections':sel}))
