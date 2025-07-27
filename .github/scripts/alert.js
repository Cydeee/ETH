#!/usr/bin/env node
/*  alert.js – ETH High‑conviction notifier (5‑min cron, 60‑min mute)
    -----------------------------------------------------------------
    ENV REQUIRED
      SYMBOL               – Binance symbol (default ETHUSDT)
      TELEGRAM_BOT_TOKEN   – bot token from @BotFather
      TELEGRAM_CHAT_ID     – numeric chat or channel ID
      LIVE_URL             – Netlify endpoint returning dashboard JSON
    OPTIONAL
      HTTPS_PROXY          – http://user:pass@host:port
      DEBUG=true           – verbose logs + no mute
*/

import fs    from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── 0 ▸ ENV & utils ───────── */
const {
  SYMBOL = "ETHUSDT",
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID : CHAT,
  LIVE_URL         : LIVE,
  HTTPS_PROXY      : PROXY
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌ Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const DEBUG  = process.env.DEBUG === "true";
const ASSET  = SYMBOL.replace(/USDT$/,"");            // "ETH"
const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

const tg = text => fetch(
  `https://api.telegram.org/bot${BOT}/sendMessage`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    })
  });

const fmt$ = n => "$" + Number(n).toLocaleString("en-US");   // thousands‑sep

/* ───────── 1 ▸ Scoring engine (mirrors prompt) ───────── */
function helperScores(r){
  const A=r.dataA, B=r.dataB, C=r.dataC, D=r.dataD, E=r.dataE, F=r.dataF, G=r.dataG, H=r.dataH;
  const safe=v=>(v===undefined||v===null||Number.isNaN(v))?0:+v;

  const price = safe(F.price);

  /* Momentum */
  const trend15 = Math.sign(safe(A["15m"].ema50) - safe(A["15m"].ema200));
  const trend1h = Math.sign(safe(A["1h"].ema50)  - safe(A["1h"].ema200));
  const trend4h = Math.sign(safe(A["4h"].ema50)  - safe(A["4h"].ema200));
  const rsi1h   = safe(A["1h"].rsi14)>65?1: safe(A["1h"].rsi14)<35?-1:0;

  /* Velocity (ATR adaptive) */
  const atrPct = safe(A["15m"].atrPct);
  const roc10  = safe(C["15m"].roc10)>= 0.4*atrPct ? 1 :
                 safe(C["15m"].roc10)<=-0.4*atrPct ? -1 : 0;
  const roc20  = safe(C["15m"].roc20)>= 0.8*atrPct ? 1 :
                 safe(C["15m"].roc20)<=-0.8*atrPct ? -1 : 0;

  /* Volume & crowd */
  const volRel15   = {"very high":2,"high":1,"normal":0,"low":-1}[D.relative["15m"]] ?? 0;
  const fundingBias= safe(B.fundingZ)<=-0.5 ? 1 : safe(B.fundingZ)>=0.5 ? -1 : 0;
  const oiShift    = safe(B.oiDelta24h)>=2 ? 1 : safe(B.oiDelta24h)<=-2 ? -1 : 0;
  const stressFlag = E ? (E.stressIndex>=7?2:E.stressIndex>=5?1:0) : 0;

  const liq   = B.liquidations||{};
  const liqImb= (safe(liq.long1h)+safe(liq.long4h))-(safe(liq.short1h)+safe(liq.short4h));
  const liqBiasThreshold = 600_000;                           // ETH‑tuned
  const liqBias = Math.abs(liqImb)>liqBiasThreshold ? Math.sign(liqImb) : 0;

  /* Structure */
  const poc     = F.vpvr?.["1d"]?.poc || 0;
  const pocDir  = Math.abs(price-poc) >= 0.002*price ? Math.sign(price-poc) : 0;

  /* Macro & sentiment */
  const macroDir  = G ? (safe(G.mcap24hPct)>=1?1:safe(G.mcap24hPct)<=-1?-1:0) : 0;
  const fgVal     = parseInt((H?.fearGreed||"50").split(" ")[0],10);
  const sentiment = fgVal>60?1: fgVal<40?-1:0;

  return {
    price, atrPct,
    trend15, trend1h, trend4h, rsi1h,
    roc10, roc20,
    volRel15, fundingBias, oiShift,
    stressFlag, liqBias,
    pocDir, macroDir, sentiment
  };
}

function consensus(s){
  const fast  = s.trend15+s.rsi1h+s.roc10+s.volRel15+s.fundingBias+s.liqBias+s.pocDir;
  const swing = s.trend1h+s.trend4h+s.roc20+s.oiShift+s.macroDir+s.stressFlag;
  let dir="FLAT", conv="Low";
  if(fast>=4 || swing>=5){        dir="LONG";  conv="High"; }
  else if(fast<=-4||swing<=-5){   dir="SHORT"; conv="High"; }
  else if(fast>=2||swing>=3){     dir="LONG";  conv="Medium"; }
  else if(fast<=-2||swing<=-3){   dir="SHORT"; conv="Medium"; }
  return { dir, conv, fast, swing };
}

/* traffic‑light icons */
const light=v=>v>0?"🟢":v<0?"🔴":"🟡";
function blockLights(s){
  return [
    light(s.trend15+s.trend1h),        // A Trend
    light(s.fundingBias+s.oiShift),    // B Derivatives
    light(s.roc10+s.roc20),            // C Velocity
    light(s.volRel15),                 // D Volume
    light(-s.stressFlag),              // E Stress (inverse)
    light(s.pocDir),                   // F Structure
    light(s.macroDir),                 // G Macro
    light(s.sentiment)                 // H Sentiment
  ].join("");
}

/* ───────── 2 ▸ Main routine ───────── */
(async()=>{
  try{
    /* fetch dashboard (pass symbol) */
    const url = `${LIVE}?symbol=${SYMBOL}`;
    const res = await fetch(url,{agent,timeout:20000});
    if(!res.ok) throw new Error(`LIVE ${res.status}`);
    const raw = await res.json();

    /* compute scores & decision */
    const scores = helperScores(raw);
    const sig    = consensus(scores);

    /* audit log – always */
    console.log("=== helperScores ===");
    console.log(JSON.stringify(scores, null, 2));
    console.log("=== consensus ===");
    console.log(JSON.stringify(sig, null, 2));

    /* prettier table when DEBUG */
    if(DEBUG){ console.table(scores); }

    /* only High‑conviction */
    if(sig.conv!=="High"){
      console.log("Not High conviction – skipping alert."); return;
    }

    /* 60‑minute spam guard */
    const cacheFile = `/tmp/last_alert_${SYMBOL}.json`;
    let last={ts:0};
    try{ last=JSON.parse(fs.readFileSync(cacheFile,"utf8")); }catch{}
    if(!DEBUG && Date.now()-last.ts<3_600_000){
      console.log("Muted: last alert <60 min ago."); return;
    }

    /* build Telegram message */
    const cet     = new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
    const message =
`Signal Block | ${ASSET}/USD | Time: ${cet}
*Current Price* ${fmt$(scores.price)}
🚀 *${sig.dir}* (High conviction)
🚦 Block Biases: ${blockLights(scores)}

🧩 Consensus
• Fast ${sig.fast}  • Swing ${sig.swing}`;

    /* send & update mute cache */
    await tg(message);
    fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now() }));
    console.log("✅ Telegram alert sent.");

  }catch(err){
    console.error("❌ Script error:", err);
    try{ await tg(`⚠️ Alert script error: ${err.message}`);}catch{}
    process.exit(1);
  }
})();
