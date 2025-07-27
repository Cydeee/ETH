#!/usr/bin/env node
/*  alert.js  – high‑conviction notifier (5‑min cadence, 60‑min mute)
    ----------------------------------------------------------------
    ENV‑driven so the *same* code works for any Binance perpetual:
      SYMBOL              – market symbol, e.g. ETHUSDT  (defaults to ETHUSDT)
      TELEGRAM_BOT_TOKEN  – bot token
      TELEGRAM_CHAT_ID    – destination chat/channel ID
      LIVE_URL            – https://<site>.netlify.app/.netlify/functions/data
      HTTPS_PROXY         – http://user:pass@host:port     (optional)
      DEBUG=true          – prints tables & skips mute for dry‑run
*/

import fs     from "fs";
import fetch  from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────────────────────────────────────
   0 ▪ ENV + helpers
─────────────────────────────────────── */
const {
  SYMBOL = "ETHUSDT",
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID : CHAT,
  LIVE_URL        : LIVE,
  HTTPS_PROXY     : PROXY
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const DEBUG = process.env.DEBUG === "true";
const ASSET = SYMBOL.replace(/USDT$/,"");          // "ETH"
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

const tg = msg => fetch(
  `https://api.telegram.org/bot${BOT}/sendMessage`,
  { method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:CHAT, text:msg, parse_mode:"Markdown", disable_web_page_preview:true })
  });

/* ───────────────────────────────────────
   1 ▪ Scoring engine (matches custom‑GPT)
─────────────────────────────────────── */
function helperScores(r){
  const A=r.dataA, B=r.dataB, C=r.dataC, D=r.dataD, E=r.dataE, F=r.dataF, G=r.dataG, H=r.dataH;
  const price = F.price || 0;
  const safe=v=>(v===undefined||v===null||Number.isNaN(v))?0:v;

  /* Momentum */
  const trend15=Math.sign(A["15m"].ema50-A["15m"].ema200)||0;
  const trend1h=Math.sign(A["1h"].ema50 -A["1h"].ema200)||0;
  const trend4h=Math.sign(A["4h"].ema50 -A["4h"].ema200)||0;
  const rsi1h  =A["1h"].rsi14>65?1:A["1h"].rsi14<35?-1:0;

  /* Velocity (ATR‑adaptive) */
  const atrPct=safe(A["15m"].atrPct);
  const roc10=C["15m"].roc10>=0.4*atrPct?1:C["15m"].roc10<=-0.4*atrPct?-1:0;
  const roc20=C["15m"].roc20>=0.8*atrPct?1:C["15m"].roc20<=-0.8*atrPct?-1:0;

  /* Volume & derivatives */
  const volRel15={"very high":2,"high":1,"normal":0,"low":-1}[D.relative["15m"]]??0;
  const fundingBias=B.fundingZ<=-0.5?1:B.fundingZ>=0.5?-1:0;
  const oiShift   =B.oiDelta24h>=2?1:B.oiDelta24h<=-2?-1:0;
  const stressFlag=E?(E.stressIndex>=7?2:E.stressIndex>=5?1:0):0;
  const liq=B.liquidations||{};
  const liqImb=(liq.long1h+liq.long4h)-(liq.short1h+liq.short4h);

  /* ETH‑specific: raise imbalance bar to tame noise        */
  const LIQ_BIAS_THRESHOLD = 600_000;               // $0.6 M
  const liqBias=Math.abs(liqImb)>LIQ_BIAS_THRESHOLD?Math.sign(liqImb):0; // +1 = long heavy, bearish

  /* Structure */
  const pocDir = F.vpvr?.["1d"]?.poc
    ? Math.abs(price-F.vpvr["1d"].poc) >= 0.002*price ? Math.sign(price-F.vpvr["1d"].poc) : 0
    : 0;

  /* Macro / sentiment */
  const macroDir=G?(G.mcap24hPct>=1?1:G.mcap24hPct<=-1?-1:0):0;
  const fg = parseInt(H?.fearGreed||"50",10);
  const sentiment = fg>60?1: fg<40?-1:0;

  return { price, trend15,trend1h,trend4h,rsi1h,
           roc10,roc20,volRel15,fundingBias,oiShift,
           stressFlag,liqBias,pocDir,macroDir,sentiment, atrPct };
}

function consensus(s){
  const fast  = s.trend15 + s.rsi1h + s.roc10 + s.volRel15 + s.fundingBias + s.liqBias + s.pocDir;
  const swing = s.trend1h + s.trend4h + s.roc20 + s.oiShift + s.macroDir + s.stressFlag;
  let dir="FLAT", conv="Low";
  if( fast>=4 || swing>=5)      {dir="LONG";  conv="High";}
  else if(fast<=-4||swing<=-5)  {dir="SHORT"; conv="High";}
  else if(fast>=2||swing>=3)    {dir="LONG";  conv="Medium";}
  else if(fast<=-2||swing<=-3)  {dir="SHORT"; conv="Medium";}
  return {dir,conv,fast,swing};
}

const color=v=>v>0?"🟢":v<0?"🔴":"🟡";
const blockLights=s=>[
  color(s.trend15+s.trend1h),              // A
  color(s.fundingBias+s.oiShift),          // B
  color(s.roc10+s.roc20),                  // C
  color(s.volRel15),                       // D
  color(-s.stressFlag),                    // E
  color(s.pocDir),                         // F
  color(s.macroDir),                       // G
  color(s.sentiment)                       // H
].join("");

/* ───────────────────────────────────────
   2 ▪ Main
─────────────────────────────────────── */
(async()=>{
  try{
    const url = `${LIVE}?symbol=${SYMBOL}`;        // let Netlify fct switch asset
    const res = await fetch(url,{agent,timeout:20000});
    if(!res.ok) throw new Error(`${url} ${res.status}`);
    const raw = await res.json();

    const scores = helperScores(raw);
    const sig    = consensus(scores);

    if(DEBUG){ console.table(scores); console.log(sig); }

    /* High‑only */
    if(sig.conv!=="High"){ console.log("Not High conviction"); return; }

    /* 60‑minute anti‑spam */
    const cache = `/tmp/last_alert_${SYMBOL}.json`;
    let last={ ts:0 };
    try{ last = JSON.parse(fs.readFileSync(cache,"utf8")); }catch{}
    if(!DEBUG && Date.now()-last.ts < 3_600_000){
      console.log("Muted – last alert <60 min."); return;
    }

    /* Build Telegram message */
    const fmt = n=>"$"+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
    const cet = new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
    let msg   = `*Signal Block* | ${ASSET}/USD | *Time* ${cet}\n`;
    msg      += `*Current Price* ${fmt(scores.price)}\n`;
    msg      += `🚀 *${sig.dir}* (**High conviction**)\n`;
    msg      += `🚦 *Block Biases*: ${blockLights(scores)}\n\n`;
    msg      += `🧩 *Consensus*\n• Fast ${sig.fast}   • Swing ${sig.swing}`;

    await tg(msg);
    fs.writeFileSync(cache,JSON.stringify({ ts:Date.now() }));
    console.log("Alert sent.");

  }catch(err){
    console.error(err);
    if(!DEBUG) await tg(`⚠️ Alert script error: ${err.message}`);
    process.exit(1);
  }
})();
