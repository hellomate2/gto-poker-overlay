# Pool deal-level samples from sim/match.ts shard JSON (hu mode): sample = A's net over both games / BB (20)
import json,sys,math
xs=[]
for f in sys.argv[1:]:
    line=[l for l in open(f) if l.startswith('@@MATCH_JSON@@')][0]
    r=json.loads(line[len('@@MATCH_JSON@@'):])
    xs+= [d['a']/20 for d in r['deals']]
n=len(xs); m=sum(xs)/n; v=sum((x-m)**2 for x in xs)/(n-1); se=math.sqrt(v/n)
print(f"{n} deals: {100*m/2:+.2f} bb/100, 95% CI +/-{1.96*se*100/2:.2f} [{100*(m-1.96*se)/2:.2f}, {100*(m+1.96*se)/2:.2f}], sd per deal {math.sqrt(v):.2f} bb")
