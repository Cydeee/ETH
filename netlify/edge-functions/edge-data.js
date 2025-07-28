// netlify/edge-functions/data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment

export const config = { path: ["/data", "/data.json"], cache: "manual" };

export default async function handler(request) {
  /* ───────────── CORS pre‑flight ───────────── */
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
  /* ───────────── switched to ETH ───────────── */
  const SYMBOL = "ETHUSDT";
  const LIMIT  = 250;

  const result = {
    dataA: {}, dataB: null, dataC: {}, dataD: {},
    dataE: null, dataF: null, dataG: null, dataH: null, errors: []
  };

  /* ───────────── helpers ───────────── */
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

  /* BLOCK A ─ Indicators --------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c  = kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c.at(-1)||1;
      const macdArr=c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      result.dataA[tf] = {
        ema50   : +ema(c,50).toFixed(2),
        ema200  : +ema(c,200).toFixed(2),
        rsi14   : +rsi(c,14).toFixed(1),
        atrPct  : +((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist: +(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
    } catch(e){ result.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* BLOCK B ─ Derivatives & liquidations ---------------------------------- */
  try {
    const fr   = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates= fr.slice(-42).map(d=>+d.fundingRate);
    const mean = rates.reduce((s,x)=>s+x,0)/rates.length;
    const sd   = Math.sqrt(rates.reduce((s,x)=>s+(x-mean)**2,0)/rates.length);
    const fundingZ = sd ? ((rates.at(-1)-mean)/sd).toFixed(2) : "0.00";

    const oiNow  = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist = await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`);
    const oiDelta24h = (((+oiNow.openInterest - +oiHist[0].sumOpenInterest)/+oiHist[0].sumOpenInterest)*100).toFixed(1);

    const liqRaw = await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const eth    = (liqRaw.data||[]).find(r=>r.symbol==="ETH")||{};
    result.dataB = {
      fundingZ, oiDelta24h,
      liquidations:{
        long1h:  eth.long1h  ?? 0,
        short1h: eth.short1h ?? 0,
        long4h:  eth.long4h  ?? 0,
        short4h: eth.short4h ?? 0,
        long24h: eth.long24h ?? 0,
        short24h:eth.short24h?? 0
      }
    };
  }catch(e){
    result.dataB={fundingZ:null,oiDelta24h:null,liquidations:null};
    result.errors.push("B: "+e.message);
  }

  /* BLOCK C ─ ROC ---------------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try{
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c  = kl.map(r=>+r[4]);
      result.dataC[tf] = { roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    }catch(e){ result.errors.push(`C[${tf}]: ${e.message}`); }
  }

  /* BLOCK D ─ Volume & CVD ------------------------------------------------- */
  try{
    const win={ "15m":0.25,"1h":1,"4h":4,"24h":24 }; result.dataD.cvd={};
    for(const [lbl,hrs] of Object.entries(win)){
      const end=Date.now(), start=end-hrs*3600000;
      const kl  = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; for(const k of kl){ +k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]; }
      const trd = await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; for(const t of trd){ const q=+t.q; cvd += t.m? -q : q; }

      result.dataD[lbl] = { bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      result.dataD.cvd[lbl] = +cvd.toFixed(2);
    }
    const tot24=result.dataD["24h"].totalVol, base={ "15m":tot24/96,"1h":tot24/24,"4h":tot24/6 };
    result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){
      const r=result.dataD[lbl].totalVol/Math.max(base[lbl],1);
      result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  }catch(e){ result.errors.push("D: "+e.message); }

  /* BLOCK E ─ Stress index ------------------------------------------------- */
  try{
    const b=Math.min(3,Math.abs(+result.dataB.fundingZ||0));
    const l=Math.max(0,(+result.dataB.oiDelta24h||0)/5);
    const vFlag=result.dataD.relative["15m"]; const v=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=result.dataB.liquidations||{}, imb=Math.abs((liq.long24h||0)-(liq.short24h||0));
    const q=Math.min(2,imb/1e6);
    const stress=b+l+v+q;
    result.dataE={
      stressIndex:+stress.toFixed(2),
      highRisk:stress>=5,
      components:{biasScore:b,levScore:l,volScore:v,liqScore:q}
    };
  }catch(e){ result.dataE=null; result.errors.push("E: "+e.message); }

  /* BLOCK F ─ Structure, VPVR, live price --------------------------------- */
  try{
    const bars4h=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const bars1d=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=30`);
    const bars1w=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=12`);
    const vp=b=>{
      const bkt={}; for(const r of b){
        const px=(+r[2]+ +r[3]+ +r[4])/3,
              key=Math.round(px/50)*50;           // $50 buckets for ETH
        bkt[key]=(bkt[key]||0)+ +r[5];
      }
      const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return { poc, buckets:bkt };
    };
    result.dataF={ vpvr:{ "4h":vp(bars4h), "1d":vp(bars1d), "1w":vp(bars1w) } };

    /* live price from last 1‑minute candle */
    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    result.dataF.price = +(+last1m[0][4]).toFixed(2);

  }catch(e){ result.errors.push("F: "+e.message); }

  /* BLOCK G ─ Macro -------------------------------------------------------- */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"), gd=gv.data;
    result.dataG={
      totalMcapT:+(gd.total_market_cap.usd/1e12).toFixed(2),
      mcap24hPct:+gd.market_cap_change_percentage_24h_usd.toFixed(2),
      btcDominance:+gd.market_cap_percentage.btc.toFixed(2),
      ethDominance:+gd.market_cap_percentage.eth.toFixed(2)
    };
  }catch(e){ result.errors.push("G: "+e.message); }

  /* BLOCK H ─ Sentiment ---------------------------------------------------- */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"), d=fg.data?.[0];
    if(!d) throw new Error("FNG missing");
    result.dataH={ fearGreed:`${d.value} · ${d.value_classification}` };
  }catch(e){ result.errors.push("H: "+e.message); }

  return result;
}
