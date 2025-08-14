// netlify/edge-functions/edge-data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment
// This version fixes Block F scoping/order (no undefineds), and:
// - Support = line through ZigZag pivot LOWS (anchors are daily LOW values)
// - Resistance = line through ZigZag pivot HIGHS (anchors are daily HIGH values)
// - Containment checks apply to pivot points only (not every bar)
// - Session & Weekly VWAP (1/1.5/2σ bands)
// - No duplicate output fields (clean names)

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
  const SWING_LOOKBACK_DAYS   = 60;   // last ~60 daily bars (UTC)
  const MIN_GAP_BARS          = 14;   // min gap between anchors
  const SWING_ZZ_PCT          = 0.06; // 6% ZigZag reversal threshold
  const CONTAIN_TOL_PCT       = 0.008;// 0.8% tolerance at pivots
  const CONTAIN_MAX_VIOLS     = 2;    // allow ≤2 pivot breaches
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

  const fmtDDMM = ts => {
    const d = new Date(ts);
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    return `${dd}/${mm}`;
  };

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

  // --- Kline pagination (for session/weekly VWAPs) ---
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

  // --- ZigZag on daily CLOSES; classify pivots; then anchor with H/L -----
  function zigzagPivotsOnCloses(closes, pct) {
    const piv = [];
    if (!closes || closes.length === 0) return piv;
    const thr = Math.max(pct, 0.0001);
    let lastExtremeIdx = 0;
    let lastExtreme = closes[0];
    let dir = 0; // 0 unk, +1 up leg, -1 down leg

    for (let i = 1; i < closes.length; i++) {
      const p = closes[i];
      if (dir >= 0) {
        if (p >= lastExtreme) { lastExtreme = p; lastExtremeIdx = i; }
        const retrace = (lastExtreme - p) / Math.max(lastExtreme, 1);
        if (retrace >= thr) { // top confirmed
          piv.push({ idx: lastExtremeIdx, close: closes[lastExtremeIdx] });
          dir = -1; lastExtreme = p; lastExtremeIdx = i;
        }
      }
      if (dir <= 0) {
        if (p <= lastExtreme) { lastExtreme = p; lastExtremeIdx = i; }
        const retrace = (p - lastExtreme) / Math.max(lastExtreme, 1);
        if (retrace >= thr) { // bottom confirmed
          piv.push({ idx: lastExtremeIdx, close: closes[lastExtremeIdx] });
          dir = +1; lastExtreme = p; lastExtremeIdx = i;
        }
      }
    }
    piv.push({ idx: lastExtremeIdx, close: closes[lastExtremeIdx] });

    const out = [];
    for (let k = 0; k < piv.length; k++) {
      if (k === 0 || piv[k].idx !== piv[k-1].idx) out.push(piv[k]);
    }
    return out;
  }

  function classifyPivots(pivots) {
    const highs = [], lows = [];
    for (let i = 0; i < pivots.length; i++) {
      const curr = pivots[i];
      const prev = pivots[i-1];
      const next = pivots[i+1];
      if (prev && next) {
        if (curr.close >= prev.close && curr.close >= next.close) highs.push(curr);
        else if (curr.close <= prev.close && curr.close <= next.close) lows.push(curr);
      } else if (!prev && next) {
        if (curr.close >= next.close) highs.push(curr); else lows.push(curr);
      } else if (!next && prev) {
        if (curr.close >= prev.close) highs.push(curr); else lows.push(curr);
      }
    }
    return { highs, lows };
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

    // VPVR
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

    // ---------- Build daily arrays first (used everywhere) ----------
    const highs1d = bars1d.map(r=>+r[2]);
    const lows1d  = bars1d.map(r=>+r[3]);
    const closes1d= bars1d.map(r=>+r[4]);
    const times1d = bars1d.map(r=>+r[0]);
    const len = highs1d.length;
    const endIdx = len - 1;

    // Rolling highs/lows (use daily series, independent of "yesterday")
    const sliceN = (arr,n)=> arr.length>=n ? arr.slice(arr.length-n) : arr.slice(0);
    const rolling7dHigh  = len ? Math.max(...sliceN(highs1d,7))  : null;
    const rolling7dLow   = len ? Math.min(...sliceN(lows1d,7))   : null;
    const rolling30dHigh = len ? Math.max(...sliceN(highs1d,30)) : null;
    const rolling30dLow  = len ? Math.min(...sliceN(lows1d,30))  : null;

    // ---------- Pivots & primary lines (containment on pivots only) ----------
    const pivClosesAll = zigzagPivotsOnCloses(closes1d, SWING_ZZ_PCT);
    const { highs: pivHighsAll, lows: pivLowsAll } = classifyPivots(pivClosesAll);
    const windowStart = Math.max(0, len - SWING_LOOKBACK_DAYS);
    const pivHighs = pivHighsAll.filter(p => p.idx >= windowStart);
    const pivLows  = pivLowsAll.filter(p => p.idx >= windowStart);

    function pickPrimarySupport(pivotLows, lowsSeries) {
      if (!pivotLows || pivotLows.length < 2) return null;
      let best = null; // choose by MAX slope
      for (let a=0; a<pivotLows.length-1; a++){
        for (let b=a+1; b<pivotLows.length; b++){
          const A = pivotLows[a], B = pivotLows[b];
          if ((B.idx - A.idx) < MIN_GAP_BARS) continue;

          const Ay = lowsSeries[A.idx], By = lowsSeries[B.idx];
          const slope = (By - Ay) / (B.idx - A.idx);
          const intercept = Ay - slope * A.idx;

          // Containment on pivot LOWS only (from A forward)
          let viol = 0;
          for (const P of pivotLows) {
            if (P.idx < A.idx) continue;
            const lineAtP = slope * P.idx + intercept;
            const Py = lowsSeries[P.idx];
            if (Py < lineAtP * (1 - CONTAIN_TOL_PCT)) { viol++; if (viol > CONTAIN_MAX_VIOLS) break; }
          }
          if (viol > CONTAIN_MAX_VIOLS) continue;

          if (!best || slope > best.slope) best = { slope, intercept, Aidx: A.idx, Bidx: B.idx };
        }
      }
      if (!best) return null;
      return {
        A: { idx: best.Aidx, ts: times1d[best.Aidx], price: +lowsSeries[best.Aidx].toFixed(2) },
        B: { idx: best.Bidx, ts: times1d[best.Bidx], price: +lowsSeries[best.Bidx].toFixed(2) },
        today: +((best.slope * endIdx + best.intercept).toFixed(2))
      };
    }

    function pickPrimaryResistance(pivotHighs, highsSeries) {
      if (!pivotHighs || pivotHighs.length < 2) return null;
      let best = null; // choose by MOST NEGATIVE slope
      for (let a=0; a<pivotHighs.length-1; a++){
        for (let b=a+1; b<pivotHighs.length; b++){
          const A = pivotHighs[a], B = pivotHighs[b];
          if ((B.idx - A.idx) < MIN_GAP_BARS) continue;

          const Ay = highsSeries[A.idx], By = highsSeries[B.idx];
          const slope = (By - Ay) / (B.idx - A.idx);
          const intercept = Ay - slope * A.idx;

          // Containment on pivot HIGHS only (from A forward)
          let viol = 0;
          for (const P of pivotHighs) {
            if (P.idx < A.idx) continue;
            const lineAtP = slope * P.idx + intercept;
            const Py = highsSeries[P.idx];
            if (Py > lineAtP * (1 + CONTAIN_TOL_PCT)) { viol++; if (viol > CONTAIN_MAX_VIOLS) break; }
          }
          if (viol > CONTAIN_MAX_VIOLS) continue;

          if (!best || slope < best.slope) best = { slope, intercept, Aidx: A.idx, Bidx: B.idx };
        }
      }
      if (!best) return null;
      return {
        A: { idx: best.Aidx, ts: times1d[best.Aidx], price: +highsSeries[best.Aidx].toFixed(2) },
        B: { idx: best.Bidx, ts: times1d[best.Bidx], price: +highsSeries[best.Bidx].toFixed(2) },
        today: +((best.slope * endIdx + best.intercept).toFixed(2))
      };
    }

    const primarySupport     = pickPrimarySupport(pivLows,  lows1d);
    const primaryResistance  = pickPrimaryResistance(pivHighs, highs1d);

    // ---------- Daily pivot & last 20h extremes ----------
    let dailyPivot=null, dailyR1=null, dailyS1=null, highestHighLast20h=null, lowestLowLast20h=null;
    const y = bars1d.length >= 2 ? bars1d[bars1d.length-2] : null; // last completed UTC daily
    if (y) {
      const yH = +y[2], yL = +y[3], yC = +y[4];
      const pivot = (yH + yL + yC) / 3;
      dailyPivot = +pivot.toFixed(2);
      dailyR1 = +(2 * pivot - yL).toFixed(2);
      dailyS1 = +(2 * pivot - yH).toFixed(2);

      const h1 = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=20`);
      highestHighLast20h = +Math.max(...h1.map(b=>+b[2])).toFixed(2);
      lowestLowLast20h   = +Math.min(...h1.map(b=>+b[3])).toFixed(2);
    }

    // ---------- Session VWAP (UTC) ----------
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
    const nowTs = Date.now();
    const dayBars = await fetchKlinesPaginated(SYMBOL, "1m", midnight.getTime(), nowTs);
    let vSum=0, pvSum=0, pv2=0;
    for (let i=0;i<dayBars.length;i++){
      const b=dayBars[i];
      const vol = +b[5];
      const px  = (+b[1]+ +b[2]+ +b[3]+ +b[4]) / 4;
      vSum += vol; pvSum += px * vol; pv2 += px * px * vol;
    }
    const sessionVwap = +( (vSum ? pvSum / vSum : (result.dataF.price||0)) ).toFixed(2);
    const sigmaSess   = Math.sqrt(Math.max(vSum ? (pv2/vSum - (pvSum/vSum)*(pvSum/vSum)) : 0, 0));
    const sessionVwapBand1Upper   = +(sessionVwap + sigmaSess).toFixed(2);
    const sessionVwapBand1Lower   = +(sessionVwap - sigmaSess).toFixed(2);
    const sessionVwapBand1_5Upper = +(sessionVwap + 1.5*sigmaSess).toFixed(2);
    const sessionVwapBand1_5Lower = +(sessionVwap - 1.5*sigmaSess).toFixed(2);
    const sessionVwapBand2Upper   = +(sessionVwap + 2*sigmaSess).toFixed(2);
    const sessionVwapBand2Lower   = +(sessionVwap - 2*sigmaSess).toFixed(2);

    // ---------- Weekly VWAP (UTC, Mon 00:00 start) ----------
    const weekStart = new Date(); weekStart.setUTCHours(0,0,0,0);
    const dow = weekStart.getUTCDay(); const daysFromMon = (dow + 6) % 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon);
    const weekBars = await fetchKlinesPaginated(SYMBOL, "15m", weekStart.getTime(), nowTs);
    let vSumW=0, pvSumW=0, pv2W=0;
    for (let i=0;i<weekBars.length;i++){
      const b=weekBars[i];
      const vol = +b[5];
      const px  = (+b[1]+ +b[2]+ +b[3]+ +b[4]) / 4;
      vSumW += vol; pvSumW += px * vol; pv2W += px * px * vol;
    }
    const weeklyVwap = +( (vSumW ? pvSumW / vSumW : (result.dataF.price||0)) ).toFixed(2);
    const sigmaWeek  = Math.sqrt(Math.max(vSumW ? (pv2W/vSumW - (pvSumW/vSumW)*(pvSumW/vSumW)) : 0, 0));
    const weeklyVwapBand1Upper   = +(weeklyVwap + sigmaWeek).toFixed(2);
    const weeklyVwapBand1Lower   = +(weeklyVwap - sigmaWeek).toFixed(2);
    const weeklyVwapBand1_5Upper = +(weeklyVwap + 1.5*sigmaWeek).toFixed(2);
    const weeklyVwapBand1_5Lower = +(weeklyVwap - 1.5*sigmaWeek).toFixed(2);
    const weeklyVwapBand2Upper   = +(weeklyVwap + 2*sigmaWeek).toFixed(2);
    const weeklyVwapBand2Lower   = +(weeklyVwap - 2*sigmaWeek).toFixed(2);

    // ---------- EMAs (4h and 1d) ----------
    const closes4h = bars4h.map(r=>+r[4]);
    const ema4hPeriod20  = +ema(closes4h,20).toFixed(2);
    const ema4hPeriod50  = +ema(closes4h,50).toFixed(2);
    const ema4hPeriod200 = +ema(closes4h,200).toFixed(2);
    const ema1dPeriod20  = +ema(closes1d,20).toFixed(2);
    const ema1dPeriod50  = +ema(closes1d,50).toFixed(2);
    const ema1dPeriod200 = +ema(closes1d,200).toFixed(2);

    // ---------- Assemble clean Levels ----------
    result.dataF.levels = {
      // Daily pivot set (requires yesterday)
      dailyPivot,
      dailyR1,
      dailyS1,

      // Last 20 hourly bars extremes
      highestHighLast20h,
      lowestLowLast20h,

      // Session VWAP (UTC) + bands
      sessionVwap,
      sessionVwapBand1Upper,
      sessionVwapBand1Lower,
      sessionVwapBand1_5Upper,
      sessionVwapBand1_5Lower,
      sessionVwapBand2Upper,
      sessionVwapBand2Lower,

      // Weekly VWAP (UTC) + bands
      weeklyVwap,
      weeklyVwapBand1Upper,
      weeklyVwapBand1Lower,
      weeklyVwapBand1_5Upper,
      weeklyVwapBand1_5Lower,
      weeklyVwapBand2Upper,
      weeklyVwapBand2Lower,

      // Rolling highs/lows (daily bars)
      rolling7dHigh,
      rolling7dLow,
      rolling30dHigh,
      rolling30dLow,

      // Primary structure lines — anchors only (dates dd/mm + prices)
      primarySupportLine60d: primarySupport ? {
        low1Date: fmtDDMM(primarySupport.A.ts), low1Price: primarySupport.A.price,
        low2Date: fmtDDMM(primarySupport.B.ts), low2Price: primarySupport.B.price
      } : null,
      primaryResistanceLine60d: primaryResistance ? {
        high1Date: fmtDDMM(primaryResistance.A.ts), high1Price: primaryResistance.A.price,
        high2Date: fmtDDMM(primaryResistance.B.ts), high2Price: primaryResistance.B.price
      } : null,

      // Projected prices today from those lines (for plotting/labels)
      primarySupportToday60d:    primarySupport ? primarySupport.today : null,
      primaryResistanceToday60d: primaryResistance ? primaryResistance.today : null,

      // EMAs (no duplicate aliases)
      ema4hPeriod20,
      ema4hPeriod50,
      ema4hPeriod200,
      ema1dPeriod20,
      ema1dPeriod50,
      ema1dPeriod200
    };
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
