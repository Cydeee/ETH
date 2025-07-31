// netlify/edge-functions/data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment
// Extra live-only metrics: 4 h ADX-14, absolute OI + 30-day percentile,
// session-relative volume, cycle-anchored VWAP, swing-high/low, neckline,
// neckBreak, Levels
// NOTE: adapted to fetch ETH data instead of BTC.

export const config = { path: ["/data", "/data.json"], cache: "manual" };

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  const wantJson = new URL(request.url).pathname.endsWith("/data.json");

  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();

    const body = wantJson
      ? JSON.stringify(payload)
      : `<!DOCTYPE html><html><body><pre id="dashboard-data">${
          JSON.stringify(payload, null, 2)
        }</pre></body></html>`;

    const headers = wantJson
      ? {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, s-maxage=60, must-revalidate"
        }
      : {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        };

    return new Response(body, { headers });
  } catch (err) {
    console.error("Edge Function error:", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function buildDashboardData () {
  const SYMBOL = "ETHUSDT";          // ← switched to ETH
  const LIMIT  = 250;

  const result = {
    dataA: {}, dataB: null, dataC: {}, dataD: {},
    dataE: null, dataF: null, dataG: null, dataH: null, errors: []
  };

  /* helpers */
  const safeJson = async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const sma = (a,p)=>a.slice(-p).reduce((s,x)=>s+x,0)/p;
  const ema = (a,p)=>{ if(a.length<p) return 0;
    const k=2/(p+1); let e=sma(a.slice(0,p),p);
    for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k);
    return e;
  };
  const rsi =(a,p)=>{ if(a.length<p+1) return 0;
    let up=0,dn=0;
    for(let i=1;i<=p;i++){ const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d; }
    let au=up/p, ad=dn/p;
    for(let i=p+1;i<a.length;i++){
      const d=a[i]-a[i-1];
      au=(au*(p-1)+Math.max(d,0))/p;
      ad=(ad*(p-1)+Math.max(-d,0))/p;
    }
    return ad ? 100-100/(1+au/ad) : 100;
  };
  const atr=(h,l,c,p)=>{ if(h.length<p+1) return 0;
    const tr=[]; for(let i=1;i<h.length;i++)
      tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    return sma(tr,p);
  };
  const roc=(a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

  // Wilder ADX
  const adx = (h,l,c,p=14)=>{
    if(h.length<p+1) return 0;
    const dmPlus=[], dmMinus=[], tr=[];
    for(let i=1;i<h.length;i++){
      const up=h[i]-h[i-1], dn=l[i-1]-l[i];
      dmPlus.push(up>dn && up>0? up:0);
      dmMinus.push(dn>up && dn>0? dn:0);
      tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    }
    const smooth = arr=>{
      const res=[sma(arr.slice(0,p),p)];
      for(let i=p;i<arr.length;i++) res.push(res.at(-1)-(res.at(-1)/p)+arr[i]);
      return res;
    };
    const tr14=smooth(tr), plus14=smooth(dmPlus), minus14=smooth(dmMinus);
    const dx=[];
    for(let i=0;i<plus14.length;i++){
      const plusDI=plus14[i]/(tr14[i]||1)*100,
            minusDI=minus14[i]/(tr14[i]||1)*100,
            d=Math.abs(plusDI-minusDI)/(plusDI+minusDI||1)*100;
      dx.push(d);
    }
    return +(sma(dx.slice(-p),p).toFixed(2));
  };

  /* BLOCK A --------------------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c=kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c.at(-1)||1;
      const macdArr=c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      result.dataA[tf]={
        ema50:+ema(c,50).toFixed(2),
        ema200:+ema(c,200).toFixed(2),
        rsi14:+rsi(c,14).toFixed(1),
        atrPct:+((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist:+(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
      if(tf==="4h") result.dataA[tf].adx14=adx(h,l,c,14);
    }catch(e){ result.errors.push(`A[${tf}]: ${e.message}`);}  
  }

  /* BLOCK B --------------------------------------------------------------- */
  try{
    const fr=await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates=fr.slice(-42).map(d=>+d.fundingRate);
    const m=rates.reduce((s,x)=>s+x,0)/rates.length,
          sd=Math.sqrt(rates.reduce((s,x)=>s+(x-m)**2,0)/rates.length);
    const fundingZ=sd?((rates.at(-1)-m)/sd).toFixed(2):"0.00";

    const oiNow=await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiCurrent=+oiNow.openInterest;

    const oiHist=await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=500`);
    const histArr=oiHist.map(o=>+o.sumOpenInterest);
    const pctRank=+(histArr.filter(v=>v<=oiCurrent).length/histArr.length*100).toFixed(1);
    const base24=histArr.length>25?histArr.at(-25):histArr[0];
    const oiDelta24h=base24?(((oiCurrent-base24)/base24)*100).toFixed(1):null;

    const liqRaw=await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const eth=(liqRaw.data||[]).find(r=>r.symbol==="ETH")||{};   // ← switched to ETH

    result.dataB={
      fundingZ,
      oiDelta24h,
      oiCurrent:+oiCurrent.toFixed(2),
      oi30dPct:pctRank,
      liquidations:{
        long1h:eth.long1h??0, short1h:eth.short1h??0,
        long4h:eth.long4h??0, short4h:eth.short4h??0,
        long24h:eth.long24h??0, short24h:eth.short24h??0
      }
    };
  }catch(e){
    result.errors.push("B: "+e.message);
    result.dataB={fundingZ:null,oiDelta24h:null,oiCurrent:null,oi30dPct:null,liquidations:null};
  }

  /* BLOCK C --------------------------------------------------------------- */
  for(const tf of ["15m","1h","4h","1d"]){
    try{
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c=kl.map(r=>+r[4]);
      result.dataC[tf]={roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2)};
    }catch(e){
      result.errors.push(`C[${tf}]: ${e.message}`);
    }
  }

  /* BLOCK D --------------------------------------------------------------- */
  try{
    const hBars=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=240`);
    const buckets={asia:[],eu:[],us:[]};
    hBars.forEach(b=>{
      const hr=new Date(+b[0]).getUTCHours(), vol=+b[7];
      if(hr<8) buckets.asia.push(vol);
      else if(hr<14) buckets.eu.push(vol);
      else if(hr<22) buckets.us.push(vol);
    });
    const rel=arr=>{
      if(arr.length<21) return 1;
      const mean20=arr.slice(-21,-1).reduce((s,v)=>s+v,0)/20;
      return +(arr.at(-1)/(mean20||1)).toFixed(2);
    };
    result.dataD.sessionRelVol={asia:rel(buckets.asia), eu:rel(buckets.eu), us:rel(buckets.us)};

    const win={"15m":0.25,"1h":1,"4h":4,"24h":24};
    result.dataD.cvd={};
    for(const [lbl,hrs] of Object.entries(win)){
      const end=Date.now(), start=end-hrs*3600000;
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; kl.forEach(k=>+k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]);
      const trd=await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; trd.forEach(t=>{ const q=+t.q; cvd+=t.m? -q:q; });
      result.dataD[lbl]={bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2)};
      result.dataD.cvd[lbl]=+cvd.toFixed(2);
    }
    const tot24=result.dataD["24h"].totalVol;
    const base={"15m":tot24/96,"1h":tot24/24,"4h":tot24/6};
    result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){
      const r=result.dataD[lbl].totalVol/Math.max(base[lbl],1);
      result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  }catch(e){
    result.errors.push("D: "+e.message);
  }  

  /* BLOCK E --------------------------------------------------------------- */
  try{
    const bias=Math.min(3,Math.abs(+result.dataB.fundingZ||0));
    const lev=Math.min(3, result.dataB.oi30dPct ? (result.dataB.oi30dPct-50)/10 : 0);
    const vFlag=result.dataD.relative["15m"], vol=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=result.dataB.liquidations||{}, imb=Math.abs((liq.long24h||0)-(liq.short24h||0)), liqScore=Math.min(2,imb/1e6);
    const stress=bias+lev+vol+liqScore;
    result.dataE={
      stressIndex:+stress.toFixed(2),
      highRisk:stress>=5,
      components:{biasScore:bias, levScore:lev, volScore:vol, liqScore},
      source:"synthetic"
    };
  }catch(e){
    result.errors.push("E: "+e.message);
  }

  /* BLOCK F --------------------------------------------------------------- */
  try{
    // VPVR
    const bars4h = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const bars1d = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=60`);
    const bars1w = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=60`);
    const vp = b => {
      const bkt = {};
      b.forEach(r => {
        const px = (+r[2] + +r[3] + +r[4]) / 3;
        const key = Math.round(px/100)*100;
        bkt[key] = (bkt[key]||0) + +r[5];
      });
      const poc = +Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return { poc, buckets: bkt };
    };
    result.dataF = {
      vpvr: { "4h": vp(bars4h), "1d": vp(bars1d), "1w": vp(bars1w) }
    };

    // Live price
    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    result.dataF.price = +(+last1m[0][4]).toFixed(2);

    // Cycle-anchored VWAP
    const closesW = bars1w.map(r=>+r[4]);
    const lows52 = closesW.slice(-52);
    const idxLow = lows52.indexOf(Math.min(...lows52));
    const anchorTs = +bars1w[bars1w.length-52+idxLow][0];
    const dailyFrom = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&startTime=${anchorTs}&limit=1000`);
    let num=0, den=0;
    dailyFrom.forEach(r=>{
      const p = (+r[2] + +r[3] + +r[4]) / 3;
      const v = +r[5];
      num += p*v;
      den += v;
    });
    result.dataF.avwapCycle = +(num/den).toFixed(2);

    // Swing-high/low detection (last 120×1m bars)
    const oneM = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=120`);
    const highs1m = oneM.map(r=>+r[2]);
    const lows1m  = oneM.map(r=>+r[3]);
    const closes1m= oneM.map(r=>+r[4]);
    const swingsArr = [];
    const W = 6;
    for (let i = W; i < oneM.length - W; i++) {
      const segHigh = Math.max(...highs1m.slice(i-W, i+W+1));
      const segLow  = Math.min(...lows1m.slice(i-W, i+W+1));
      const h = highs1m[i], l = lows1m[i];
      if (h === segHigh && ((h - segLow)/segLow*100) >= 0.15) {
        swingsArr.push({ type: "H", idx: i, price: +h.toFixed(2) });
      }
      if (l === segLow && ((segHigh - l)/segHigh*100) >= 0.15) {
        swingsArr.push({ type: "L", idx: i, price: +l.toFixed(2) });
      }
    }
    let H1=null, H2=null, L1=null, L2=null, neckline=null, neckBreak=false;
    if (swingsArr.length >= 2) {
      const last2 = swingsArr.slice(-2);
      if (last2[0].type === last2[1].type) {
        if (last2[0].type === "H") {
          H2 = last2[0].price; H1 = last2[1].price;
          const [p2,p1] = [last2[0].idx, last2[1].idx];
          neckline = +Math.min(...lows1m.slice(p2, p1+1)).toFixed(2);
          const prevC = closes1m[closes1m.length-2], currC = closes1m.at(-1);
          neckBreak = prevC > neckline && currC < neckline;
        } else {
          L2 = last2[0].price; L1 = last2[1].price;
          const [p2,p1] = [last2[0].idx, last2[1].idx];
          neckline = +Math.max(...highs1m.slice(p2, p1+1)).toFixed(2);
          const prevC = closes1m[closes1m.length-2], currC = closes1m.at(-1);
          neckBreak = prevC < neckline && currC > neckline;
        }
      }
    }
    result.dataF.swings    = { H1, H2, L1, L2 };
    result.dataF.neckline  = neckline;
    result.dataF.neckBreak = neckBreak;

    // Levels: Pivot, VWAP band, HH20/LL20
    const yesterday = bars1d.at(-2);
    if (yesterday) {
      const yH = +yesterday[2], yL = +yesterday[3], yC = +yesterday[4];
      const pivot = (yH + yL + yC) / 3;
      const R1 = 2 * pivot - yL;
      const S1 = 2 * pivot - yH;
      const h1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=20`);
      const HH20 = Math.max(...h1.map(b=>+b[2]));
      const LL20 = Math.min(...h1.map(b=>+b[3]));
      const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
      const vBars = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${midnight.getTime()}&limit=1440`);
      let vSum=0, pvSum=0, pv2=0;
      vBars.forEach(b=>{
        const vol = +b[5];
        const px  = (+b[1]+ +b[2]+ +b[3]+ +b[4]) / 4;
        vSum += vol;
        pvSum += px * vol;
        pv2   += px * px * vol;
      });
      const vwap  = pvSum / vSum;
      const sigma = Math.sqrt(Math.max(pv2/vSum - vwap*vwap, 0));
      result.dataF.levels = {
        pivot:   +pivot.toFixed(2),
        R1:      +R1.toFixed(2),
        S1:      +S1.toFixed(2),
        HH20:    +HH20.toFixed(2),
        LL20:    +LL20.toFixed(2),
        vwap:    +vwap.toFixed(2),
        vwapUpper:+(vwap+sigma).toFixed(2),
        vwapLower:+(vwap-sigma).toFixed(2)
      };
    }
  } catch(e) {
    result.errors.push("F: "+e.message);
  }

  /* BLOCK G --------------------------------------------------------------- */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"), d=gv.data;
    result.dataG={
      totalMcapT:+(d.total_market_cap.usd/1e12).toFixed(2),
      mcap24hPct:+d.market_cap_change_percentage_24h_usd.toFixed(2),
      btcDominance:+d.market_cap_percentage.btc.toFixed(2),
      ethDominance:+d.market_cap_percentage.eth.toFixed(2)
    };
  }catch(e){
    result.errors.push("G: "+e.message);
  }

  /* BLOCK H --------------------------------------------------------------- */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"), row=fg.data?.[0];
    if(!row) throw new Error("FNG missing");
    result.dataH={fearGreed:`${row.value} · ${row.value_classification}`};
  }catch(e){
    result.errors.push("H: "+e.message);
  }

  return result;
}
