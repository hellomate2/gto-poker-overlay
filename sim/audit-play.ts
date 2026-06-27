import './fake-idb';
import { DecisionEngine } from '../src/core/engine';
import { GameState, Player, Position, Card, Suit, Rank } from '../src/types/poker';
const RK=['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
function mc(r:string,s:Suit):Card{return{rank:r as Rank,suit:s};}
function cards(h:string):[Card,Card]{const a=h[0],b=h[1];if(a===b)return[mc(a,'h'),mc(b,'d')];if(h[2]==='s')return[mc(a,'h'),mc(b,'h')];return[mc(a,'h'),mc(b,'d')];}
function all():string[]{const o:string[]=[];for(let i=0;i<13;i++)for(let j=0;j<13;j++){if(i===j)o.push(RK[i]+RK[i]);else if(i<j)o.push(RK[i]+RK[j]+'s');else o.push(RK[j]+RK[i]+'o');}return o;}
function P(n:string,p:Position,st:number,cb:number,h:boolean):Player{return{name:n,stack:st,position:p,isDealer:p==='SB',isSittingOut:false,seatIndex:p==='SB'?0:1,isHero:h,currentBet:cb,hasActed:false};}
const bb=20;
function g(o:any):GameState{return{tableId:'t',handNumber:1,street:'preflop',pot:0,sidePots:[],heroCards:[mc('A','h'),mc('K','h')],communityCards:[],players:[],heroIndex:0,dealerIndex:0,activePlayerIndex:0,currentBet:bb,minRaise:2*bb,bigBlind:bb,smallBlind:10,actionHistory:{preflop:[],flop:[],turn:[],river:[]},isOurTurn:true,timestamp:1,...o};}
async function freq(eng:DecisionEngine,b:(h:string)=>GameState,cl:(a:string)=>string){const t:any={};for(const h of all()){const d=await eng.decide(b(h));const k=cl(d.action);t[k]=(t[k]||0)+1;}return t;}
const pc=(t:any,...k:string[])=>{const s=Object.values(t).reduce((a:any,b:any)=>a+b,0) as number;return Math.round(100*k.reduce((a,x)=>a+(t[x]||0),0)/s);};
async function run(){const eng=new DecisionEngine();
 const t1=await freq(eng,h=>g({heroCards:cards(h),pot:70,players:[P('bot','BB',1980,bb,true),P('Dev','SB',1950,50,false)],dealerIndex:1,currentBet:50,actionHistory:{preflop:[{type:'raise',amount:50,playerName:'Dev'}],flop:[],turn:[],river:[]}}),a=>a==='raise'||a==='allin'?'3b':a==='call'?'c':'f');
 console.log(`1 BB vs open:  3bet ${pc(t1,'3b')}% call ${pc(t1,'c')}% fold ${pc(t1,'f')}%   (GTO 3bet 13-22, fold 22-30)`);
 const t2=await freq(eng,h=>g({heroCards:cards(h),pot:200,players:[P('bot','SB',1950,50,true),P('Dev','BB',1850,150,false)],currentBet:150,actionHistory:{preflop:[{type:'raise',amount:50,playerName:'bot'},{type:'raise',amount:150,playerName:'Dev'}],flop:[],turn:[],river:[]}}),a=>a==='raise'||a==='allin'?'4b':a==='call'?'c':'f');
 console.log(`2 SB vs 3bet:  4bet ${pc(t2,'4b')}% call ${pc(t2,'c')}% fold ${pc(t2,'f')}%   (value-heavy IP; defend wide ok)`);
 const boards=[['Kd','7h','2s'],['Qh','8c','3s'],['9d','6s','2c'],['Ah','Td','4c'],['Js','9h','5d']];
 let cb=0,cn=0; for(const h of all())for(const b of boards){const s=g({street:'flop',pot:120,heroCards:cards(h),communityCards:b.map(c=>mc(c[0],c[1] as Suit)),players:[P('bot','SB',940,0,true),P('Dev','BB',940,0,false)],currentBet:0,actionHistory:{preflop:[{type:'raise',amount:50,playerName:'bot'},{type:'call',amount:50,playerName:'Dev'}],flop:[],turn:[],river:[]}});const d=await eng.decide(s);if(d.action==='bet'||d.action==='raise')cb++;else cn++;}
 console.log(`3 Flop c-bet (IP aggr): ${Math.round(100*cb/(cb+cn))}%   (GTO 50-70)`);
 let tb=0,tn=0; for(const h of all()){const b=['Kd','7h','2s','Qc'];const s=g({street:'turn',pot:240,heroCards:cards(h),communityCards:b.map(c=>mc(c[0],c[1] as Suit)),players:[P('bot','SB',880,0,true),P('Dev','BB',880,0,false)],currentBet:0,actionHistory:{preflop:[{type:'raise',amount:50,playerName:'bot'},{type:'call',amount:50,playerName:'Dev'}],flop:[{type:'bet',amount:60,playerName:'bot'},{type:'call',amount:60,playerName:'Dev'}],turn:[],river:[]}});const d=await eng.decide(s);if(d.action==='bet'||d.action==='raise')tb++;else tn++;}
 console.log(`4 Turn barrel: ${Math.round(100*tb/(tb+tn))}%   (GTO 40-55)`);
 let rb=0,rn=0; for(const h of all()){const b=['Kd','7h','2s','Qc','5d'];const s=g({street:'river',pot:480,heroCards:cards(h),communityCards:b.map(c=>mc(c[0],c[1] as Suit)),players:[P('bot','SB',760,0,true),P('Dev','BB',760,0,false)],currentBet:0,actionHistory:{preflop:[{type:'raise',amount:50,playerName:'bot'},{type:'call',amount:50,playerName:'Dev'}],flop:[{type:'bet',amount:60,playerName:'bot'},{type:'call',amount:60,playerName:'Dev'}],turn:[{type:'bet',amount:120,playerName:'bot'},{type:'call',amount:120,playerName:'Dev'}],river:[]}});const d=await eng.decide(s);if(d.action==='bet'||d.action==='raise')rb++;else rn++;}
 console.log(`5 River bet: ${Math.round(100*rb/(rb+rn))}%   (GTO 35-45)`);
}
run();
