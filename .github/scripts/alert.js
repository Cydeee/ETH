#!/usr/bin/env node
/*  alert.js – ETH notifier (5-min cron, 60-min mute)
    v2 ▸ adds unified Quality-score (1-10) with per-play weights & tiered bonuses.
           Alerts STILL print when a setup is below its gate – they’re just labelled.
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── 0 ▸ ENV ---------------------------------------------------------------- */
const {
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID  : CHAT,
  LIVE_URL          : LIVE,
  HTTPS_PROXY       : PROXY,
  DEBUG,
  RISK_PCT
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌  Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc = parseFloat(RISK_PCT) || 0.5;
const isDbg  = DEBUG === "true";

/* ───────── helpers ---------------------------------------------------------------- */
const $   = n => Number(n || 0);
const pct = (a,b)=>b?((a-b)/b*100):0;
const fmt = (n,d=0)=>n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt$= n => "$"+fmt(n);
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const LOG=[]; const dbg = m => { if(isDbg) LOG.push(m); };

async function tg(html){
  const r=await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`,{
    method:"POST",agent,
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({chat_id:CHAT,text:html,parse_mode:"HTML",disable_web_page_preview:true})
  });
  const j=await r.json(); if(isDbg) console.log("TG:",j);
  if(!j.ok) throw new Error(`Telegram error: ${j.description}`);
}

const safeJson = u => fetch(u,{agent,timeout:20_000})
  .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

/* ───────── 1 ▸ quality-score engine ---------------------------------------------- */

/* per-factor weights (align, momentum, crowd, structure, risk) */
const WEIGHTS={
  default:[1,1,1,1,1],
  1:[1.0,1.0,1.0,1.2,0.8],
  2:[1.0,1.0,1.0,1.2,0.8],
  3:[0.7,1.0,1.5,0.6,1.2],
  4:[0.8,1.0,1.3,0.7,1.2],
  5:[1.0,1.0,1.2,0.9,0.9],
  6:[0.9,1.1,1.0,1.0,1.0],
  7:[0.9,1.2,1.1,0.8,1.0],
  8:[1.0,1.0,1.3,1.0,0.7],
  9:[1.0,1.2,1.2,0.9,0.7]
};

/* minimal gates */
const MIN_GATE={1:6,2:6,3:5,4:5,5:6,6:5,7:5,8:5,9:5};

/* tiered catalyst bonuses (+0/+1/+2) */
function playBonus(p,d){
  const liq=d.dataB.liquidations||{};
  const liq1h=Math.max($(liq.long1h),$(liq.short1h));
  const bandW= (()=>{ const up=$(d.dataF.levels?.vwapUpper), vw=$(d.dataF.levels?.vwap);
                      return (up&&vw)?pct(up,vw):null; })();
  const neckBreak=d.dataF.neckBreak;

  switch(p.id){
    case 2:  // AVWAP reclaim
      if(neckBreak){
        if(bandW!==null && bandW<=1.5) return 2;
        return 1;
      }
      return 0;
    case 4:  // Liq-Sweep
      if(liq1h>=80e6 || neckBreak) return 2;
      if(liq1h>=40e6) return 1;
      return 0;
    case 8:  // VWAP fade
      if(neckBreak){
        if(bandW!==null && bandW<=1.5) return 2;
        if(bandW!==null && bandW<=2.5) return 1;
      }
      return 0;
    default: return 0;
  }
}

/* compute five sub-factors, apply play-weights, add bonus, return 1-10 */
function computeQualityScore(d,play){
  const price=$(d.dataF.price);

  /* 1 ▸ Alignment */
  const sign = v=>v>0?1:-1;
  const tSign = tf=>{
    const ema50=$(d.dataA[tf].ema50);
    return sign(price-ema50);
  };
  const a15=tSign("15m"), a1h=tSign("1h"), a4h=tSign("4h");
  const align = (a15===a1h && a1h===a4h)?2 : (a15===a1h||a15===a4h||a1h===a4h)?1:0;

  /* 2 ▸ Momentum impulse */
  const roc10=$(d.dataC["15m"].roc10), roc20=$(d.dataC["15m"].roc20);
  const atrPct15=$(d.dataA["15m"].atrPct);
  const impulse = Math.max(Math.abs(roc10),Math.abs(roc20));
  const momentum = impulse >= atrPct15*2 ? 2 : impulse >= atrPct15 ? 1 : 0;

  /* 3 ▸ Liquidity & crowd */
  const relVol=d.dataD.relative["15m"]; const volHigh=relVol==="high"||relVol==="very high";
  const fundingZ=parseFloat(d.dataB.fundingZ); const fundOpp = play.dir==="LONG"? fundingZ<0: fundingZ>0;
  const liq=d.dataB.liquidations||{};
  const liqBias = play.dir==="LONG"? $(liq.short1h)>$(liq.long1h) : $(liq.long1h)>$(liq.short1h);
  const crowd = (volHigh && fundOpp && liqBias)?2 : ((volHigh&&fundOpp)||(fundOpp&&liqBias)||(volHigh&&liqBias))?1:0;

  /* 4 ▸ Structure confluence */
  const vwap=$(d.dataF.levels?.vwap); const poc=$(d.dataF.vpvr?.["4h"]?.poc); const neck=$(d.dataF.neckline);
  let confl=0;
  const near = lvl=>lvl && Math.abs(price-lvl)/price*100<=0.7;
  if(near(vwap)) confl++;
  if(near(poc))  confl++;
  if(neck && near(neck)) confl++;
  const structure = confl>=2?2:confl>=1?1:0;

  /* 5 ▸ Risk backdrop */
  const stress=$(d.dataE.stressIndex);
  const risk = stress<3?2:stress<5?1:0;

  const rawFactors=[align,momentum,crowd,structure,risk];

  /* weighting & scaling */
  const w = WEIGHTS[play.id] || WEIGHTS.default;
  const weighted = rawFactors.reduce((s,v,i)=>s+v*w[i],0);
  const maxRaw   = w.reduce((s,x)=>s+x,0)*2;
  let score = Math.round((weighted/maxRaw)*10);

  /* catalyst bonus */
  score = Math.min(10, score + playBonus(play,d));

  return score;
}

/* ───────── 2 ▸ play generator ------------------------------------------------------ */
function detectPlays(d){
  const plays=[], price=$(d.dataF.price);
  const distOK =(lvl,p=5)=>lvl&&Math.abs(lvl-price)/price*100<=p;

  /* existing rule-set (unchanged thresholds) … */
  /* ------------------------------------------------ Play #1 HH20 Break-Retest */
  const HH20=$(d.dataF.levels?.HH20);
  if(distOK(HH20)&&price>HH20*1.001){
    plays.push({id:1,dir:"LONG",name:"Break-Retest",
      entry:[HH20*1.0005,HH20*1.0015],stop:HH20*0.992,tp1:HH20*1.015,lev:[5,15]});
  }

  /* ------------------------------------------------ Play #2 AVWAP Reclaim */
  const avwap=$(d.dataF.avwapCycle);
  const avAge=(Date.now()-$(d.dataF.avwapAnchorTs||0))/864e5;
  if(distOK(avwap)&&avAge<=30&&price>avwap*1.001){
    const atr4=$(d.dataA["4h"].atrPct)/100;
    plays.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
      entry:[avwap,avwap*1.001],stop:avwap*(1-atr4),tp1:price*1.015,lev:[3,8]});
  }

  /* ------------------------------------------------ Play #3 Funding Fade */
  const fundingZ=parseFloat(d.dataB.fundingZ);
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG",s=dir==="LONG"?1:-1;
    plays.push({id:3,dir,name:"Funding Fade",
      entry:[price],stop:price*(1-s*0.006),tp1:price*(1+s*0.0075),lev:[5,15]});
  }

  /* ------------------------------------------------ Play #4 Liq-Sweep */
  const liq=d.dataB.liquidations||{};
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  const atr15=$(d.dataA["15m"].atrPct);
  if(bigLiq>=25e6&&atr15<=1.5){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    plays.push({id:4,dir,name:"Liq-Sweep",
      entry:[price-price*0.0003*s],stop:price-price*0.004*s,tp1:price+price*0.004*s,lev:[10,50]});
  }

  /* ------------------------------------------------ Play #5 High-OI Squeeze */
  const oiPct=$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
  if(oiPct>=95&&Math.abs(oiΔ)<=2){
    plays.push({id:5,dir:"BREAK",name:"High-OI Box",
      entry:[price],stop:price*0.982,tp1:price*1.04,lev:[5,15]});
  }

  /* ------------------------------------------------ Play #6 EMA Pull-back */
  const adx14=$(d.dataA["4h"].adx14);
  if(adx14>20&&d.dataA["1d"].ema50>d.dataA["1d"].ema200&&price<d.dataA["4h"].ema50){
    const ema=d.dataA["4h"].ema50;
    plays.push({id:6,dir:"LONG",name:"EMA Pull-back",
      entry:[ema*0.999],stop:ema*0.99,tp1:price*1.02,lev:[3,10]});
  }

  /* ------------------------------------------------ Play #7 Opening-Range */
  const now=new Date();
  if(now.getUTCMinutes()===20&&atr15<0.5&&d.dataD.sessionRelVol?.asia>1.2){
    plays.push({id:7,dir:"BREAK",name:"Opening-Range",
      entry:[price],stop:price*(1-atr15/100),tp1:price*(1+atr15/200),lev:[10,25]});
  }

  /* ------------------------------------------------ Play #8 VWAP Fade */
  const vwap=$(d.dataF.levels?.vwap),
        up=$(d.dataF.levels?.vwapUpper),
        lo=$(d.dataF.levels?.vwapLower),
        bandW=(up&&vwap)?pct(up,vwap):null;
  if(bandW&&bandW<3){
    if(up&&price>up&&distOK(up,3)){
      plays.push({id:8,dir:"SHORT",name:"VWAP Fade",
        entry:[price],stop:price*1.007,tp1:vwap,lev:[5,20]});
    }
    if(lo&&price<lo&&distOK(lo,3)){
      plays.push({id:8,dir:"LONG",name:"VWAP Fade",
        entry:[price],stop:price*0.993,tp1:vwap,lev:[5,20]});
    }
  }

  /* ------------------------------------------------ Play #9 Session Kick */
  const roc1h=$(d.dataC["1h"].roc10), ses=d.dataD.sessionRelVol||{};
  const hr=now.getUTCHours();
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4&&(ses.asia>1.5||ses.eu>1.5)){
    const dir=roc1h>0?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    plays.push({id:9,dir,name:"Session Kick",
      entry:[price],stop:price*(1-s*0.004),tp1:price*(1+s*0.01),lev:[5,15]});
  }

  /* ---- score & gate pass ------------------------------------------------ */
  const final=[];
  for(const p of plays){
    const q = computeQualityScore(d,p);
    const gate = MIN_GATE[p.id]||5;
    p.quality = q;
    p.belowGate = q < gate;
    if(p.belowGate) dbg(`Play #${p.id} scored ${q} < gate ${gate} (will tag as informational)`);
    final.push(p);                            // always keep, even if below gate
  }
  return final;
}

/* quick one-liner */
const playLine = p =>
  `• #${p.id} (${p.quality}/10${p.belowGate?"⤓":""}) ${p.name} ${p.dir} @${fmt$(p.entry[0])}${p.entry[1]?`-${fmt$(p.entry[1])}`:""} SL:${fmt$(p.stop)}`;

/* ───────── 3 ▸ HTML builder -------------------------------------------------------- */
function buildMsg(p,d){
  const snap=
`• FundingZ <b>${esc(d.dataB.fundingZ)}</b> | OI30d <b>${esc(d.dataB.oi30dPct)}%</b>
• ADX 4h <b>${esc(d.dataA["4h"].adx14)}</b> | Stress <b>${esc(d.dataE.stressIndex)}</b>
• EU vol <b>${esc(d.dataD.sessionRelVol.eu)}</b> | 15 m vol <b>${esc(d.dataD.relative["15m"])}</b>`;

  const swings = d.dataF.swings?.H1!==null
    ? `\nSwings ➜ H1 ${fmt$(d.dataF.swings.H1)} • H2 ${fmt$(d.dataF.swings.H2)} • neckline ${fmt$(d.dataF.neckline)} (broken? ${d.dataF.neckBreak?"yes":"no"})`
    : "";

  const posUsd=(riskPc/100*10_000)*p.lev[1]/Math.abs(p.entry[0]-p.stop);
  const ts=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  const icon=p.dir==="LONG"?"🟢":"🔴";

  const warn = p.belowGate ? "\n⚠️ <b>Below quality gate – informational only</b>" : "";

  return `${icon} <b>ETH PERP | Play #${p.id} – ${p.name}</b>
<i>${esc(ts)}</i>

<b>Direction:</b> ${p.dir}
<b>Entry zone:</b> ${p.entry.map(v=>fmt$(v)).join(" – ")}
<b>Stop-loss:</b> ${fmt$(p.stop)}
<b>TP 1:</b> ${fmt$(p.tp1)}
<b>Leverage:</b> ${p.lev[0]}× – ${p.lev[1]}×
<b>Quality:</b> ${p.quality}/10${p.belowGate?" (sub-gate)":""}
<b>Risk:</b> ${riskPc}% → pos ≈ ${fmt(posUsd,1)} USD

${snap}${swings}${warn}

<b>Plan</b>
Enter within zone; abort if unfilled in 90 min or opposite trigger forms.

#ETH #Play${p.id}`;
}

/* ───────── 4 ▸ main --------------------------------------------------------------- */
(async()=>{
  try{
    const dash = await safeJson(LIVE);

    const price = $(dash.dataF.price);
    const HH20  = $(dash.dataF.levels?.HH20);
    const avwap = $(dash.dataF.avwapCycle);
    const fundingZ= parseFloat(dash.dataB.fundingZ);
    const bigLiq  = Math.max($(dash.dataB.liquidations?.long1h),$(dash.dataB.liquidations?.short1h));

    const plays = detectPlays(dash);

    /* audit */
    const idList=plays.map(p=>`${p.id}(${p.quality})`).join(",")||"none";
    console.log(`ALERT SUMMARY | price=${fmt$(price)}  ${HH20?`HH20Δ=${pct(price,HH20).toFixed(2)}%  `:""}${avwap?`AVWAPΔ=${pct(price,avwap).toFixed(2)}%  `:""}fundingZ=${fundingZ}  bigLiq=$${fmt(bigLiq/1e6,0)}M  plays=[${idList}]`);
    plays.forEach(p=>console.log(playLine(p)));
    if(isDbg){
      console.log("===== TRACE =====");
      console.log(LOG.join("\n"));
      console.log("=================");
    }

    if(!plays.length) return;

    /* mute window */
    const cache="/tmp/alert_cache.json";
    let last={ts:0}; try{ last=JSON.parse(fs.readFileSync(cache,"utf8")); }catch{}
    if(!isDbg && Date.now()-last.ts<3_600_000){
      console.log("Muted 60-min window"); return;
    }

    for(const p of plays) await tg(buildMsg(p,dash));
    fs.writeFileSync(cache,JSON.stringify({ts:Date.now()}));
    console.log(`✅ Sent ${plays.length} alert(s)`);

  }catch(err){
    console.error("❌",err);
    try{ await tg(esc(`Bot error: ${err.message}`)); }catch{}
    process.exit(1);
  }
})();
