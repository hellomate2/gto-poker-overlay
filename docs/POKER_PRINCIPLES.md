# Poker Principles — the decision curriculum

A structured corpus of No-Limit Hold'em rules, lines, and heuristics the engine is
taught. The solved charts and the distilled net carry the *frequencies*; these
principles carry the *reasoning* — the "would a thinking player do this?" knowledge
that prevents spew and passivity. The highest-value ones are encoded in
`src/core/soundness.ts` / `src/core/principles.ts` and gate live decisions; the rest
are the curriculum to expand that encoding from. Items marked **[ENCODED]** run live.

Conventions: IP = in position, OOP = out of position, PFR = preflop raiser, SPR =
stack-to-pot ratio, MDF = minimum defense frequency, c-bet = continuation bet, "value"
= betting to be called by worse, "bluff" = betting to fold out better.

---

## 1. Core concepts (the lens for every decision)
1. Every action is bet/raise (for value or as a bluff), call, or fold — and each must beat the alternative in EV. If checking/folding is higher-EV, don't bet/call.
2. Play your whole RANGE, not one hand: a bet must make sense with the bluffs and value hands you'd take the same line with.
3. A bet needs a reason: value (worse calls), a bluff (better folds), or protection (deny equity). With none of those, check.
4. Pot odds: call if equity ≥ price = toCall / (pot + toCall). 3:1 pot odds need ~25% equity.
5. Implied odds raise the threshold you can call drawing hands at; reverse implied odds lower it for dominated hands.
6. MDF = pot / (pot + bet): defend at least this share of your range vs a bet, or you're exploitably foldable. Bluff-catch the top MDF of your range.
7. Alpha (bluff break-even) = bet / (bet + pot): a bluff needs villain to fold at least this often.
8. Polarization: big bets/raises are polar (nuts or air); small bets are merge/value-thin. Size to your range's shape.
9. SPR decides commitment: low SPR (<3) → one-pair hands stack off; high SPR (>6) → need two pair+ to commit.
10. Position is information and control: act last → bet thinner, bluff more, pot-control easier. IP is worth a wider range.
11. Initiative (being the aggressor) lets you win unimproved; respect it, but don't barrel just because you have it.
12. Equity realization: OOP and weak/unconnected hands realize less than raw equity; IP and nutted/connected hands realize more.
13. Blockers: holding a card that removes villain's value combos makes a bluff better; holding their bluff cards makes a call worse.
14. Range advantage (whose range is stronger on this board) drives c-bet frequency; nut advantage (who holds the nuts more) drives sizing.
15. Don't pay off: when the only hands that bet/raise big beat you, fold — even "good" one-pair hands.

## 2. Preflop
16. Open-raise (RFI), don't limp; limping caps your range and surrenders initiative.
17. RFI tighter from early position, wider from late: UTG ~15%, MP ~20%, CO ~27%, BTN ~45%, SB ~40% (raise-or-fold).
18. Heads-up: the button/SB opens ~80-90% (smallest steal risk), BB defends ~70% vs a min/small open.
19. Open size: ~2-2.5bb (smaller IP/HU, larger multiway/OOP).
20. 3-bet polarized OOP (premiums + suited-blocker bluffs), more linear/merged IP.
21. Have a 4-bet range (~8-15% of opens vs a 3-bet): value (QQ+/AK) plus a few suited-ace blocker bluffs. Never fold so much you're exploitable.
22. Fold-to-3bet should be ~40-55%; calling everything OOP with a wide range is a leak (poor realization).
23. Suited > offsuit (better realization, flushes, blockers); connected > gapped.
24. Pairs want to set-mine with implied odds (call small opens deep); they flop a set ~1 in 8.5.
25. Don't cold-call 3-bets OOP with dominated hands (e.g. KJo); 4-bet or fold.
26. Squeeze wider when there's a caller behind a raiser (dead money), tighter heads-up.
27. Stack depth changes ranges: deeper → suited/connected go up in value; shorter → high-card/pair equity up.
28. Push/fold (≤ ~12-15bb): jam a wide Nash range first-in from the button; call jams with the exact Nash call range. This is exact and unexploitable short.
29. Do NOT get 25bb+ all-in preflop with a non-premium — deep stack-offs are premiums-only. **[ENCODED]**
30. Adjust to opponents: open wider vs tight blinds, 3-bet/iso wider vs limpers and weak opens, tighten vs aggressive 3-bettors.

## 3. Flop
31. As PFR on a board that favors your range (high/dry, e.g. A-x-x, K-x-x), c-bet a high frequency with a small size (~1/3 pot).
32. On boards that favor the caller (low/connected, e.g. 6-5-4, 9-8-7), c-bet LESS and check more — your range advantage is gone.
33. Wet/dynamic boards → bet bigger and more polarized (charge draws, deny equity); dry boards → bet smaller, higher frequency.
34. Monotone boards → c-bet less; without a card of the suit your bluffs have no equity and value gets drawn out.
35. Paired boards → c-bet small at high frequency (few hands improved, hard to have trips).
36. With a strong made hand on a wet board, bet for protection/value; on a dry board you can check-back/slowplay some to protect your checking range.
37. Continuation-bet bluffs need equity (overcards, backdoors, gutshots) — barrel those, give up the pure airballs.
38. Check-back marginal made hands IP on dry boards (pot control + induce + protect your check range). **[ENCODED]**
39. Don't c-bet into multiway as wide; more players = more value-heavy.
40. Check-raise as the caller with strong value + semi-bluff draws (a polar range), mostly OOP; ~10-15% of the time.
41. Donk-betting is usually wrong (the PFR has range advantage); donk only on boards that smash the caller's range (e.g. you flat a small blind and flop hits your range hard).
42. Float (call IP with a plan to take it away later) with backdoor equity + position, not pure air.
43. Size c-bets the same with value and bluffs on a given texture (don't bet-size tell).

## 4. Turn
44. The turn is the commitment street: a turn bet sets up a river jam at most SPRs — barrel hands that can keep firing the river.
45. Double-barrel for value with strong made hands; double-barrel as a bluff with hands that PICKED UP equity (turned draws, fresh overcards) or strong blockers.
46. GIVE UP on the turn with bricked air — a missed flop bluff that didn't improve and has no draw should check/give up, not fire again. **[ENCODED]**
47. POT CONTROL: with a marginal made hand (second pair, weak top pair, small overpair) check the turn rather than bet — keep the pot small, get to showdown, avoid bloating with a hand that can't take 3 streets of value. **[ENCODED]**
48. Delayed c-bet (bet turn after flop checked through) with value and equity hands — you've represented giving up, so you get folds.
49. Probe-bet the turn OOP after the PFR checks back the flop (their check caps them); lead small for value/bluff.
50. Barrel scare cards that favor your range (overcards to the board, flush/straight-completing cards you can represent).
51. Don't barrel a blank that changes nothing if your flop bet was a pure bluff with no equity — you're drawing dead to fold equity vs a caller.
52. With a draw, prefer the semi-bluff (bet/raise) over a passive call when you have fold equity + can improve.
53. Check-raise the turn as a polar range (nutted value + the best draws); it's a big commitment, so weight it to value.

## 5. River
54. No more equity to deny — every river bet is purely value or a bluff. If it's neither, CHECK. **[ENCODED]**
55. Value-bet thinner IP than OOP: target the worse hands that call. If a worse hand can call, betting beats checking. **[ENCODED]**
56. Size river value by how many worse hands call: thin value → smaller; nutted vs a capped range → overbet.
57. Bluff rivers with hands that BLOCK villain's value and unblock their folds (e.g. missed straight draws that block the straight).
58. Do NOT bluff into a range that is uncappable / very strong, or into a calling station — there's no fold equity. **[ENCODED]**
59. Don't stack off the river as the aggressor with a hand that beats nothing in the calling range (no air-jams that can't fold anyone out and can't be called by worse). **[ENCODED]**
60. Bluff-catch up to MDF with your best non-value hands (best kickers, relevant blockers); fold the rest.
61. Hero-call only with a real reason (blockers, villain's busted draws in range, a known over-bluffer); default fold to big rivers when you beat only bluffs and the price is bad. **[ENCODED]**
62. Polarize the river: with the nuts or air, bet big; with medium showdown value, check and bluff-catch.
63. Block-bet (small lead OOP) with thin value/weak made hands to set a cheap price and deny a bigger bet you'd face if you check.
64. Overbet the river only with a nut-advantaged, polar range vs a capped opponent.

## 6. Named lines (what they are and when)
65. C-bet line (bet flop as PFR): default with range/initiative; small on dry, bigger on wet.
66. Double/triple barrel: keep betting flop→turn→river; needs a consistent value+bluff range, not just "I have the lead."
67. Check-raise: check then raise a bettor — polar (value + draws), mostly OOP.
68. Check-call (bluff-catch): check a hand with showdown value, call one street; controls pot with medium strength.
69. Check-call-check / check-down: take a marginal hand to showdown cheaply.
70. Float: call IP on the flop with backdoors/position, then bet when checked to (turn/river) to take it away.
71. Probe bet: OOP lead on turn/river after the PFR checked back the flop (they're capped).
72. Donk bet: OOP lead into the PFR before they act — rare; only on caller-favorable boards.
73. Delayed c-bet: PFR bets the turn after the flop checked through.
74. Stab: bet when checked to and weakness is shown, with little equity, to pick up the pot.
75. Bet-check-bet: value on flop, check turn (pot control/induce), bet river — common with medium-strong hands.
76. Check-bet-bet (check-raise the flop then barrel, or check flop then lead): trap or delayed aggression.
77. Block bet: small OOP river lead to control price with a thin/showdown hand.
78. Overbet line: polar, big sizing on later streets vs capped ranges.
79. Stop-and-go (short): call OOP preflop, then lead the flop all-in to deny the raiser fold equity.
80. Squeeze: re-raise preflop over an open + caller(s).

## 7. Hand-class playbook
81. Monsters (sets, straights, flushes, full houses): bet/raise for value across streets on dynamic boards; slowplay only on dry boards where you block nothing villain has.
82. Overpairs / top pair top kicker: value-bet 2-3 streets on dry boards; on wet boards bet for protection, but be ready to slow down vs heavy aggression (one pair is one pair).
83. Top pair weak kicker / second pair: pot-control — bet one street or check-call; rarely 3 streets of value. **[ENCODED]**
84. Marginal made hands (third pair, weak pairs, ace-high with showdown): get to showdown cheaply; check-call or check-back, don't bloat. **[ENCODED]**
85. Strong draws (flush draw, open-ender, combo draws): semi-bluff (bet/raise) — fold equity + outs; can stack off vs aggression at low SPR.
86. Weak draws (gutshots, backdoors): mostly check/fold or single-barrel bluff; don't commit.
87. Air with blockers: candidate bluffs (esp. river) when they block value; air without blockers/equity: give up. **[ENCODED]**
88. Pocket pairs below top pair postflop: set-or-give-up on most boards; small showdown value, don't build pots.

## 8. Bluffing discipline
89. A bluff is an investment in fold equity; if villain can't/won't fold, it's lit money. **[ENCODED]**
90. Prefer bluffs with equity (semi-bluffs) and/or blockers over pure air.
91. Choose the right bluff candidates so your value:bluff ratio is balanced (roughly 2:1 value:bluff on the river at pot-sized bets).
92. Don't fire a third barrel as a pure bluff into a player who has called twice unless a scare card genuinely shifts the range. **[ENCODED]**
93. Give up gracefully: a failed bluff that bricks should stop, not double down. **[ENCODED]**
94. Don't bluff-raise without a clear value-raise range to balance it; a raise-as-bluff with no value raises is transparent.

## 9. Value betting discipline
95. Bet for value whenever a worse hand calls more often than a better hand raises. **[ENCODED]**
96. Get max value: choose sizing that the most worse hands call (not always all-in).
97. Thin value beats checking back when you'll be called by worse — don't "check for pot control" with a hand that wants 3 streets.
98. Charge draws on wet boards (deny equity) — that's value+protection.
99. Don't slowplay on dynamic boards; you let villain draw out cheaply and lose value.
100. Bet-fold is fine: you can value-bet a hand and fold to a raise that only beats you.

## 10. Exploitative adjustments (deviate only on a solid read)
101. vs Calling station: stop bluffing, value-bet thinner and bigger, never barrel air. **[ENCODED-adjacent]**
102. vs Nit: steal relentlessly, fold to their aggression (their bets are value), don't pay big rivers.
103. vs Maniac: tighten up, let them bluff, call/trap wider, don't bluff-raise them.
104. vs Over-folder (folds to c-bets): c-bet/barrel relentlessly, small sizing.
105. vs Sticky/loose-passive: value-bet relentlessly, cut bluffs to near-zero.
106. Only deviate from GTO baseline once the read is solid (~50+ hands); exploiting on noise is -EV. **[ENCODED-adjacent]**
107. The bigger the population leak, the bigger the deviation; default to the unexploitable baseline otherwise.

## 11. Discipline / process
108. Fold equity, pot odds, and ranges decide actions — not the strength of one hand in a vacuum.
109. Don't go on tilt / chase: each decision is independent and must be +EV on its own.
110. When unsure, take the lower-variance sound line (check/call a marginal hand) over the high-variance punt.
111. Position, then range, then board, then bet-sizing — evaluate in that order every hand.
112. Never make a play whose only justification is "I already put chips in" (sunk cost). **[ENCODED]**

---

These are the principles; `soundness.ts` and `principles.ts` encode the load-bearing
ones (the **[ENCODED]** items) as live gates, and this document is the curriculum
from which more get encoded and tuned (always re-checking the behavioral audit so the
solved frequencies stay intact).
