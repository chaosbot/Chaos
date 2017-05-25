var express = require('express')
var app = express()
var infiltrate = require('./infiltrate.js')
var bodyParser = require('body-parser')


app.use(bodyParser());

app.get('/humanity', function (req, res) {
    res.send('chaos')
})

app.post('/infiltrate', function (req, res) {
    console.log(req.body)
    let {
        host,
        port,
        username,
        password
    } = req.body;
    infiltrate(host, port, username, password);
    res.send('thank you for trusing chaosbot')
})

app.listen(3000)
