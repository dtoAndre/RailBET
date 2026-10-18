export type Stake = { id: string; prediction: number; stake: number };
export function validateBet(prediction: unknown, stake: unknown) {
  if (!Number.isInteger(prediction) || (prediction as number)<0 || (prediction as number)>360) throw new Error('Escolhe um atraso entre 0 e 360 minutos inteiros.');
  if (!Number.isInteger(stake) || (stake as number)<10 || (stake as number)>500 || (stake as number)%10!==0) throw new Error('Aposta entre 10 e 500 créditos, em múltiplos de 10.');
}
// Largest-remainder allocation keeps every credit accounted for, including ties.
// Stakes are multiples of 10 so the house cut is exactly 10%.
export function settlePool(bets: Stake[], delay: number | null) {
  if (delay!==null && (!Number.isInteger(delay)||delay<0||delay>2880)) throw new Error('Atraso final inválido.');
  const total=bets.reduce((s,b)=>s+b.stake,0);
  if (delay===null || bets.length<2) return {total,houseCut:0,voided:true,payouts:bets.map(b=>({id:b.id,payout:b.stake,winner:false}))};
  const min=Math.min(...bets.map(b=>Math.abs(b.prediction-delay)));
  const winners=bets.filter(b=>Math.abs(b.prediction-delay)===min);
  const winnerTotal=winners.reduce((s,b)=>s+b.stake,0);
  const houseCut=total/10, prize=total-houseCut;
  const shares=winners.map(b=>({id:b.id,payout:Math.floor(prize*b.stake/winnerTotal),remainder:(prize*b.stake)%winnerTotal}));
  let left=prize-shares.reduce((s,b)=>s+b.payout,0);
  shares.sort((a,b)=>b.remainder-a.remainder||a.id.localeCompare(b.id));
  for(const s of shares) if(left-->0) s.payout++;
  return {total,houseCut,voided:false,payouts:bets.map(b=>({id:b.id,payout:shares.find(s=>s.id===b.id)?.payout??0,winner:winners.some(w=>w.id===b.id)}))};
}
