```
=== MATCH (heads-up duplicate, 2000 deals x 2 seatings = 4000 hands), seed 1, 100bb, blinds 10/20 ===
flags: A = (inherited), B = FIX_LIVE_VILLAINS,SUBGAME_SOLVER
A = /Users/rg/Downloads/gpo-wt/next (swarm/next@368b379)
B = /Users/rg/Downloads/gpo-wt/master-fix-subgame-cap (master/fix-subgame-cap@368b379+dirty)
A vs B: -7.58 bb/100 for A, 95% CI ±15.27  (sd per deal pair 6.97 bb)
  -> no significant difference at 95%
  fold-to-raise (postflop)   A 11.4% (5/44)           B 12.2% (5/41)           A-B -0.8pp ±13.7
  fold-to-flop-bet           A 77.0% (344/447)        B 77.0% (344/447)        A-B +0.0pp ±5.5
  fold-to-turn-barrel        A 59.5% (22/37)          B 8.3% (3/36)            A-B +51.1pp ±18.2
  fold-to-river-bet          A 78.0% (170/218)        B 38.7% (36/93)          A-B +39.3pp ±11.3
  turn barrel                A 47.8% (43/90)          B 53.3% (48/90)          A-B -5.6pp ±14.6
  river barrel               A 52.1% (25/48)          B 70.6% (24/34)          A-B -18.5pp ±20.8
(400s wall, 10.0 games/s)
```

{"mode":"hu","deals":2000,"hands":4000,"diff":{"bb100":-7.581249999999989,"ci95":15.272869095963253,"sdPerDealBb":6.969627246944815},"pressureA":{"foldToRaiseOpp":44,"foldToRaise":5,"foldToFlopBetOpp":447,"foldToFlopBet":344,"foldToTurnBarrelOpp":37,"foldToTurnBarrel":22,"foldToRiverBetOpp":218,"foldToRiverBet":170,"turnBarrelOpp":90,"turnBarrel":43,"riverBarrelOpp":48,"riverBarrel":25},"pressureB":{"foldToRaiseOpp":41,"foldToRaise":5,"foldToFlopBetOpp":447,"foldToFlopBet":344,"foldToTurnBarrelOpp":36,"foldToTurnBarrel":3,"foldToRiverBetOpp":93,"foldToRiverBet":36,"turnBarrelOpp":90,"turnBarrel":48,"riverBarrelOpp":34,"riverBarrel":24}}
