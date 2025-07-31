/*  Netlify Node 18 Edge Function – data.js
    Builds an ETH dashboard JSON with live price, indicators, VPVR, levels.
    Outbound requests honour HTTPS_PROXY if set.
    Added: 4 h ADX-14, abs./percentile OI, sessionRelVol, cycle-anchored VWAP,
    swing-high/low detection (120 × 1 min bars).
*/

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT = process.env.HTTPS_PROXY
  ? new HttpsProxyAgent(process.env.HTTPS_PROXY)
  : undefined;

async function safeJson(url) {
  const r = await fetch(url, { agent: AGENT, timeout: 20_000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ───────── Math helpers ───────── */
const sma = (a,p)=>a.slice(-p).reduce((s,v)=>s+v,0)/p;
const ema = (a,p)=>{ if(a.length<p) return 0; const k=2/(p+1); let e=sma(a.slice(0,p),p); for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; };
const rsi = (a,p)=>{ if(a.length<p+1) return 0; let up=0,dn=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d;} let au=up/p,ad=dn/p; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1]; au=(au*(p-1)+Math.max(d,0))/p; ad=(ad*(p-1)+Math.max(-d,0))/p;} return ad?100-100/(1+au/ad):100; };
const atr = (h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return sma(tr,p); };
const roc = (a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

/* Wilder-ADX (p = 14) – only called for 4 h TF */
function adx(h,l,c,p=14){
  if(h.length<p+1) return 0;
  const dmP=[],dmM=[],tr=[];
  for(let i=1;i<h.length;i++){
    const up=h[i]-h[i-1], dn=l[i-1]-l[i];
    dmP.push(up>dn&&up>0?up:0);
    dmM.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  }
  const smooth=a=>{const r=[sma(a.slice(0,p),p)];for(let i=p;i<a.length;i++)r.push(r.at(-1)-r.at(-1)/p+a[i]);return r;};
  const tr14=smooth(tr), plus14=smooth(dmP), minus14=smooth(dmM);
  const dx=[]; for(let i=0;i<plus14.length;i++){
    const pdi=plus14[i]/(tr14[i]||1)*100, mdi=minus14[i]/(tr14[i]||1)*100;
    dx.push(Math.abs(pdi-mdi)/(pdi+mdi||1)*100);
  }
  return +(sma(dx.slice(-p),p).toFixed(2));
}

/* ───────── Dashboard builder ───────── */
async function buildDashboardData() {
  const SYMBOL = "ETHUSDT";
  const LIMIT  = 250;

  const out = {
    dataA:{}, dataB:null, dataC:{}, dataD:{}, dataE:null, dataF:null, dataG:null, dataH:null,
    errors:[]
  };

  /* A – Indicators (added ADX-14 on 4 h) */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c = kl.map(r=>+r[4]), h = kl.map(r=>+r[2]), l = kl.map(r=>+r[3]), last = c.at(-1)||1;
      const macdArr = c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      out.dataA[tf] = {
        ema50   : +ema(c,50).toFixed(2),
        ema200  : +ema(c,200).toFixed(2),
        rsi14   : +rsi(c,14).toFixed(1),
        atrPct  : +((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist: +(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
      if(tf==="4h") out.dataA[tf].adx14 = adx(h,l,c,14);
    } catch(e){ out.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* B – Derivatives (added oiCurrent & oi30dPct) */
  try {
    const fr = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates = fr.slice(-42).map(r=>+r.fundingRate);
    const mu = sma(rates,rates.length);
    const sd = Math.sqrt(rates.reduce((s,x)=>s+(x-mu)**2,0)/rates.length);
    const fundingZ = sd ? ((rates.at(-1)-mu)/sd).toFixed(2) : "0.00";

    const oiNow  = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist = await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=500`);
    const histArr = oiHist.map(o=>+o.sumOpenInterest);
    const oiCurrent = +oiNow.openInterest;
    const oi30dPct = +(histArr.filter(v=>v<=oiCurrent).length / histArr.length * 100).toFixed(1);
    const base24 = histArr.length>25 ? histArr.at(-25) : histArr[0];
    const oiDelta24h = base24 ? (((oiCurrent-base24)/base24)*100).toFixed(1) : null;

    const liqRaw = await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const eth = (liqRaw.data||[]).find(r=>r.symbol==="ETH") || {};
    out.dataB = {
      fundingZ, oiDelta24h,
      oiCurrent:+oiCurrent.toFixed(2), oi30dPct,
      liquidations:{
        long1h:eth.long1h||0, short1h:eth.short1h||0,
        long4h:eth.long4h||0, short4h:eth.short4h||0,
        long24h:eth.long24h||0, short24h:eth.short24h||0
      }
    };
  } catch(e){ out.errors.push(`B: ${e.message}`); }

  /* C – ROC (unchanged) */
  for (const tf of ["15m","1h","4h","1d"]) {
    try{
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c = kl.map(r=>+r[4]);
      out.dataC[tf] = { roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    } catch(e){ out.errors.push(`C[${tf}]: ${e.message}`); }
  }

  /* D – Volume & CVD (added sessionRelVol) */
  try {
    const h240 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=240`);
    const bucket = {asia:[],eu:[],us:[]};
    h240.forEach(b=>{
      const hr=new Date(+b[0]).getUTCHours(), vol=+b[7];
      if(hr<8) bucket.asia.push(vol);
      else if(hr<14) bucket.eu.push(vol);
      else if(hr<22) bucket.us.push(vol);
    });
    const rel = a=>a.length<21?1:+(a.at(-1)/sma(a.slice(-21,-1),20)).toFixed(2);
    out.dataD.sessionRelVol = { asia:rel(bucket.asia), eu:rel(bucket.eu), us:rel(bucket.us) };

    const win = {'15m':0.25,'1h':1,'4h':4,'24h':24};
    out.dataD.cvd = {};
    for (const [lbl,hours] of Object.entries(win)) {
      const end = Date.now(), start = end - hours*3600_000;
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; kl.forEach(k=>+k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]);
      const agg = await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; agg.forEach(t=>{ cvd+= t.m ? -t.q : +t.q; });
      out.dataD[lbl] = { bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      out.dataD.cvd[lbl] = +cvd.toFixed(2);
    }
    const tot24 = out.dataD["24h"].totalVol;
    const base = {'15m':tot24/96,'1h':tot24/24,'4h':tot24/6};
    out.dataD.relative = {};
    for (const lbl of ["15m","1h","4h"]) {
      const r = out.dataD[lbl].totalVol / Math.max(base[lbl],1);
      out.dataD.relative[lbl] = r>2 ? "very high" : r>1.2 ? "high" : r<0.5 ? "low" : "normal";
    }
  } catch(e){ out.errors.push(`D: ${e.message}`); }

  /* E – Stress (levScore now uses oi30dPct) */
  try {
    const b = Math.min(3, Math.abs(+out.dataB.fundingZ||0));
    const l = out.dataB.oi30dPct ? Math.min(3,(out.dataB.oi30dPct-50)/10) : 0;
    const vFlag = out.dataD.relative["15m"];
    const v = vFlag==="very high"?2 : vFlag==="high"?1 : 0;
    const liq = out.dataB.liquidations || {};
    const imb = Math.abs((liq.long24h||0)-(liq.short24h||0));
    const q = Math.min(2, imb/1e6);
    const stress = b + l + v + q;
    out.dataE = {
      stressIndex:+stress.toFixed(2),
      highRisk:stress>=5,
      components:{biasScore:b,levScore:l,volScore:v,liqScore:q}
    };
  } catch(e){ out.dataE=null; out.errors.push(`E: ${e.message}`); }

  /* F – VPVR, Levels, Live Price (added avwapCycle, swing detection) */
  try {
    const h4 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const d1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=60`);
    const w1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=60`);
    const vp = bars => {
      const bkt={};
      bars.forEach(b=>{
        const px=(+b[2]+ +b[3]+ +b[4])/3, key=Math.round(px/100)*100;
        bkt[key]=(bkt[key]||0)+ +b[5];
      });
      const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return {poc,buckets:bkt};
    };

    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    const currentPx = +last1m[0][4];

    out.dataF = {
      vpvr:{"4h":vp(h4),"1d":vp(d1),"1w":vp(w1)},
      price:+currentPx.toFixed(2)
    };

    /* cycle-anchored VWAP (anchor = lowest weekly close in last 52 weeks) */
    const closes = w1.map(r=>+r[4]), lows52=closes.slice(-52);
    const idx = lows52.indexOf(Math.min(...lows52));
    const anchorTs = +w1[w1.length-52+idx][0];
    const daily = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&startTime=${anchorTs}&limit=1000`);
    let num=0, den=0;
    daily.forEach(r=>{ const p=(+r[2]+ +r[3]+ +r[4])/3, v=+r[5]; num+=p*v; den+=v; });
    out.dataF.avwapCycle = +(num/den).toFixed(2);

    /* ── Swing high/low detection ── */
    const oneM = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=120`);
    const highs1m = oneM.map(r=>+r[2]), lows1m = oneM.map(r=>+r[3]), closes1m = oneM.map(r=>+r[4]);
    const swingsArr = [];
    const window = 6;
    for (let i = window; i < oneM.length - window; i++) {
      const segHighs = highs1m.slice(i - window, i + window + 1);
      const segLows  = lows1m.slice(i - window, i + window + 1);
      const currH = highs1m[i], currL = lows1m[i];
      const maxH = Math.max(...segHighs), minL = Math.min(...segLows);
      const ampH = ((currH - minL) / minL) * 100;
      if (currH === maxH && ampH >= 0.15) swingsArr.push({type:'H', idx:i, price:+currH.toFixed(2)});
      const ampL = ((maxH - currL) / maxH) * 100;
      if (currL === minL && ampL >= 0.15) swingsArr.push({type:'L', idx:i, price:+currL.toFixed(2)});
    }
    let H1 = null, H2 = null, L1 = null, L2 = null;
    if (swingsArr.length >= 2) {
      const last2 = swingsArr.slice(-2);
      if (last2[0].type === last2[1].type) {
        if (last2[0].type === 'H') {
          H2 = last2[0].price;
          H1 = last2[1].price;
        } else {
          L2 = last2[0].price;
          L1 = last2[1].price;
        }
      }
    }
    let neckline = null;
    if (H1 !== null) {
      const [{idx: i2}, {idx: i1}] = swingsArr.slice(-2);
      neckline = +Math.min(...lows1m.slice(i2, i1 + 1)).toFixed(2);
    } else if (L1 !== null) {
      const [{idx: i2}, {idx: i1}] = swingsArr.slice(-2);
      neckline = +Math.max(...highs1m.slice(i2, i1 + 1)).toFixed(2);
    }
    const prevC = closes1m[closes1m.length - 2], currC = closes1m[closes1m.length - 1];
    let neckBreak = false;
    if (neckline !== null) {
      if (H1 !== null && prevC > neckline && currC < neckline) neckBreak = true;
      if (L1 !== null && prevC < neckline && currC > neckline) neckBreak = true;
    }
    out.dataF.swings     = { H1, H2, L1, L2 };
    out.dataF.neckline   = neckline;
    out.dataF.neckBreak  = neckBreak;

    /* Levels: Pivot, VWAP band, HH20/LL20 */
    const yesterday = d1.at(-2);
    if (yesterday) {
      const yHigh=+yesterday[2], yLow=+yesterday[3], yClose=+yesterday[4];
      const pivot=(yHigh+yLow+yClose)/3, R1=2*pivot-yLow, S1=2*pivot-yHigh;
      const h1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=20`);
      const HH20=Math.max(...h1.map(b=>+b[2]));
      const LL20=Math.min(...h1.map(b=>+b[3]));
      const midnight=new Date(); midnight.setUTCHours(0,0,0,0);
      const vBars=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${midnight.getTime()}&limit=1440`);
      let vSum=0, pvSum=0, pv2=0;
      vBars.forEach(b=>{
        const vol=+b[5], px=(+b[1]+ +b[2]+ +b[3]+ +b[4])/4;
        vSum+=vol; pvSum+=px*vol; pv2+=px*px*vol;
      });
      const vwap = pvSum/vSum;
      const sigma = Math.sqrt(Math.max(pv2/vSum - vwap*vwap,0));
      out.dataF.levels = {
        pivot:+pivot.toFixed(2), R1:+R1.toFixed(2), S1:+S1.toFixed(2),
        HH20:+HH20.toFixed(2), LL20:+LL20.toFixed(2),
        vwap:+vwap.toFixed(2), vwapUpper:+(vwap+sigma).toFixed(2), vwapLower:+(vwap-sigma).toFixed(2)
      };
    }
  } catch(e){ out.errors.push(`F: ${e.message}`); }

  /* G – Macro (unchanged) */
  try {
    const gv = await safeJson("https://api.coingecko.com/api/v3/global"), g = gv.data;
    out.dataG = {
      totalMcapT:+(g.total_market_cap.usd/1e12).toFixed(2),
      mcap24hPct:+g.market_cap_change_percentage_24h_usd.toFixed(2),
      btcDominance:+g.market_cap_percentage.btc.toFixed(2),
      ethDominance:+g.market_cap_percentage.eth.toFixed(2)
    };
  } catch(e){ out.errors.push(`G: ${e.message}`); }

  /* H – Sentiment (unchanged) */
  try {
    const fg = await safeJson("https://api.alternative.me/fng/?limit=1"), d=fg.data?.[0];
    if(!d) throw new Error("FNG missing");
    out.dataH = { fearGreed:`${d.value} · ${d.value_classification}` };
  } catch(e){ out.errors.push(`H: ${e.message}`); }

  return out;
}

/* ───────── Netlify handler (ES-module) ───────── */
export async function handler() {
  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();
    return {
      statusCode:200,
      headers:{
        "Content-Type":"application/json; charset=utf-8",
        "Cache-Control":"public, max-age=0, must-revalidate"
      },
      body:JSON.stringify(payload)
    };
  } catch(err){
    console.error("Function error:", err);
    return { statusCode:500, body:JSON.stringify({error:"Service unavailable",details:err.message}) };
  }
}
