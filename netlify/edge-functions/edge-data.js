/* netlify/edge-functions/data.js           ETH version
   Blocks: A Indicators | B Derivatives | C ROC | D Vol+CVD
           E Stress | F Structure+VPVR+Price | G Macro | H Sentiment */

export const config = { path: ["/data", "/data.json"], cache: "manual" };

export default async function handler(request) {
  /* --- CORS pre‑flight --- */
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors()
    });
  }

  const wantJson = new URL(request.url).pathname.endsWith("/data.json");

  try {
    const payload     = await buildDashboardData();   // ← ETH data
    payload.timestamp = Date.now();

    const body = wantJson
      ? JSON.stringify(payload)
      : `<!DOCTYPE html><html><body><pre id="dashboard-data">${
          JSON.stringify(payload, null, 2)
        }</pre></body></html>`;

    const hdrs = wantJson ? json() : html();
    return new Response(body, { headers: hdrs });

  } catch (err) {
    console.error("Edge Function error:", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: html()
    });
  }
}

/* ---------- helpers for headers ---------- */
const cors = () => ({
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
});
const json = () => ({ ...cors(),
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=60, must-revalidate"
});
const html = () => ({ ...cors(),
  "Content-Type": "text/html; charset=utf-8"
});

/* ---------- buildDashboardData ---------- */
async function buildDashboardData () {

  /* ── ETH pair ───────────────────────────── */
  const SYMBOL = "ETHUSDT";                     // ← changed from BTCUSDT
  const LIMIT  = 250;

  /* generic fetch wrapper (Edge runtime = Deno) */
  const safeJson = async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const out = {
    dataA:{}, dataB:null, dataC:{}, dataD:{},
    dataE:null, dataF:null, dataG:null, dataH:null, errors:[]
  };

  /* maths */
  const sma = (a,p)=>a.slice(-p).reduce((s,v)=>s+v,0)/p;
  const ema = (a,p)=>{ if(a.length<p) return 0;
    const k=2/(p+1); let e=sma(a.slice(0,p),p);
    for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k);
    return e;
  };
  const rsi = (a,p)=>{ if(a.length<p+1) return 0;
    let up=0,dn=0;
    for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d;}
    let au=up/p,ad=dn/p;
    for(let i=p+1;i<a.length;i++){
      const d=a[i]-a[i-1];
      au=(au*(p-1)+Math.max(d,0))/p;
      ad=(ad*(p-1)+Math.max(-d,0))/p;
    }
    return ad?100-100/(1+au/ad):100;
  };
  const atr = (h,l,c,p)=>{ if(h.length<p+1) return 0;
    const tr=[];
    for(let i=1;i<h.length;i++)
      tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    return sma(tr,p);
  };
  const roc = (a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

  /* A – Indicators --------------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c  = kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c.at(-1)||1;
      const macdArr = c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      out.dataA[tf] = {
        ema50   : +ema(c,50).toFixed(2),
        ema200  : +ema(c,200).toFixed(2),
        rsi14   : +rsi(c,14).toFixed(1),
        atrPct  : +((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist: +(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
    } catch(e){ out.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* B, C, D, E – unchanged from BTC version … */

  /* F – VPVR + live price + levels ---------------------------------------- */
  try {
    /* VPVR */
    const tfBars = async (int,lim) => safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${int}&limit=${lim}`);
    const vp = bars => {
      const bkt={};
      for(const b of bars){
        const px=(+b[2]+ +b[3]+ +b[4])/3,
              key=Math.round(px/50)*50;        // ← bucket = $50 for ETH
        bkt[key]=(bkt[key]||0)+ +b[5];
      }
      const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return { poc, buckets:bkt };
    };

    const v4h = vp(await tfBars("4h",96));
    const v1d = vp(await tfBars("1d",30));
    const v1w = vp(await tfBars("1w",12));

    /* current price – last 1‑m close */
    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    const price  = +last1m[0][4];

    out.dataF = { vpvr:{ "4h":v4h,"1d":v1d,"1w":v1w }, price:+price.toFixed(2) };

    /* intraday levels (pivot, VWAP band, HH20/LL20) */
    const dBars   = await tfBars("1d", 2);
    const yHigh   = +dBars.at(-2)[2], yLow=+dBars.at(-2)[3], yClose=+dBars.at(-2)[4];
    const pivot   = (yHigh+yLow+yClose)/3, R1=2*pivot-yLow, S1=2*pivot-yHigh;

    const hBars20 = await tfBars("1h",20);
    const HH20 = Math.max(...hBars20.map(b=>+b[2]));
    const LL20 = Math.min(...hBars20.map(b=>+b[3]));

    const start00 = new Date(); start00.setUTCHours(0,0,0,0);
    const vwapBars = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start00.getTime()}&limit=1440`);
    let vsum=0,pv=0,pv2=0;
    vwapBars.forEach(b=>{
      const v=+b[5], px=(+b[1]+ +b[2]+ +b[3]+ +b[4])/4;
      vsum+=v; pv+=px*v; pv2+=px*px*v;
    });
    const vwap = pv/vsum, sigma = Math.sqrt(Math.max(pv2/vsum - vwap*vwap,0));

    out.dataF.levels = {
      pivot:+pivot.toFixed(2), R1:+R1.toFixed(2), S1:+S1.toFixed(2),
      HH20:+HH20.toFixed(2),  LL20:+LL20.toFixed(2),
      vwap:+vwap.toFixed(2),
      vwapUpper:+(vwap+sigma).toFixed(2),
      vwapLower:+(vwap-sigma).toFixed(2)
    };

  } catch(e){ out.errors.push(`F: ${e.message}`); }

  /* G, H – unchanged … */

  return out;
}
