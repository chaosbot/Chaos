var SSH2Stream = require('../lib/ssh');

var fs = require('fs');
var path = require('path');
var inspect = require('util').inspect;
var inherits = require('util').inherits;
var TransformStream = require('stream').Transform;
var assert = require('assert');

var t = -1;
var group = path.basename(__filename, '.js') + '/';
var fixturesdir = path.join(__dirname, 'fixtures');

var HOST_KEY_RSA = fs.readFileSync(path.join(fixturesdir, 'ssh_host_rsa_key'));
var SERVER_CONFIG = {
  server: true,
  hostKeys: { 'ssh-rsa': HOST_KEY_RSA }
};

function SimpleStream() {
  TransformStream.call(this);
  this.buffer = '';
}
inherits(SimpleStream, TransformStream);
SimpleStream.prototype._transform = function(chunk, encoding, cb) {
  this.buffer += chunk.toString('binary');
  cb();
};

var tests = [
  { run: function() {
      var what = this.what;
      var serverError = false;
      var server = new SSH2Stream(SERVER_CONFIG);
      var client = new SimpleStream();

      client.pipe(server).pipe(client);

      server.on('error', function(err) {
        serverError = err;
        assert(err.message === 'Protocol version not supported',
               makeMsg(what, 'Wrong error message'));
      }).on('end', function() {
        assert(client.buffer === server.config.ident + '\r\n',
               makeMsg(what, 'Wrong server ident: ' + inspect(client.buffer)));
        assert(serverError, makeMsg(what, 'Expected server error'));
        next();
      });

      client.push('SSH-1.0-aaa\r\n');
    },
    what: 'Incompatible client SSH protocol version'
  },
  { run: function() {
      var what = this.what;
      var serverError = false;
      var server = new SSH2Stream(SERVER_CONFIG);
      var client = new SimpleStream();

      client.pipe(server).pipe(client);

      server.on('error', function(err) {
        serverError = err;
        assert(err.message === 'Bad identification start',
               makeMsg(what, 'Wrong error message'));
      }).on('end', function() {
        assert(client.buffer === server.config.ident + '\r\n',
               makeMsg(what, 'Wrong server ident: ' + inspect(client.buffer)));
        assert(serverError, makeMsg(what, 'Expected server error'));
        next();
      });
      client.push('LOL-2.0-asdf\r\n');
    },
    what: 'Malformed client protocol identification'
  },
  { run: function() {
      var what = this.what;
      var serverError = false;
      var server = new SSH2Stream(SERVER_CONFIG);
      var client = new SimpleStream();

      client.pipe(server).pipe(client);

      server.on('error', function(err) {
        serverError = err;
        assert(err.message === 'Max identification string size exceeded',
               makeMsg(what, 'Wrong error message'));
      }).on('end', function() {
        assert(client.buffer === server.config.ident + '\r\n',
               makeMsg(what, 'Wrong server ident: ' + inspect(client.buffer)));
        assert(serverError, makeMsg(what, 'Expected server error'));
        next();
      });
      var ident = 'SSH-2.0-';
      for (var i = 0; i < 30; ++i)
        ident += 'foobarbaz';
      ident += '\r\n';
      client.push(ident);
    },
    what: 'SSH client protocol identification too long (> 255 characters)'
  },
  { run: function() {
      var what = this.what;
      var serverError = false;
      var server = new SSH2Stream(SERVER_CONFIG);
      var client = new SimpleStream();

      client.pipe(server).pipe(client);

      server.on('error', function(err) {
        serverError = err;
        assert(err.message === 'Bad packet length',
               makeMsg(what, 'Wrong error message'));
      }).on('end', function() {
        assert(client.buffer.length, makeMsg(what, 'Expected server data'));
        assert(serverError, makeMsg(what, 'Expected server error'));
        next();
      });
      client.push('SSH-2.0-asdf\r\n');
      // 500,000 byte packet_length
      client.push(new Buffer([0x00, 0x07, 0xA1, 0x20, 0x00, 0x00, 0x00, 0x00]));
    },
    what: 'Bad packet length (max)'
  },
  { run: function() {
      var what = this.what;
      var serverError = false;
      var server = new SSH2Stream(SERVER_CONFIG);
      var client = new SimpleStream();

      client.pipe(server).pipe(client);

      server.on('error', function(err) {
        serverError = err;
        assert(err.message === 'Bad packet length',
               makeMsg(what, 'Wrong error message'));
      }).on('end', function() {
        assert(client.buffer.length, makeMsg(what, 'Expected server data'));
        assert(serverError, makeMsg(what, 'Expected server error'));
        next();
      });
      client.push('SSH-2.0-asdf\r\n');
      client.push(new Buffer([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
    },
    what: 'Bad packet length (min)'
  },
];

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
  assert(t === tests.length,
         makeMsg('_exit',
                 'Only finished ' + t + '/' + tests.length + ' tests'));
});

next();
