import json,sys,math
for f in sys.argv[1:]:
    rows=[json.loads(l) for l in open(f)]
    ok=[r for r in rows if r['ok']]
    ms=sorted(r['ms'] for r in ok); it=sorted(r['iters'] for r in ok)
    def pct(a,p): return a[min(len(a)-1,max(0,math.ceil(p/100*len(a))-1))]
    off=sum(1 for r in ok if r.get('offtree'))
    fb={}
    for r in rows:
        if not r['ok']: fb[r.get('reason')]=fb.get(r.get('reason'),0)+1
    print(f"{f.split('/')[-1]}: {len(rows)} attempts, {len(ok)} searched, {off} off-tree, fallbacks {fb}, ms p50 {pct(ms,50)} p95 {pct(ms,95)} max {ms[-1]}, iters p50 {pct(it,50)} p5 {pct(it,5)} min {it[0]}")
