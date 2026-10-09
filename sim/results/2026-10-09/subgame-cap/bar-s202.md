```
=== MATCH (field duplicate, 2 seats vs [barreler], 2000 deals, each engine plays every deal), seed 202, 100bb, blinds 10/20 ===
flags: A = (inherited), B = FIX_LIVE_VILLAINS,SUBGAME_SOLVER
A = /Users/rg/Downloads/gpo-wt/next (swarm/next@368b379)
B = /Users/rg/Downloads/gpo-wt/master-fix-subgame-cap (master/fix-subgame-cap@368b379+dirty)
A vs field: +82.82 bb/100 (±60.0)   B vs field: +184.17 bb/100 (±69.2)
A - B (paired): -101.34 bb/100, 95% CI ±43.13  (sd per deal 9.84 bb)
  -> B is better (CI excludes 0)
  fold-to-raise (postflop)   A 23.8% (5/21)           B 25.0% (5/20)           A-B -1.2pp ±26.3
  fold-to-flop-bet           A 75.3% (514/683)        B 75.3% (514/683)        A-B +0.0pp ±4.6
  fold-to-turn-barrel        A 50.0% (69/138)         B 21.7% (30/138)         A-B +28.3pp ±10.8
  fold-to-river-bet          A 38.2% (42/110)         B 20.0% (28/140)         A-B +18.2pp ±11.2
  turn barrel                A 46.9% (45/96)          B 46.9% (45/96)          A-B +0.0pp ±14.1
  river barrel               A 61.7% (29/47)          B 75.5% (40/53)          A-B -13.8pp ±18.1
(189s wall, 21.2 games/s)
```

{"mode":"field","deals":2000,"hands":2000,"diff":{"bb100":-101.34250000000013,"ci95":43.13215547869448,"sdPerDealBb":9.841472619025595},"pressureA":{"foldToRaiseOpp":21,"foldToRaise":5,"foldToFlopBetOpp":683,"foldToFlopBet":514,"foldToTurnBarrelOpp":138,"foldToTurnBarrel":69,"foldToRiverBetOpp":110,"foldToRiverBet":42,"turnBarrelOpp":96,"turnBarrel":45,"riverBarrelOpp":47,"riverBarrel":29},"pressureB":{"foldToRaiseOpp":20,"foldToRaise":5,"foldToFlopBetOpp":683,"foldToFlopBet":514,"foldToTurnBarrelOpp":138,"foldToTurnBarrel":30,"foldToRiverBetOpp":140,"foldToRiverBet":28,"turnBarrelOpp":96,"turnBarrel":45,"riverBarrelOpp":53,"riverBarrel":40},"a":{"bb100":82.82499999999987,"ci95":59.96299554919784},"b":{"bb100":184.16749999999996,"ci95":69.22310763482709}}
