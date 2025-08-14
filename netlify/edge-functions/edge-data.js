// netlify/edge-functions/data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment
// Updates:
// - Keep: price, VPVR, pivots + HH20/LL20 + VWAP bands
// - Add (F.levels): rolling7dHigh/Low, rolling30dHigh/Low,
//                   rolling30dSwingHigh/Low (horizontal),
//                   rolling30dSwingHighLine/LowLine (sloping, with filters),
//                   ema4h20/50/200, ema1d20/50/200
// - Remove: avwapCycle, swings (H1/H2/L1/L2), neckline, neckBreak

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
  const SYMBOL = "ETHUSDT";
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
    const eth=(liqRaw.data||[]).find(r=>r.symbol==="ETH")||{};

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
    // Fetch bars for structure/levels
    const bars4h = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=200`);
    const bars1d = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=220`);
    const bars1w = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=60`);

    // VPVR (unchanged)
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

    // Levels: Pivot, R1/S1, HH20/LL20, Session VWAP ±σ
    const y = bars1d.at(-2);
    if (y) {
      const yH = +y[2], yL = +y[3], yC = +y[4];
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
      const vwap  = vSum ? (pvSum / vSum) : +last1m[0][4];
      const sigma = Math.sqrt(Math.max(vSum ? (pv2/vSum - vwap*vwap) : 0, 0));

      // Rolling highs/lows from daily bars
      const highs1d = bars1d.map(r=>+r[2]);
      const lows1d  = bars1d.map(r=>+r[3]);
      const closes1d= bars1d.map(r=>+r[4]);
      const len = highs1d.length;
      const sliceN = (arr,n)=>arr.length>=n?arr.slice(-n):arr.slice(0);

      const rolling7dHigh  = Math.max(...sliceN(highs1d,7));
      const rolling7dLow   = Math.min(...sliceN(lows1d,7));
      const rolling30dHigh = Math.max(...sliceN(highs1d,30));
      const rolling30dLow  = Math.min(...sliceN(lows1d,30));

      // Confirmed swings (fractal n=2)
      const n=2, startIdx = Math.max(0, len-30), endIdx = len-1;
      const swingHighs=[], swingLows=[];
      for (let i=n; i<len-n; i++){
        if (highs1d[i] === Math.max(...highs1d.slice(i-n, i+n+1)))
          swingHighs.push({ idx:i, price:highs1d[i] });
        if (lows1d[i] === Math.min(...lows1d.slice(i-n, i+n+1)))
          swingLows.push({ idx:i, price:lows1d[i] });
      }
      const swingHighs30 = swingHighs.filter(s=>s.idx>=startIdx);
      const swingLows30  = swingLows.filter(s=>s.idx>=startIdx);

      // Horizontal swing levels (most recent confirmed inside 30d)
      const rolling30dSwingHigh = swingHighs30.length ? swingHighs30.at(-1).price : null;
      const rolling30dSwingLow  = swingLows30.length  ? swingLows30.at(-1).price  : null;

      // Sloping swing lines (Option B: dominant diagonal inside 30d with filters)
      const tolerance = 0.002;        // 0.2% proximity
      const minRecentBars = 10;       // at least one anchor in last 10 days
      const SLOPE_MIN = 0.05;         // USD/day (near-horizontal filter)
      const SLOPE_MAX = 500;          // USD/day (absurdly steep filter)

      const pickBestLine = (pivots, side /* "high"|"low" */) => {
        if (!pivots || pivots.length < 2) return null;
        const recentCut = len - minRecentBars;
        let best = null;

        for (let a=0; a<pivots.length-1; a++){
          for (let b=a+1; b<pivots.length; b++){
            const A = pivots[a], B = pivots[b];
            if (A.idx < startIdx || B.idx < startIdx) continue; // ensure inside 30d window
            // Recency filter: at least one anchor in last X days
            if (A.idx < recentCut && B.idx < recentCut) continue;

            const slope = (B.price - A.price) / (B.idx - A.idx);
            const absSlope = Math.abs(slope);
            if (absSlope < SLOPE_MIN || absSlope > SLOPE_MAX) continue;

            const intercept = A.price - slope * A.idx;

            // Touch count within tolerance across window
            let touches = 0;
            for (let k = startIdx; k <= endIdx; k++){
              const linePrice = slope * k + intercept;
              if (side === "high") {
                if (Math.abs(highs1d[k] - linePrice) / (linePrice || 1) <= tolerance) touches++;
              } else {
                if (Math.abs(lows1d[k] - linePrice) / (linePrice || 1) <= tolerance) touches++;
              }
            }
            if (touches < 2) continue;

            // Selection criterion: for highs, maximize today's projected level; for lows, minimize it
            const todayIdx = endIdx;
            const projToday = slope * todayIdx + intercept;

            if (!best) {
              best = { slope, intercept, score: projToday };
            } else if (side === "high" ? (projToday > best.score) : (projToday < best.score)) {
              best = { slope, intercept, score: projToday };
            }
          }
        }
        if (!best) return null;
        return {
          slope: +best.slope.toFixed(6),
          intercept: +best.intercept.toFixed(2)
        };
      };

      const rolling30dSwingHighLine = pickBestLine(swingHighs30, "high");
      const rolling30dSwingLowLine  = pickBestLine(swingLows30,  "low");

      // EMAs (4h and 1d)
      const closes4h = bars4
