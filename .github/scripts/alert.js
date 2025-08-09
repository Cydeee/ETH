#!/usr/bin/env node
/*  alert.js – ETH notifier (5-min cron, 60-min mute)
    v2 ▸ adds unified Quality-score (1-10) with per-play weights & tiered bonuses.
           Alerts STILL print when a setup is below its gate – they’re just labelled.

    v2.4 ▸ regime-aware + robust fetch + CI-friendly diagnostics (ETH edition)
      - Detect HTF regime (4h/1d) and LTF regime (15m) once per tick
      - Adjust per-play gates or deny plays that don’t fit the regime
      - Adds a SIGNAL CHECK REPORT to CI logs: shows each signal checked + failure reasons
      - Keeps Telegram output identical in format (same lines/labels/emojis), but "ETH PERP" + #ETH
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
  RISK_PCT,
  ACCOUNT_EQUITY,
  FETCH_TIMEOUT_MS,
  FETCH_RETRIES,
  SOFT_FAIL
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌  Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const agent        = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc       = parseFloat(RISK_PCT) || 0.5;
const acctEq       = parseFloat(ACCOUNT_EQUITY) || 10_000; // for sizing display only
const isDbg        = DEBUG === "true";
const fetchTimeout = parseInt(FETCH_TIMEOUT_MS || "", 10) || 45_000;
const fetchRetries = parseInt(FETCH_RETRIES || "", 10) || 2; // total attempts = retries+1
const softFail     = SOFT_FAIL === "true";

/* ───────── helpers ---------------------------------------------------------------- */
const $   = n => Number(n || 0);
const pct = (a,b)=>b?((a-b)/b*100):0;
const fmt = (n,d=0)=>Number(n||0).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
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

// Retry + backoff wrapper for node-fetch v3+
async function safeJson(u, opt) {
  const { timeoutMs = fetchTimeout, retries = fetchRetries } =
    typeof opt === "number" ? { timeoutMs: opt, retries: fetchRetries } :
    (opt || {});

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(u, { agent, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      const isAbort = err?.name === "AbortError" || err?.type === "aborted";
      dbg(`safeJson attempt ${attempt + 1} failed: ${isAbort ? "AbortError" : err?.message}`);
      if (attempt === retries) throw err;
      const wait = Math.min(30_000, (500 << attempt) + Math.floor(Math.random() * 300)); // exp backoff + jitter
      await new Promise(res => setTimeout(res, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

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
function vwapBandWidthPct(d){
  const up=$(d.dataF.levels?.vwapUpper), vw=$(d.dataF.levels?.vwap), lo=$(d.dataF.levels?.vwapLower);
  if(up && lo && vw) return ((up-lo)/(2*vw))*100; // symmetric width around mid
  if(up && vw)         return pct(up,vw);         // fallback to original behavior
  return null;
}
function playBonus(p,d){
  const liq=d.dataB.liquidations||{};
  const liq1h=Math.max($(liq.long1h),$(liq.short1h));
  const bandW=vwapBandWidthPct(d);
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

  /* 1 ▸ Alignment (with tolerance & neutral handling) */
  const tol=0.0005; // ~0.05%
  const sign = v => (v>tol)? 1 : (v<-tol? -1 : 0);
  const tSign = tf=>{
    const ema50=$(d.dataA[tf].ema50);
    return sign((price-ema50)/price);
  };
  const a15=tSign("15m"), a1h=tSign("1h"), a4h=tSign("4h");
  const nonZero=[a15,a1h,a4h].filter(x=>x!==0);
  const allSame = nonZero.length===3 && nonZero.every(x=>x===nonZero[0]);
  const anyTwoSame = (a15!==0 && a15===a1h) || (a15!==0 && a15===a4h) || (a1h!==0 && a1h===a4h);
  const align = allSame ? 2 : anyTwoSame ? 1 : 0;

  /* 2 ▸ Momentum impulse */
  const roc10=$(d.dataC["15m"].roc10), roc20=$(d.dataC["15m"].roc20);
  const atrPct15=$(d.dataA["15m"].atrPct);
  const impulse = Math.max(Math.abs(roc10),Math.abs(roc20));
  const momentum = impulse >= atrPct15*2 ? 2 : impulse >= atrPct15 ? 1 : 0;

  /* 3 ▸ Liquidity & crowd (neutral for BREAK plays) */
  const relVol=d.dataD.relative["15m"]; const volHigh=relVol==="high"||relVol==="very high";
  const fundingZ=parseFloat(d.dataB.fundingZ);
  const liq=d.dataB.liquidations||{};
  const isLong  = play.dir==="LONG";
  const isShort = play.dir==="SHORT";
  const isBreak = play.dir==="BREAK";
  const fundOpp = isBreak ? false : (isLong ? fundingZ<0 : fundingZ>0);
  const liqBias = isBreak ? false : (isLong ? $(liq.short1h)>$(liq.long1h) : $(liq.long1h)>$(liq.short1h));
  const crowd = (volHigh && fundOpp && liqBias)?2 : ((volHigh&&fundOpp)||(fundOpp&&liqBias)||(volHigh&&liqBias))?1:0;

  /* 4 ▸ Structure confluence (ATR-scaled proximity) */
  const vwap=$(d.dataF.levels?.vwap); const poc=$(d.dataF.vpvr?.["4h"]?.poc); const neck=$(d.dataF.neckline);
  const atr15 = $(d.dataA["15m"].atrPct);
  const tolPct = Math.max(0.35*atr15, 0.5); // min 0.5%, scales up with ATR
  const near = lvl=>lvl && Math.abs(price-lvl)/price*100<=tolPct;
  let confl=0;
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

/* ───────── 1.5 ▸ regime detection & gate adjusters -------------------------------- */

/* Classify market regime using available fields */
function computeRegime(d){
  const price=$(d.dataF.price);
  const ema50d=$(d.dataA["1d"]?.ema50);
  const ema200d=$(d.dataA["1d"]?.ema200);
  const ema50_4h=$(d.dataA["4h"]?.ema50);
  const adx4h=$(d.dataA["4h"]?.adx14);
  const relVol15=d.dataD?.relative?.["15m"];
  const volHigh15 = relVol15==="high" || relVol15==="very high";
  const atr15=$(d.dataA["15m"]?.atrPct);        // %
  const roc15=Math.abs($(d.dataC["15m"]?.roc10)); // %
  const bandW=vwapBandWidthPct(d);              // %

  // HTF trend using EMAs and ADX + price location
  const emaTrendUp   = ema50d && ema200d && ema50d > ema200d;
  const emaTrendDown = ema50d && ema200d && ema50d < ema200d;
  const adxStrong    = $(adx4h) >= 25;
  const above4h50    = price > $(ema50_4h);
  const below4h50    = price < $(ema50_4h);

  let htf="range";
  if ((emaTrendUp && above4h50) || (adxStrong && above4h50)) htf="up";
  else if ((emaTrendDown && below4h50) || (adxStrong && below4h50)) htf="down";

  // LTF compression/expansion
  const bandOK = bandW!=null && bandW <= 2.0;
  const lowATR = atr15!=null && atr15 <= 0.8;
  const compression = !!(bandOK && lowATR && !volHigh15);
  const expansion   = !compression && ((roc15!=null && atr15!=null && roc15 >= atr15) || volHigh15);

  const regime = { htf, adxStrong, ltfCompression: compression, ltfExpansion: expansion, bandW, atr15, relVol15 };
  dbg(`Regime: htf=${htf}, adxStrong=${adxStrong}, ltfCompression=${compression}, ltfExpansion=${expansion}, bandW=${bandW?.toFixed?.(2)}%, atr15=${atr15}`);
  return regime;
}

/* Per-signal regime-aware gate adjustment (or denial) */
function regimeAdjustGate(p, d, R){
  let gateAdj = 0;
  let deny = false;

  const oppToHTF =
    (R.htf==="up"   && p.dir==="SHORT") ||
    (R.htf==="down" && p.dir==="LONG");

  switch(p.id){
    /* Trend continuation plays */
    case 1: case 2: case 6: case 9:
      if(R.htf==="range") gateAdj += 1;
      if(R.adxStrong && oppToHTF) gateAdj += 2;
      break;

    /* Mean-reversion plays */
    case 4: case 8:
      if(R.adxStrong && R.htf!=="range" && !d.dataF.neckBreak) gateAdj += 2;
      if(R.ltfExpansion && !R.ltfCompression) gateAdj += 1;
      break;

    /* Breakout from balance (needs compression first) */
    case 5: case 7:
      if(!R.ltfCompression){
        deny = true;
      }
      break;

    /* Contrarian crowd play */
    case 3:
      if(R.adxStrong){
        if(oppToHTF) gateAdj += 2; else gateAdj += 1;
      }
      break;

    default: break;
  }

  return { gateAdj, deny };
}

/* ───────── 2 ▸ signal evaluation with diagnostics --------------------------------- */
function evaluateSignals(d){
  const checks=[];            // per-signal diagnostics
  const plays=[];             // detected plays (for scoring/gating/Telegram)
  const price=$(d.dataF.price);
  const distOK =(lvl,p=5)=>lvl&&Math.abs(lvl-price)/price*100<=p;

  const addCheck=(id,name,passed,reasons=[])=>{
    checks.push({id,name,result:passed?"DETECTED":"SKIPPED",reasons});
  };

  /* #1 HH20 Break-Retest */
  {
    const name="Break-Retest";
    const HH20=$(d.dataF.levels?.HH20);
    const c1 = !!distOK(HH20);
    const c2 = HH20 ? price>HH20*1.001 : false;
    if(c1 && c2){
      plays.push({id:1,dir:"LONG",name,
        entry:[HH20*1.0005,HH20*1.0015],stop:HH20*0.992,tp1:HH20*1.015,lev:[5,15]});
      addCheck(1,name,true);
    }else{
      const reasons=[];
      if(!HH20) reasons.push("HH20 missing");
      if(!c1) reasons.push("price not within 5% of HH20");
      if(HH20 && !c2) reasons.push("price not > HH20 by 0.1%");
      addCheck(1,name,false,reasons);
    }
  }

  /* #2 AVWAP Reclaim */
  {
    const name="AVWAP Reclaim";
    const avwap=$(d.dataF.avwapCycle);
    const ageDays=(Date.now()-$(d.dataF.avwapAnchorTs||0))/864e5;
    const c1 = !!distOK(avwap);
    const c2 = ageDays<=30;
    const c3 = avwap ? price>avwap*1.001 : false;
    if(c1 && c2 && c3){
      const atr4=$(d.dataA["4h"].atrPct)/100;
      plays.push({id:2,dir:"LONG",name,
        entry:[avwap,avwap*1.001],stop:avwap*(1-atr4),tp1:price*1.015,lev:[3,8]});
      addCheck(2,name,true);
    }else{
      const reasons=[];
      if(!avwap) reasons.push("AVWAP missing");
      if(!c1) reasons.push("price not near AVWAP (≤5%)");
      if(!c2) reasons.push(`anchor too old (${ageDays?.toFixed?.(1)}d)`);
      if(avwap && !c3) reasons.push("no reclaim (>0.1%)");
      addCheck(2,name,false,reasons);
    }
  }

  /* #3 Funding Fade */
  {
    const name="Funding Fade";
    const fz = Math.abs(parseFloat(d.dataB.fundingZ));
    const c1 = fz>=2;
    if(c1){
      const dir=(parseFloat(d.dataB.fundingZ)>0)?"SHORT":"LONG",s=dir==="LONG"?1:-1;
      plays.push({id:3,dir,name,
        entry:[price],stop:price*(1-s*0.006),tp1:price*(1+s*0.0075),lev:[5,15]});
      addCheck(3,name,true);
    }else{
      addCheck(3,name,false,[`|fundingZ| ${fz?.toFixed?.(2)} < 2`]);
    }
  }

  /* #4 Liq-Sweep */
  {
    const name="Liq-Sweep";
    const liq=d.dataB.liquidations||{};
    const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
    const atr15=$(d.dataA["15m"].atrPct);
    const c1 = bigLiq>=25e6;
    const c2 = atr15<=1.5;
    if(c1 && c2){
      const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT",s=dir==="LONG"?1:-1;
      plays.push({id:4,dir,name,
        entry:[price-price*0.0007*s],stop:price-price*0.004*s,tp1:price+price*0.004*s,lev:[10,50]});
      addCheck(4,name,true);
    }else{
      const r=[];
      if(!c1) r.push(`liquidations ${fmt(bigLiq/1e6,0)}M < 25M`);
      if(!c2) r.push(`ATR15 ${atr15?.toFixed?.(2)}% > 1.5%`);
      addCheck(4,name,false,r);
    }
  }

  /* #5 High-OI Box */
  {
    const name="High-OI Box";
    const oiPct=$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
    const c1 = oiPct>=95;
    const c2 = Math.abs(oiΔ)<=2;
    if(c1 && c2){
      plays.push({id:5,dir:"BREAK",name,
        entry:[price],stop:price*0.982,tp1:price*1.04,lev:[5,15]});
      addCheck(5,name,true);
    }else{
      const r=[];
      if(!c1) r.push(`OI30d ${fmt(oiPct,0)}% < 95%`);
      if(!c2) r.push(`|oiΔ24h| ${fmt(Math.abs(oiΔ),2)}% > 2%`);
      addCheck(5,name,false,r);
    }
  }

  /* #6 EMA Pull-back */
  {
    const name="EMA Pull-back";
    const adx14=$(d.dataA["4h"].adx14);
    const ema50d=$(d.dataA["1d"].ema50);
    const ema200d=$(d.dataA["1d"].ema200);
    const ema50_4h=$(d.dataA["4h"].ema50);
    const c1 = adx14>20;
    const c2 = ema50d>ema200d;
    const c3 = price<ema50_4h;
    if(c1 && c2 && c3){
      const entry = ema50_4h*0.999;
      const stop  = ema50_4h*0.99;
      const tp1   = entry*1.02;
      plays.push({id:6,dir:"LONG",name,entry:[entry],stop,tp1,lev:[3,10]});
      addCheck(6,name,true);
    }else{
      const r=[];
      if(!c1) r.push(`ADX4h ${fmt(adx14,0)} ≤ 20`);
      if(!c2) r.push("EMA50d ≤ EMA200d");
      if(!c3) r.push("price ≥ EMA50 4h");
      addCheck(6,name,false,r);
    }
  }

  /* #7 Opening-Range */
  {
    const name="Opening-Range";
    const now=new Date();
    const atr15=$(d.dataA["15m"].atrPct);
    const asia=d.dataD.sessionRelVol?.asia;
    const c1 = now.getUTCMinutes()===20;
    const c2 = atr15<0.5;
    const c3 = asia>1.2;
    if(c1 && c2 && c3){
      const slFrac = atr15/100;
      const rr = 1.5;
      const stop = price*(1 - slFrac);
      const tp1  = price*(1 + slFrac*rr);
      plays.push({id:7,dir:"BREAK",name,entry:[price],stop,tp1,lev:[10,25]});
      addCheck(7,name,true);
    }else{
      const r=[];
      if(!c1) r.push("minute != 20");
      if(!c2) r.push(`ATR15 ${atr15?.toFixed?.(2)}% ≥ 0.5%`);
      if(!c3) r.push(`Asia rel vol ${asia} ≤ 1.2`);
      addCheck(7,name,false,r);
    }
  }

  /* #8 VWAP Fade */
  {
    const name="VWAP Fade";
    const vwap=$(d.dataF.levels?.vwap),
          up=$(d.dataF.levels?.vwapUpper),
          lo=$(d.dataF.levels?.vwapLower),
          bandW=vwapBandWidthPct(d);
    const bandOK = bandW && bandW<3;
    let triggered=false; const r=[];
    if(!bandOK) r.push(`bandW ${bandW?.toFixed?.(2)}% ≥ 3% or missing`);
    if(bandOK && up && price>up && distOK(up,3)){
      plays.push({id:8,dir:"SHORT",name,entry:[price],stop:price*1.007,tp1:vwap,lev:[5,20]});
      triggered=true;
    }
    if(bandOK && lo && price<lo && distOK(lo,3)){
      plays.push({id:8,dir:"LONG",name,entry:[price],stop:price*0.993,tp1:vwap,lev:[5,20]});
      triggered=true;
    }
    if(triggered) addCheck(8,name,true);
    else{
      if(bandOK){
        if(!(up && price>up && distOK(up,3))) r.push("no upper fade condition");
        if(!(lo && price<lo && distOK(lo,3))) r.push("no lower fade condition");
      }
      addCheck(8,name,false,r);
    }
  }

  /* #9 Session Kick */
  {
    const name="Session Kick";
    const roc1h=$(d.dataC["1h"].roc10); const ses=d.dataD.sessionRelVol||{};
    const now=new Date(); const hr=now.getUTCHours();
    const c1 = (hr===8||hr===14);
    const c2 = Math.abs(roc1h)>=0.4;
    const c3 = (ses.asia>1.5||ses.eu>1.5);
    if(c1 && c2 && c3){
      const dir=roc1h>0?"LONG":"SHORT",s=dir==="LONG"?1:-1;
      plays.push({id:9,dir,name,entry:[price],stop:price*(1-s*0.004),tp1:price*(1+s*0.01),lev:[5,15]});
      addCheck(9,name,true);
    }else{
      const r=[];
      if(!c1) r.push("hour not 8 or 14 UTC");
      if(!c2) r.push(`|ROC1h| ${Math.abs(roc1h)?.toFixed?.(2)}% < 0.4%`);
      if(!c3) r.push(`session vol low (ASIA ${ses.asia}, EU ${ses.eu})`);
      addCheck(9,name,false,r);
    }
  }

  return { plays, checks };
}

/* quick one-liner (console only) */
const playLine = p =>
  `• #${p.id} (${p.quality}/10${p.belowGate?"⤓":""}) ${p.name} ${p.dir} @${fmt$(p.entry[0])}${p.entry[1]?`-${fmt$(p.entry[1])}`:""} SL:${fmt$(p.stop)}`;

/* ───────── 3 ▸ HTML builder (Telegram output unchanged) --------------------------- */
function buildMsg(p,d){
  const snap=
`• FundingZ <b>${esc(d.dataB.fundingZ)}</b> | OI30d <b>${esc(d.dataB.oi30dPct)}%</b>
• ADX 4h <b>${esc(d.dataA["4h"].adx14)}</b> | Stress <b>${esc(d.dataE.stressIndex)}</b>
• EU vol <b>${esc(d.dataD.sessionRelVol.eu)}</b> | 15 m vol <b>${esc(d.dataD.relative["15m"])}</b>`;

  // robust swings guard
  const hasSwings = !!d.dataF?.swings && d.dataF.swings.H1 != null && d.dataF.swings.H2 != null;
  const swings = hasSwings
    ? `\nSwings ➜ H1 ${fmt$(d.dataF.swings.H1)} • H2 ${fmt$(d.dataF.swings.H2)} • neckline ${fmt$(d.dataF.neckline)} (broken? ${d.dataF.neckBreak?"yes":"no"})`
    : "";

  // position sizing display: notional sized to risk, no leverage multiplier
  const entry0 = p.entry[0];
  const risk$  = acctEq * (riskPc/100);
  const riskD  = Math.abs(entry0 - p.stop);
  const qty    = riskD ? (risk$ / riskD) : 0; // coin size
  const posUsd = qty * entry0;                // notional USD

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

/* ───────── 4 ▸ de-dupe & mute helpers -------------------------------------------- */
function playKey(p,d){
  // Prefer stable reference level per play; fallback to coarse price bucket
  const priceBucket = Math.round($(d.dataF.price)/50)*50;
  switch(p.id){
    case 1: return `1:${p.dir}:${Math.round($(d.dataF.levels?.HH20)||0)}`;
    case 2: return `2:${p.dir}:${Math.round($(d.dataF.avwapCycle)||0)}`;
    case 8: {
      const up=$(d.dataF.levels?.vwapUpper), lo=$(d.dataF.levels?.vwapLower);
      return `8:${p.dir}:${Math.round((p.dir==="LONG"?lo:up)||0)}`;
    }
    default: return `${p.id}:${p.dir}:${priceBucket}`;
  }
}

function loadCache(path){
  try{ return JSON.parse(fs.readFileSync(path,"utf8")); }catch{ return { ts:0, plays:{} }; }
}
function saveCache(path,obj){
  try{ fs.writeFileSync(path,JSON.stringify(obj)); }catch{}
}

/* ───────── 5 ▸ main --------------------------------------------------------------- */
(async()=>{
  try{
    const dash = await safeJson(LIVE, { timeoutMs: fetchTimeout, retries: fetchRetries });

    const price = $(dash.dataF.price);
    const HH20  = $(dash.dataF.levels?.HH20);
    const avwap = $(dash.dataF.avwapCycle);
    const fundingZ= parseFloat(dash.dataB.fundingZ);
    const bigLiq  = Math.max($(dash.dataB.liquidations?.long1h),$(dash.dataB.liquidations?.short1h));

    // Compute regime once
    const REGIME = computeRegime(dash);

    // Evaluate signals with diagnostics
    const { plays, checks } = evaluateSignals(dash);

    // Apply regime-aware gate adjustments / denials BEFORE audit & sending
    for(const p of plays){
      const { gateAdj, deny } = regimeAdjustGate(p, dash, REGIME);
      const baseGate = MIN_GATE[p.id] || 5;
      const gate = Math.max(1, baseGate + gateAdj);
      p.quality = p.quality ?? computeQualityScore(dash,p);
      p.belowGate = deny ? true : (p.quality < gate);
      p._gateInfo = { baseGate, gateAdj, finalGate: gate, deny };
    }

    /* ===== SIGNAL CHECK REPORT (always printed) ===== */
    console.log("=== SIGNAL CHECK REPORT ===");
    const bandW = vwapBandWidthPct(dash);
    console.log(`Regime: HTF=${REGIME.htf}, ADX4hStrong=${REGIME.adxStrong}, LTF Compression=${REGIME.ltfCompression}, LTF Expansion=${REGIME.ltfExpansion}, bandW=${bandW!=null?bandW.toFixed(2)+'%':'n/a'}, ATR15=${dash.dataA?.["15m"]?.atrPct!=null?dash.dataA["15m"].atrPct.toFixed(2)+'%':'n/a'}`);

    const byId = new Map();
    for (const c of checks){
      byId.set(c.id, { name:c.name, detected: c.result==="DETECTED", reasons: c.reasons });
      const mark = c.result==="DETECTED" ? "✓" : "✗";
      const why  = c.result==="DETECTED" ? "ok" : (c.reasons.length? c.reasons.join("; ") : "conditions not met");
      console.log(`#${c.id} ${c.name}: ${mark} ${c.result}${c.result==="DETECTED"?"":` — ${why}`}`);
    }

    /* audit (per-play lines & summary with gates) */
    const idList=plays.map(p=>`${p.id}(${p.quality}${p.belowGate?"⤓":""})`).join(",")||"none";
    console.log(`ALERT SUMMARY | price=${fmt$(price)}  ${HH20?`HH20Δ=${pct(price,HH20).toFixed(2)}%  `:""}${avwap?`AVWAPΔ=${pct(price,avwap).toFixed(2)}%  `:""}fundingZ=${fundingZ}  bigLiq=$${fmt(bigLiq/1e6,0)}M  plays=[${idList}]`);
    plays.forEach(p=>console.log(playLine(p)));

    // Post-gate summary per signal id
    console.log("=== POST-GATE SUMMARY ===");
    for (const [id, meta] of byId.entries()){
      const detectedPlays = plays.filter(p=>p.id===id);
      if (!meta.detected){
        console.log(`#${id} ${meta.name}: SKIPPED pre-gate (no signal)`);
        continue;
      }
      if (!detectedPlays.length){
        console.log(`#${id} ${meta.name}: DETECTED, but no instances found (unexpected)`);
        continue;
      }
      const sentable = detectedPlays.filter(p=>!p.belowGate);
      if (sentable.length){
        const quals = sentable.map(p=>p.quality).join(",");
        console.log(`#${id} ${meta.name}: READY (passed gate) — quality=${quals}`);
      }else{
        const reasons = detectedPlays.map(p=>{
          const gi=p._gateInfo||{}; return `q=${p.quality} < gate ${gi.finalGate} (base ${gi.baseGate}${gi.gateAdj?` +${gi.gateAdj}`:""})${gi.deny?" denied by regime":""}`;
        }).join(" | ");
        console.log(`#${id} ${meta.name}: GATED — ${reasons}`);
      }
    }
    console.log("=== END CHECK REPORT ===");

    if(!plays.length){
      console.log("No plays detected — run finished OK.");
      return;
    }

    /* quality gate filter for Telegram */
    const sendable = plays.filter(p=>!p.belowGate);
    if(!sendable.length) {
      console.log("No plays passed (after regime adjust) – nothing to send.");
      return;
    }

    /* mute windows: global + per-play TTL with A-tier override */
    const cachePath="/tmp/alert_cache.json";
    const cache=loadCache(cachePath);
    const nowTs=Date.now();

    const hasATier = sendable.some(p=>p.quality>=8); // A-tier bypass

    const TTL = 30*60*1000; // per-play TTL
    const globalMuted = !isDbg && (nowTs-(cache.ts||0) < 3_600_000) && !hasATier;
    if(globalMuted){
      console.log("Muted 60-min window"); return;
    }

    const fresh = sendable.filter(p=>{
      const key = playKey(p,dash);
      const lastTs = cache.plays?.[key] || 0;
      if(nowTs - lastTs < TTL) { console.log(`Skip duplicate (TTL) key=${key}`); return false; }
      return true;
    });

    if(!fresh.length){
      console.log("All plays within per-play TTL – nothing to send.");
      return;
    }

    for(const p of fresh) await tg(buildMsg(p,dash));

    if(!isDbg){
      cache.ts = nowTs;
      cache.plays = cache.plays || {};
      for(const p of fresh){
        cache.plays[playKey(p,dash)] = nowTs;
      }
      saveCache(cachePath,cache);
    }

    console.log(`✅ HEALTHCHECK: Sent ${fresh.length} alert(s) — run completed successfully`);

  }catch(err){
    console.error("❌",err);
    try{ await tg(esc(`Bot error: ${err.message}`)); }catch{}
    const isAbort = err?.name === "AbortError" || err?.type === "aborted";
    if (isAbort || softFail) {
      console.log("⚠️  HEALTHCHECK: fetch aborted/soft-failed — diagnostics not available this run");
      process.exit(0);
    } else {
      process.exit(1);
    }
  }
})();
