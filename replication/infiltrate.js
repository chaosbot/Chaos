var Client = require('ssh2').Client;

let ftpUser = 'anonymous';
let ftpPass = '';
let ftpUrl = 'chaosthebot.com';

module.exports = (host, port = 22, username, password) => {
    let conn = new Client();

    conn.on('ready', () => {
        conn.exec(`sudo apt-get --force-yes --yes install virtualbox && sudo apt-get --force-yes --yes install vagrant && apt-get install git && git clone https://github.com/chaosbot/chaos.git && cd /chaos && sudo vagrant up && vagrant ssh && sudo su && cd /vagrant && pyhthon3 chaos.py`, (err, stream) => {
            if (err) throw err
            stream.on('close', (code, signal) => {
                console.log(`Stream closed code: ${code}, signal: ${signal}`);
                conn.end();
            }).on('data', (data) => {
                console.log(`STDOUT: ${data}`)
            })
        })
    }).connect({
        host: host,
        port: port,
        username: username,
        password: password,
        forceIPv4: true
    })
}
