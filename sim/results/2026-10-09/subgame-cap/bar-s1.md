```
=== MATCH (field duplicate, 2 seats vs [barreler], 2000 deals, each engine plays every deal), seed 1, 100bb, blinds 10/20 ===
flags: A = (inherited), B = FIX_LIVE_VILLAINS,SUBGAME_SOLVER
A = /Users/rg/Downloads/gpo-wt/next (swarm/next@368b379)
B = /Users/rg/Downloads/gpo-wt/master-fix-subgame-cap (master/fix-subgame-cap@368b379+dirty)
A vs field: +55.33 bb/100 (±62.2)   B vs field: +104.54 bb/100 (±69.9)
A - B (paired): -49.21 bb/100, 95% CI ±43.19  (sd per deal 9.85 bb)
  -> B is better (CI excludes 0)
  fold-to-raise (postflop)   A 25.0% (5/20)           B 34.8% (8/23)           A-B -9.8pp ±27.2
  fold-to-flop-bet           A 75.3% (510/677)        B 75.3% (510/677)        A-B +0.0pp ±4.6
  fold-to-turn-barrel        A 60.5% (75/124)         B 33.1% (41/124)         A-B +27.4pp ±11.9
  fold-to-river-bet          A 39.2% (38/97)          B 26.1% (30/115)         A-B +13.1pp ±12.6
  turn barrel                A 43.4% (33/76)          B 43.4% (33/76)          A-B +0.0pp ±15.8
  river barrel               A 56.4% (22/39)          B 72.7% (32/44)          A-B -16.3pp ±20.4
(189s wall, 21.2 games/s)
```

{"mode":"field","deals":2000,"hands":2000,"diff":{"bb100":-49.214999999999975,"ci95":43.18635395815581,"sdPerDealBb":9.853839097020765},"pressureA":{"foldToRaiseOpp":20,"foldToRaise":5,"foldToFlopBetOpp":677,"foldToFlopBet":510,"foldToTurnBarrelOpp":124,"foldToTurnBarrel":75,"foldToRiverBetOpp":97,"foldToRiverBet":38,"turnBarrelOpp":76,"turnBarrel":33,"riverBarrelOpp":39,"riverBarrel":22},"pressureB":{"foldToRaiseOpp":23,"foldToRaise":8,"foldToFlopBetOpp":677,"foldToFlopBet":510,"foldToTurnBarrelOpp":124,"foldToTurnBarrel":41,"foldToRiverBetOpp":115,"foldToRiverBet":30,"turnBarrelOpp":76,"turnBarrel":33,"riverBarrelOpp":44,"riverBarrel":32},"a":{"bb100":55.32999999999991,"ci95":62.18948451303392},"b":{"bb100":104.54499999999989,"ci95":69.94550469114952}}
