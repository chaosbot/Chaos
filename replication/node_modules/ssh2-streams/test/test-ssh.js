var SSH2Stream = require('../lib/ssh');
var utils = require('../lib/utils');
var parseKey = utils.parseKey;
var genPubKey = utils.genPublicKey;

var basename = require('path').basename;
var assert_ = require('assert');
var inherits = require('util').inherits;
var TransformStream = require('stream').Transform;
var fs = require('fs');

var group = basename(__filename, '.js') + '/';
var t = -1;
var SERVER_KEY = fs.readFileSync(__dirname + '/fixtures/ssh_host_rsa_key');
var HOST_KEYS = { 'ssh-rsa': makeServerKey(SERVER_KEY) };

function SimpleStream() {
  TransformStream.call(this);
  this.buffer = '';
}
inherits(SimpleStream, TransformStream);
SimpleStream.prototype._transform = function(chunk, encoding, cb) {
  this.buffer += chunk.toString('binary');
  cb(null, chunk);
};

var tests = [
  // client-side tests
  { run: function() {
      var algos = ['ssh-dss', 'ssh-rsa', 'ecdsa-sha2-nistp521'];
      var client = new SSH2Stream({
        algorithms: {
          serverHostKey: algos
        }
      });
      var clientBufStream = new SimpleStream();
      var clientReady = false;
      var server = new SSH2Stream({
        server: true,
        hostKeys: HOST_KEYS
      });
      var serverBufStream = new SimpleStream();
      var serverReady = false;

      function onNEWKEYS() {
        if (this === client) {
          assert(!clientReady, 'Already received client NEWKEYS event');
          clientReady = true;
        } else {
          assert(!serverReady, 'Already received server NEWKEYS event');
          serverReady = true;
        }
        if (clientReady && serverReady) {
          var traffic = clientBufStream.buffer;
          var algoList = algos.join(',');
          var re = new RegExp('\x00\x00\x00'
                              + hexByte(algoList.length)
                              + algoList);
          assert(re.test(traffic), 'Unexpected client algorithms');

          traffic = serverBufStream.buffer;
          assert(/\x00\x00\x00\x07ssh-rsa/.test(traffic),
                 'Unexpected server algorithms');

          next();
        }
      }

      client.on('NEWKEYS', onNEWKEYS);
      server.on('NEWKEYS', onNEWKEYS);

      client.pipe(clientBufStream)
            .pipe(server)
            .pipe(serverBufStream)
            .pipe(client);
    },
    what: 'Custom algorithms'
  },
];

function makeServerKey(raw) {
  var privateKey = parseKey(raw);
  return {
    privateKey: privateKey,
    publicKey: genPubKey(privateKey)
  };
}

function hexByte(n) {
  return String.fromCharCode(n);
}

function assert(expression, msg) {
  msg || (msg = 'failed assertion');
  assert_(expression, makeMsg(tests[t].what, msg));
}



function next() {
  if (Array.isArray(process._events.exit))
    process._events.exit = process._events.exit[1];
  if (++t === tests.length)
    return;

  var v = tests[t];
  v.run.call(v);
}

function makeMsg(what, msg) {
  return '[' + group + what + ']: ' + msg;
}

process.once('exit', function() {
  assert_(t === tests.length,
          makeMsg('_exit',
                  'Only finished ' + t + '/' + tests.length + ' tests'));
});

next();
