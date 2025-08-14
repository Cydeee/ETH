// netlify/edge-functions/edge-data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment
// Structure updates:
// - Swing window: 60d
// - Add "last-two-swings" trendlines (top/bottom) + today's projected prices
// - Keep "envelope" (containment) lines, now 60d as well
// VWAP updates:
// - Session VWAP (UTC day) ±1σ/±1.5σ/±2σ (aliases vwap/vwapUpper/vwapLower = 1σ)
// - Weekly VWAP (UTC week from Monday 00:00) ±1σ/±1.5σ/±2σ
// Other:
// - Clear naming + backward-compat aliases
// - Fix small URL typo in Block C

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

  // ---- Tunables ----------------------------------------------------------
  // Swing structure
  const SWING_LOOKBACK_DAYS   = 60;      // main structure window for trendlines
  const SWING_FRACTAL_N       = 2;       // swing confirmation (fractal n)
  const SWING_MIN_RECENT_BARS = 7;       // ≥1 anchor in last X days for envelopes
  const SWING_TOLERANCE_PCT   = 0.006;   // 0.6% wick tolerance
  const SWING_MAX_VIOLATIONS  = 2;       // allowed pierces for envelopes
  const SLOPE_MIN_USD_PER_DAY = 0.02;    // line slope bounds
  const SLOPE_MAX_USD_PER_DAY = 800;

  // "Last-two-swings" selection guards
  const L2_MIN_GAP_BARS       = 5;       // min bar gap between anchors
  const L2_MIN_DELTA_PCT      = 0.02;    // ≥2% move between anchors
  // -----------------------------------------------------------------------

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
  const sma = (a,p)=> a.slice(Math.max(0, a.length - p)).reduce((s,x)=>s+x,0)/p;
  const ema = (a,p)=> {
    if (a.length < p) return 0;
    const k = 2/(p+1);
    let e = sma(a.slice(0, p), p);
    for (let i=p; i<a.length; i++) e = a[i]*k + e*(1-k);
    return e;
  };
  const rsi =(a,p)=> {
    if (a.length < p+1) return 0;
    let up=0,dn=0;
    for(let i=1;i<=p;i++){ const d=a[i]-a[i-1]; if(d>=0) up+=d; else dn-=d; }
    let au=up/p, ad=dn/p;
    for(let i=p+1;i<a.length;i++){
      const d=a[i]-a[i-1];
      au=(au*(p-1)+Math.max(d,0))/p;
      ad=(ad*(p-1)+Math.max(-d,0))/p;
    }
    return ad ? 100 - 100/(1+au/ad) : 100;
  };
  const atr=(h,l,c,p)=> {
    if (h.length < p+1) return 0;
    const tr=[];
    for(let i=1;i<h.length;i++){
      tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
    }
    return sma(tr,p);
  };
  const roc=(a,n)=> a.length>=n+1 ? ((a[a.length-1]-a[a.length-(n+1)])/a[a.length-(n+1)])*100 : 0;

  const clampNum = v => (Number.isFinite(v) ? v : 0);

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
      const first = sma(arr.slice(0,p),p);
      const res=[first];
      for(let i=p;i<arr.length;i++){
        const prev = res[res.length-1];
        res.push(prev - (prev/p) + arr[i]);
      }
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
    return +sma(dx.slice(Math.max(0, dx.length - p)),p).toFixed(2);
  };

  // --- Kline pagination for full-range VWAPs ---
  const INTERVAL_MS = {
    "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000,
    "30m": 1800000, "1h": 3600000, "4h": 14400000,
    "1d": 86400000, "1w": 604800000
  };
  async function fetchKlinesPaginated(symbol, interval, startTime, endTime){
    const res = [];
    const step = INTERVAL_MS[interval] || 60000;
    let from = startTime;
    for (let guard=0; guard<50 && from < endTime; guard++){
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endTime}&limit=1000`;
      const chunk = await safeJson(url);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      res.push(...chunk);
      const lastOpen = +chunk[chunk.length-1][0];
      const nextFrom = lastOpen + step;
      if (nextFrom <= from) break;
      from = nextFrom;
    }
    return res;
  }

  /* BLOCK A --------------------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c=kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c[c.length-1]||1;
      const macdArr=c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      result.dataA[tf]={
        ema50:+ema(c,50).toFixed(2),
        ema200:+ema(c,200).toFixed(2),
        rsi14:+rsi(c,14).toFixed(1),
        atrPct:+((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist:+(macdArr[macdArr.length-1]-ema(macdArr,9)).toFixed(2)
      };
      if(tf==="4h") result.dataA[tf].adx14=adx(h,l,c,14);
    }catch(e){ result.errors.push(`A[${tf}]: ${e.message}`);}  
  }

  /* BLOCK B --------------------------------------------------------------- */
  try{
    const fr=await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates=fr.slice(Math.max(fr.length-42,0)).map(d=>+d.fundingRate);
    const m=rates.reduce((s,x)=>s+x,0)/Math.max(rates.length,1);
    const sd=Math.sqrt(rates.reduce((s,x)=>s+(x-m)*(x-m),0)/Math.max(rates.length,1));
    const fundingZ=sd?((rates[rates.length-1]-m)/sd).toFixed(2):"0.00";

    const oiNow=await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiCurrent=+oiNow.openInterest;

    const oiHist=await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=500`);
    const histArr=oiHist.map(o=>+o.sumOpenInterest);
    const pctRank=+(histArr.filter(v=>v<=oiCurrent).length/Math.max(histArr.length,1)*100).toFixed(1);
    const base24=histArr.length>25?histArr[histArr.length-25]:histArr[0];
    const oiDelta24h=base24?(((oiCurrent-base24)/base24)*100).toFixed(1):null;

    const liqRaw=await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const arrData = (liqRaw && liqRaw.data) ? liqRaw.data : [];
    const eth=(arrData).find(r=>r.symbol==="ETH")||{};

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
      // fixed stray '}' in limit
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
    for (let i=0;i<hBars.length;i++){
      const b=hBars[i];
      const hr=new Date(+b[0]).getUTCHours(), vol=+b[7];
      if(hr<8) buckets.asia.push(vol);
      else if(hr<14) buckets.eu.push(vol);
      else if(hr<22) buckets.us.push(vol);
    }
    const rel=arr=>{
      if(arr.length<21) return 1;
      const mean20=arr.slice(arr.length-21, arr.length-1).reduce((s,v)=>s+v,0)/20;
      const last = arr[arr.length-1];
      return +(last/(mean20||1)).toFixed(2);
    };
    result.dataD.sessionRelVol={asia:rel(buckets.asia), eu:rel(buckets.eu), us:rel(buckets.us)};

    const win={"15m":0.25,"1h":1,"4h":4,"24h":24};
    result.dataD.cvd={};
    for(const lbl in win){
      const hrs = win[lbl];
      const end=Date.now(), start=end-hrs*3600000;
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1000`);
      let bull=0,bear=0;
      for (let i=0;i<kl.length;i++){
        const k=kl[i];
        if (+k[4] >= +k[1]) bull+=+k[5]; else bear+=+k[5];
      }
      const trd=await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; for (let i=0;i<trd.length;i++){ const t=trd[i]; const q=+t.q; cvd+=t.m? -q:q; }
      result.dataD[lbl]={bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2)};
      result.dataD.cvd[lbl]=+cvd.toFixed(2);
    }
    const tot24=result.dataD["24h"].totalVol||0;
    const base={"15m":tot24/96,"1h":tot24/24,"4h":tot24/6};
    result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){
      const r=(result.dataD[lbl].totalVol||0)/Math.max(base[lbl]||1,1);
      result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  }catch(e){
    result.errors.push("D: "+e.message);
  }  

  /* BLOCK E --------------------------------------------------------------- */
  try{
    const bias=Math.min(3,Math.abs(+((result.dataB&&result.dataB.fundingZ)||0)));
    const lev=Math.min(3, result.dataB&&result.dataB.oi30dPct ? (result.dataB.oi30dPct-50)/10 : 0);
    const vFlag=result.dataD.relative["15m"], vol=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=(result.dataB&&result.dataB.liquidations)||{}, imb=Math.abs((liq.long24h||0)-(liq.short24h||0)), liqScore=Math.min(2,imb/1e6);
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
      for (let i=0;i<b.length;i++){
        const r=b[i];
        const px = (+r[2] + +r[3] + +r[4]) / 3;
        const key = Math.round(px/100)*100;
        bkt[key] = (bkt[key]||0) + +r[5];
      }
      const entries = Object.entries(bkt);
      const poc = entries.length ? +entries.sort((a,b)=>b[1]-a[1])[0][0] : 0;
      return { poc, buckets: bkt };
    };
    result.dataF = {
      vpvr: { "4h": vp(bars4h), "1d": vp(bars1d), "1w": vp(bars1w) }
    };

    // Live price
    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    result.dataF.price = +(+last1m[0][4]).toFixed(2);

    // Levels: Pivot, R1/S1, Highest/Lowest of last 20h, VWAP bands (session + weekly)
    const y = bars1d[bars1d.length-2];
    if (y) {
      const yH = +y[2], yL = +y[3], yC = +y[4];
      const pivot = (yH + yL + yC) / 3;
      const R1 = 2 * pivot - yL;
      const S1 = 2 * pivot - yH;

      // Last 20 x 1h bars for high/low
      const h1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=20`);
      const highestHighLast20h = Math.max(...h1.map(b=>+b[2]));
      const lowestLowLast20h  = Math.min(...h1.map(b=>+b[3]));

      // --- Session VWAP (UTC day) with bands 1σ/1.5σ/2σ
      const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
      const nowTs = Date.now();
      const dayBars = await fetchKlinesPaginated(SYMBOL, "1m", midnight.getTime(), nowTs);
      let vSum=0, pvSum=0, pv2=0;
      for (let i=0;i<dayBars.length;i++){
        const b=dayBars[i];
        const vol = +b[5];
        const px  = (+b[1]+ +b[2]+ +b[3]+ +b[4]) / 4;
        vSum += vol;
        pvSum += px * vol;
        pv2   += px * px * vol;
      }
      const sessionVwap  = vSum ? (pvSum / vSum) : +last1m[0][4];
      const sigmaSess    = Math.sqrt(Math.max(vSum ? (pv2/vSum - sessionVwap*sessionVwap) : 0, 0));
      const sessionVwapBand1Upper   = +(sessionVwap + sigmaSess).toFixed(2);
      const sessionVwapBand1Lower   = +(sessionVwap - sigmaSess).toFixed(2);
      const sessionVwapBand1_5Upper = +(sessionVwap + 1.5*sigmaSess).toFixed(2);
      const sessionVwapBand1_5Lower = +(sessionVwap - 1.5*sigmaSess).toFixed(2);
      const sessionVwapBand2Upper   = +(sessionVwap + 2*sigmaSess).toFixed(2);
      const sessionVwapBand2Lower   = +(sessionVwap - 2*sigmaSess).toFixed(2);

      // --- Weekly VWAP (UTC week start Monday 00:00) with bands 1σ/1.5σ/2σ
      const weekStart = new Date(); weekStart.setUTCHours(0,0,0,0);
      const dow = weekStart.getUTCDay();           // 0..6 (Sun..Sat)
      const daysFromMon = (dow + 6) % 7;           // Mon=0
      weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon);
      const weekBars = await fetchKlinesPaginated(SYMBOL, "15m", weekStart.getTime(), nowTs);
      let vSumW=0, pvSumW=0, pv2W=0;
      for (let i=0;i<weekBars.length;i++){
        const b=weekBars[i];
        const vol = +b[5];
        const px  = (+b[1]+ +b[2]+ +b[3]+ +b[4]) / 4;
        vSumW += vol;
        pvSumW += px * vol;
        pv2W   += px * px * vol;
      }
      const weeklyVwap  = vSumW ? (pvSumW / vSumW) : +last1m[0][4];
      const sigmaWeek   = Math.sqrt(Math.max(vSumW ? (pv2W/vSumW - weeklyVwap*weeklyVwap) : 0, 0));
      const weeklyVwapBand1Upper   = +(weeklyVwap + sigmaWeek).toFixed(2);
      const weeklyVwapBand1Lower   = +(weeklyVwap - sigmaWeek).toFixed(2);
      const weeklyVwapBand1_5Upper = +(weeklyVwap + 1.5*sigmaWeek).toFixed(2);
      const weeklyVwapBand1_5Lower = +(weeklyVwap - 1.5*sigmaWeek).toFixed(2);
      const weeklyVwapBand2Upper   = +(weeklyVwap + 2*sigmaWeek).toFixed(2);
      const weeklyVwapBand2Lower   = +(weeklyVwap - 2*sigmaWeek).toFixed(2);

      // Rolling highs/lows from daily bars (unchanged: 7d/30d)
      const highs1d = bars1d.map(r=>+r[2]);
      const lows1d  = bars1d.map(r=>+r[3]);
      const closes1d= bars1d.map(r=>+r[4]);
      const opens1d = bars1d.map(r=>+r[1]);
      const times1d = bars1d.map(r=>+r[0]); // timestamps (ms)
      const len = highs1d.length;
      const sliceN = (arr,n)=> arr.length>=n ? arr.slice(arr.length-n) : arr.slice(0);

      const rolling7dHigh  = Math.max(...sliceN(highs1d,7));
      const rolling7dLow   = Math.min(...sliceN(lows1d,7));
      const rolling30dHigh = Math.max(...sliceN(highs1d,30));
      const rolling30dLow  = Math.min(...sliceN(lows1d,30));

      // Confirmed swings (fractal n)
      const n=SWING_FRACTAL_N, windowStart = Math.max(0, len - SWING_LOOKBACK_DAYS), endIdx = len - 1;
      const swingHighs=[], swingLows=[];
      for (let i=n; i<len-n; i++){
        const segHigh = Math.max(...highs1d.slice(i-n, i+n+1));
        const segLow  = Math.min(...lows1d.slice(i-n, i+n+1));
        if (highs1d[i] === segHigh) swingHighs.push({ idx:i, price:highs1d[i], ts: times1d[i] });
        if (lows1d[i]  === segLow ) swingLows.push({ idx:i, price:lows1d[i],  ts: times1d[i] });
      }
      const swingHighsW = swingHighs.filter(s=>s.idx>=windowStart);
      const swingLowsW  = swingLows.filter(s=>s.idx>=windowStart);

      // Horizontal swing levels (most recent confirmed within 60d)
      const lastConfirmedSwingHigh60d = swingHighsW.length ? swingHighsW[swingHighsW.length-1].price : null;
      const lastConfirmedSwingLow60d  = swingLowsW.length  ? swingLowsW[swingLowsW.length-1].price  : null;

      // ---- Envelope builder (containment) across 60d
      const tolerance = SWING_TOLERANCE_PCT;
      const minRecent = len - SWING_MIN_RECENT_BARS;
      const SLOPE_MIN = SLOPE_MIN_USD_PER_DAY;
      const SLOPE_MAX = SLOPE_MAX_USD_PER_DAY;
      const MAX_VIOLS = SWING_MAX_VIOLATIONS;

      const pickEnvelopeLine = (pivots, side /* "high"|"low" */) => {
        if (!pivots || pivots.length < 2) return null;
        let best = null;

        for (let a=0; a<pivots.length-1; a++){
          for (let b=a+1; b<pivots.length; b++){
            const A = pivots[a], B = pivots[b];
            if (A.idx < windowStart || B.idx < windowStart) continue;
            if (A.idx < minRecent && B.idx < minRecent) continue;

            const slope = (B.price - A.price) / (B.idx - A.idx);
            const absSlope = Math.abs(slope);
            if (absSlope < SLOPE_MIN || absSlope > SLOPE_MAX) continue;

            const intercept = A.price - slope * A.idx;

            let violations = 0;
            for (let k = windowStart; k <= endIdx; k++){
              const linePrice = slope * k + intercept || 0;
              if (side === "high") {
                if (highs1d[k] > linePrice * (1 + tolerance)) {
                  violations++;
                  if (violations > MAX_VIOLS) break;
                }
              } else {
                if (lows1d[k] < linePrice * (1 - tolerance)) {
                  violations++;
                  if (violations > MAX_VIOLS) break;
                }
              }
            }
            if (violations > MAX_VIOLS) continue;

            const projToday = slope * endIdx + intercept;
            if (!best) {
              best = { slope, intercept, score: projToday };
            } else if (side === "high" ? (projToday < best.score) : (projToday > best.score)) {
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

      // ---- Last-two-swings trendline (what you'd draw by hand)
      const pickLastTwoTrendline = (pivots, side /* "high"|"low" */) => {
        if (!pivots || pivots.length < 2) return null;
        // pick the last pivot as B, then find previous A satisfying gaps
        const B = pivots[pivots.length - 1];
        let A = null;
        for (let i = pivots.length - 2; i >= 0; i--) {
          const cand = pivots[i];
          const gap = B.idx - cand.idx;
          const deltaPct = Math.abs(B.price - cand.price) / Math.max(cand.price, 1);
          if (gap >= L2_MIN_GAP_BARS && deltaPct >= L2_MIN_DELTA_PCT) {
            A = cand;
            break;
          }
        }
        if (!A) A = pivots[pivots.length - 2];
        if (!A || A.idx === B.idx) return null;

        const slope = (B.price - A.price) / (B.idx - A.idx);
        const intercept = A.price - slope * A.idx;
        return {
          slope: +slope.toFixed(6),
          intercept: +intercept.toFixed(2),
          anchorIdxA: A.idx, anchorIdxB: B.idx,
          anchorTsA: A.ts || times1d[A.idx], anchorTsB: B.ts || times1d[B.idx],
          anchorPriceA: +A.price.toFixed(2), anchorPriceB: +B.price.toFixed(2)
        };
      };

      let dominantUpperSwingEnvelope60d = pickEnvelopeLine(swingHighsW, "high");
      let dominantLowerSwingEnvelope60d = pickEnvelopeLine(swingLowsW,  "low");

      const lastTwoSwingHighTrendline60d = pickLastTwoTrendline(swingHighsW, "high");
      const lastTwoSwingLowTrendline60d  = pickLastTwoTrendline(swingLowsW,  "low");

      // Today's projected prices
      const projPrice = (line)=> line ? +(clampNum(line.slope * (len-1) + line.intercept).toFixed(2)) : null;

      const upperResistancePriceToday60d_envelope = projPrice(dominantUpperSwingEnvelope60d);
      const lowerSupportPriceToday60d_envelope    = projPrice(dominantLowerSwingEnvelope60d);

      const upperResistancePriceToday60d_lastTwo = projPrice(lastTwoSwingHighTrendline60d);
      const lowerSupportPriceToday60d_lastTwo    = projPrice(lastTwoSwingLowTrendline60d);

      // EMAs (4h and 1d) with explicit names (and keep old aliases)
      const closes4h = bars4h.map(r=>+r[4]);
      const ema4hPeriod20  = ema(closes4h,20)  || 0;
      const ema4hPeriod50  = ema(closes4h,50)  || 0;
      const ema4hPeriod200 = ema(closes4h,200) || 0;

      const ema1dPeriod20  = ema(closes1d,20)  || 0;
      const ema1dPeriod50  = ema(closes1d,50)  || 0;
      const ema1dPeriod200 = ema(closes1d,200) || 0;

      // Final levels object (self-explanatory + backward-compat aliases)
      const levels = {
        // Pivots (daily)
        dailyPivot:  +pivot.toFixed(2),
        dailyR1:     +R1.toFixed(2),
        dailyS1:     +S1.toFixed(2),

        // High/Low last 20 hours (and aliases)
        highestHighLast20h: +highestHighLast20h.toFixed(2),
        lowestLowLast20h:   +lowestLowLast20h.toFixed(2),
        HH20: +highestHighLast20h.toFixed(2), // alias
        LL20: +lowestLowLast20h.toFixed(2),   // alias

        // Session VWAP (UTC day) ± bands
        sessionVwap: +sessionVwap.toFixed(2),
        sessionVwapBand1Upper:   sessionVwapBand1Upper,
        sessionVwapBand1Lower:   sessionVwapBand1Lower,
        sessionVwapBand1_5Upper: sessionVwapBand1_5Upper,
        sessionVwapBand1_5Lower: sessionVwapBand1_5Lower,
        sessionVwapBand2Upper:   sessionVwapBand2Upper,
        sessionVwapBand2Lower:   sessionVwapBand2Lower,

        // Legacy aliases (map to 1σ)
        vwap:       +sessionVwap.toFixed(2),
        vwapUpper:  sessionVwapBand1Upper,
        vwapLower:  sessionVwapBand1Lower,

        // Weekly VWAP (UTC week start Monday 00:00) ± bands
        weeklyVwap: +weeklyVwap.toFixed(2),
        weeklyVwapBand1Upper:   weeklyVwapBand1Upper,
        weeklyVwapBand1Lower:   weeklyVwapBand1Lower,
        weeklyVwapBand1_5Upper: weeklyVwapBand1_5Upper,
        weeklyVwapBand1_5Lower: weeklyVwapBand1_5Lower,
        weeklyVwapBand2Upper:   weeklyVwapBand2Upper,
        weeklyVwapBand2Lower:   weeklyVwapBand2Lower,

        // Rolling highs/lows (7d/30d)
        rolling7dHigh:  +rolling7dHigh.toFixed(2),
        rolling7dLow:   +rolling7dLow.toFixed(2),
        rolling30dHigh: +rolling30dHigh.toFixed(2),
        rolling30dLow:  +rolling30dLow.toFixed(2),

        // Horizontal swings (60d window)
        lastConfirmedSwingHigh60d: lastConfirmedSwingHigh60d != null ? +lastConfirmedSwingHigh60d.toFixed(2) : null,
        lastConfirmedSwingLow60d:  lastConfirmedSwingLow60d  != null ? +lastConfirmedSwingLow60d.toFixed(2)  : null,

        // Envelope lines across 60d (containment) + today's projected prices
        dominantUpperSwingEnvelope60d: dominantUpperSwingEnvelope60d || null,
        dominantLowerSwingEnvelope60d: dominantLowerSwingEnvelope60d || null,
        upperResistancePriceToday60d_envelope: upperResistancePriceToday60d_envelope,
        lowerSupportPriceToday60d_envelope:    lowerSupportPriceToday60d_envelope,

        // Last-two-swings trendlines (what you'd draw by hand) + today's prices
        lastTwoSwingHighTrendline60d: lastTwoSwingHighTrendline60d || null,
        lastTwoSwingLowTrendline60d:  lastTwoSwingLowTrendline60d  || null,
        upperResistancePriceToday60d_lastTwo: upperResistancePriceToday60d_lastTwo,
        lowerSupportPriceToday60d_lastTwo:    lowerSupportPriceToday60d_lastTwo,

        // Back-compat aliases (from earlier versions, 30d → 60d naming kept for compatibility)
        rolling30dSwingHighLine: dominantUpperSwingEnvelope60d || null,
        rolling30dSwingLowLine:  dominantLowerSwingEnvelope60d || null,

        // EMAs with explicit names (+ aliases)
        ema4hPeriod20:  ema4hPeriod20 ? +ema4hPeriod20.toFixed(2) : null,
        ema4hPeriod50:  ema4hPeriod50 ? +ema4hPeriod50.toFixed(2) : null,
        ema4hPeriod200: ema4hPeriod200 ? +ema4hPeriod200.toFixed(2) : null,
        ema1dPeriod20:  ema1dPeriod20 ? +ema1dPeriod20.toFixed(2) : null,
        ema1dPeriod50:  ema1dPeriod50 ? +ema1dPeriod50.toFixed(2) : null,
        ema1dPeriod200: ema1dPeriod200 ? +ema1dPeriod200.toFixed(2) : null,
        // aliases:
        ema4h20:  ema4hPeriod20 ? +ema4hPeriod20.toFixed(2) : null,
        ema4h50:  ema4hPeriod50 ? +ema4hPeriod50.toFixed(2) : null,
        ema4h200: ema4hPeriod200 ? +ema4hPeriod200.toFixed(2) : null,
        ema1d20:  ema1dPeriod20 ? +ema1dPeriod20.toFixed(2) : null,
        ema1d50:  ema1dPeriod50 ? +ema1dPeriod50.toFixed(2) : null,
        ema1d200: ema1dPeriod200 ? +ema1dPeriod200.toFixed(2) : null
      };

      result.dataF.levels = levels;
    }
  } catch(e) {
    result.errors.push("F: "+e.message);
  }

  /* BLOCK G --------------------------------------------------------------- */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global");
    const d=(gv&&gv.data)?gv.data:{ total_market_cap:{usd:0}, market_cap_change_percentage_24h_usd:0, market_cap_percentage:{btc:0,eth:0} };
    result.dataG={
      totalMcapT:+((d.total_market_cap.usd||0)/1e12).toFixed(2),
      mcap24hPct:+(d.market_cap_change_percentage_24h_usd||0).toFixed(2),
      btcDominance:+(d.market_cap_percentage.btc||0).toFixed(2),
      ethDominance:+(d.market_cap_percentage.eth||0).toFixed(2)
    };
  }catch(e){
    result.errors.push("G: "+e.message);
  }

  /* BLOCK H --------------------------------------------------------------- */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1");
    const row=(fg && fg.data && fg.data[0]) ? fg.data[0] : null;
    if(!row) throw new Error("FNG missing");
    result.dataH={fearGreed:`${row.value} · ${row.value_classification}`};
  }catch(e){
    result.errors.push("H: "+e.message);
  }

  return result;
}
