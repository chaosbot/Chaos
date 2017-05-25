var SFTPStream = require('../lib/sftp');
var Stats = SFTPStream.Stats;
var STATUS_CODE = SFTPStream.STATUS_CODE;
var OPEN_MODE = SFTPStream.OPEN_MODE;

var constants = require('constants');
var basename = require('path').basename;
var assert = require('assert');

var group = basename(__filename, '.js') + '/';
var t = -1;

var tests = [
// successful client requests
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/tmp/foo.txt';
        var handle_ = new Buffer('node.js');
        server.on('OPEN', function(id, path, pflags, attrs) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert(pflags === (OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE),
                 makeMsg(what, 'Wrong flags: ' + flagsToHuman(pflags)));
          server.handle(id, handle_);
          server.end();
        });
        client.open(path_, 'w', function(err, handle) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected open() error: ' + err));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
        });
      };
    },
    what: 'open'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        server.on('CLOSE', function(id, handle) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.close(handle_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected close() error: ' + err));
        });
      };
    },
    what: 'close'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var expected = new Buffer('node.jsnode.jsnode.jsnode.jsnode.jsnode.js');
        var buffer = new Buffer(expected.length);
        buffer.fill(0);
        server.on('READ', function(id, handle, offset, len) {
          assert(++self.state.requests <= 2,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert(offset === 5, makeMsg(what, 'Wrong read offset: ' + offset));
          assert(len === buffer.length, makeMsg(what, 'Wrong read len: ' + len));
          server.data(id, expected);
          server.end();
        });
        client.readData(handle_, buffer, 0, buffer.length, 5, clientReadCb);
        function clientReadCb(err, code) {
          assert(++self.state.responses <= 2,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected readData() error: ' + err));
          assert.deepEqual(buffer,
                           expected,
                           makeMsg(what, 'read data mismatch'));
        }
      };
    },
    what: 'readData'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var buf = new Buffer('node.jsnode.jsnode.jsnode.jsnode.jsnode.js');
        server.on('WRITE', function(id, handle, offset, data) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert(offset === 5, makeMsg(what, 'Wrong write offset: ' + offset));
          assert.deepEqual(data, buf, makeMsg(what, 'write data mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.writeData(handle_, buf, 0, buf.length, 5, function(err, nb) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected writeData() error: ' + err));
          assert.equal(nb, buf.length);
        });
      };
    },
    what: 'write'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var buf = new Buffer(3 * 32 * 1024);
        server.on('WRITE', function(id, handle, offset, data) {
          ++self.state.requests;
          assert.equal(id,
                       self.state.requests - 1,
                       makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert.equal(offset,
                       (self.state.requests - 1) * 32 * 1024,
                       makeMsg(what, 'Wrong write offset: ' + offset));
          assert((offset + data.length) <= buf.length);
          assert.deepEqual(data,
                           buf.slice(offset, offset + data.length),
                           makeMsg(what, 'write data mismatch'));
          server.status(id, STATUS_CODE.OK);
          if (self.state.requests === 3)
            server.end();
        });
        client.writeData(handle_, buf, 0, buf.length, 0, function(err, nb) {
          ++self.state.responses;
          assert(!err, makeMsg(what, 'Unexpected writeData() error: ' + err));
          assert.equal(nb, buf.length);
        });
      };
    },
    expected: {
      requests: 3,
      responses: 1
    },
    what: 'write (overflow)'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        var attrs_ = new Stats({
          size: 10 * 1024,
          uid: 9001,
          gid: 9001,
          atime: (Date.now() / 1000) | 0,
          mtime: (Date.now() / 1000) | 0
        });
        server.on('LSTAT', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.attrs(id, attrs_);
          server.end();
        });
        client.lstat(path_, function(err, attrs) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected lstat() error: ' + err));
          assert.deepEqual(attrs, attrs_, makeMsg(what, 'attrs mismatch'));
        });
      };
    },
    what: 'lstat'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var attrs_ = new Stats({
          size: 10 * 1024,
          uid: 9001,
          gid: 9001,
          atime: (Date.now() / 1000) | 0,
          mtime: (Date.now() / 1000) | 0
        });
        server.on('FSTAT', function(id, handle) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.attrs(id, attrs_);
          server.end();
        });
        client.fstat(handle_, function(err, attrs) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected fstat() error: ' + err));
          assert.deepEqual(attrs, attrs_, makeMsg(what, 'attrs mismatch'));
        });
      };
    },
    what: 'fstat'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        var attrs_ = new Stats({
          uid: 9001,
          gid: 9001,
          atime: (Date.now() / 1000) | 0,
          mtime: (Date.now() / 1000) | 0
        });
        server.on('SETSTAT', function(id, path, attrs) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert.deepEqual(attrs, attrs_, makeMsg(what, 'attrs mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.setstat(path_, attrs_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected setstat() error: ' + err));
        });
      };
    },
    what: 'setstat'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var attrs_ = new Stats({
          uid: 9001,
          gid: 9001,
          atime: (Date.now() / 1000) | 0,
          mtime: (Date.now() / 1000) | 0
        });
        server.on('FSETSTAT', function(id, handle, attrs) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert.deepEqual(attrs, attrs_, makeMsg(what, 'attrs mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.fsetstat(handle_, attrs_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected fsetstat() error: ' + err));
        });
      };
    },
    what: 'fsetstat'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var path_ = '/tmp';
        server.on('OPENDIR', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.handle(id, handle_);
          server.end();
        });
        client.opendir(path_, function(err, handle) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected opendir() error: ' + err));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
        });
      };
    },
    what: 'opendir'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var list_ = [
          { filename: '.',
            longname: 'drwxr-xr-x  56 nodejs   nodejs      4096 Nov 10 01:05 .',
            attrs: new Stats({
              mode: 0755 | constants.S_IFDIR,
              size: 4096,
              uid: 9001,
              gid: 8001,
              atime: 1415599549,
              mtime: 1415599590
            })
          },
          { filename: '..',
            longname: 'drwxr-xr-x   4 root     root        4096 May 16  2013 ..',
            attrs: new Stats({
              mode: 0755 | constants.S_IFDIR,
              size: 4096,
              uid: 0,
              gid: 0,
              atime: 1368729954,
              mtime: 1368729999
            })
          },
          { filename: 'foo',
            longname: 'drwxrwxrwx   2 nodejs   nodejs      4096 Mar  8  2009 foo',
            attrs: new Stats({
              mode: 0777 | constants.S_IFDIR,
              size: 4096,
              uid: 9001,
              gid: 8001,
              atime: 1368729954,
              mtime: 1368729999
            })
          },
          { filename: 'bar',
            longname: '-rw-r--r--   1 nodejs   nodejs 513901992 Dec  4  2009 bar',
            attrs: new Stats({
              mode: 0644 | constants.S_IFREG,
              size: 513901992,
              uid: 9001,
              gid: 8001,
              atime: 1259972199,
              mtime: 1259972199
            })
          }
        ];
        server.on('READDIR', function(id, handle) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.name(id, list_);
          server.end();
        });
        client.readdir(handle_, function(err, list) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected readdir() error: ' + err));
          assert.deepEqual(list,
                           list_.slice(2),
                           makeMsg(what, 'dir list mismatch'));
        });
      };
    },
    what: 'readdir'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        var list_ = [
          { filename: '.',
            longname: 'drwxr-xr-x  56 nodejs   nodejs      4096 Nov 10 01:05 .',
            attrs: new Stats({
              mode: 0755 | constants.S_IFDIR,
              size: 4096,
              uid: 9001,
              gid: 8001,
              atime: 1415599549,
              mtime: 1415599590
            })
          },
          { filename: '..',
            longname: 'drwxr-xr-x   4 root     root        4096 May 16  2013 ..',
            attrs: new Stats({
              mode: 0755 | constants.S_IFDIR,
              size: 4096,
              uid: 0,
              gid: 0,
              atime: 1368729954,
              mtime: 1368729999
            })
          },
          { filename: 'foo',
            longname: 'drwxrwxrwx   2 nodejs   nodejs      4096 Mar  8  2009 foo',
            attrs: new Stats({
              mode: 0777 | constants.S_IFDIR,
              size: 4096,
              uid: 9001,
              gid: 8001,
              atime: 1368729954,
              mtime: 1368729999
            })
          },
          { filename: 'bar',
            longname: '-rw-r--r--   1 nodejs   nodejs 513901992 Dec  4  2009 bar',
            attrs: new Stats({
              mode: 0644 | constants.S_IFREG,
              size: 513901992,
              uid: 9001,
              gid: 8001,
              atime: 1259972199,
              mtime: 1259972199
            })
          }
        ];
        server.on('READDIR', function(id, handle) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.name(id, list_);
          server.end();
        });
        client.readdir(handle_, { full: true }, function(err, list) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected readdir() error: ' + err));
          assert.deepEqual(list, list_, makeMsg(what, 'dir list mismatch'));
        });
      };
    },
    what: 'readdir (full)'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        server.on('REMOVE', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.unlink(path_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected unlink() error: ' + err));
        });
      };
    },
    what: 'remove'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        server.on('MKDIR', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.mkdir(path_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected mkdir() error: ' + err));
        });
      };
    },
    what: 'mkdir'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        server.on('RMDIR', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.rmdir(path_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected rmdir() error: ' + err));
        });
      };
    },
    what: 'rmdir'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        var name_ = { filename: '/tmp/foo' };
        server.on('REALPATH', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.name(id, name_);
          server.end();
        });
        client.realpath(path_, function(err, name) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected realpath() error: ' + err));
          assert.deepEqual(name, name_.filename, makeMsg(what, 'name mismatch'));
        });
      };
    },
    what: 'realpath'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        var attrs_ = new Stats({
          size: 10 * 1024,
          uid: 9001,
          gid: 9001,
          atime: (Date.now() / 1000) | 0,
          mtime: (Date.now() / 1000) | 0
        });
        server.on('STAT', function(id, path) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          server.attrs(id, attrs_);
          server.end();
        });
        client.stat(path_, function(err, attrs) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected stat() error: ' + err));
          assert.deepEqual(attrs, attrs_, makeMsg(what, 'attrs mismatch'));
        });
      };
    },
    what: 'stat'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var oldPath_ = '/foo/bar/baz';
        var newPath_ = '/tmp/foo';
        server.on('RENAME', function(id, oldPath, newPath) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(oldPath === oldPath_,
                 makeMsg(what, 'Wrong old path: ' + oldPath));
          assert(newPath === newPath_,
                 makeMsg(what, 'Wrong new path: ' + newPath));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.rename(oldPath_, newPath_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected rename() error: ' + err));
        });
      };
    },
    what: 'rename'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var linkPath_ = '/foo/bar/baz';
        var name = { filename: '/tmp/foo' };
        server.on('READLINK', function(id, linkPath) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(linkPath === linkPath_,
                 makeMsg(what, 'Wrong link path: ' + linkPath));
          server.name(id, name);
          server.end();
        });
        client.readlink(linkPath_, function(err, targetPath) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected readlink() error: ' + err));
          assert(targetPath === name.filename,
                 makeMsg(what, 'Wrong target path: ' + targetPath));
        });
      };
    },
    what: 'readlink'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var linkPath_ = '/foo/bar/baz';
        var targetPath_ = '/tmp/foo';
        server.on('SYMLINK', function(id, linkPath, targetPath) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(linkPath === linkPath_,
                 makeMsg(what, 'Wrong link path: ' + linkPath));
          assert(targetPath === targetPath_,
                 makeMsg(what, 'Wrong target path: ' + targetPath));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        client.symlink(targetPath_, linkPath_, function(err) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(!err, makeMsg(what, 'Unexpected symlink() error: ' + err));
        });
      };
    },
    what: 'symlink'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/foo/bar/baz';
        var handle_ = new Buffer('hi mom!');
        var data_ = new Buffer('hello world');
        server.once('OPEN', function(id, path, pflags, attrs) {
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert(pflags === OPEN_MODE.READ,
                 makeMsg(what, 'Wrong flags: ' + flagsToHuman(pflags)));
          server.handle(id, handle_);
        }).once('FSTAT', function(id, handle) {
          assert(id === 1, makeMsg(what, 'Wrong request id: ' + id));
          var attrs = new Stats({
            size: data_.length,
            uid: 9001,
            gid: 9001,
            atime: (Date.now() / 1000) | 0,
            mtime: (Date.now() / 1000) | 0
          });
          server.attrs(id, attrs);
        }).once('READ', function(id, handle, offset, len) {
          assert(id === 2, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert(offset === 0, makeMsg(what, 'Wrong read offset: ' + offset));
          server.data(id, data_);
        }).once('CLOSE', function(id, handle) {
          ++self.state.requests;
          assert(id === 3, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        var buf = [];
        client.readFile(path_, function(err, buf) {
          ++self.state.responses;
          assert(!err, makeMsg(what, 'Unexpected error: ' + err));
          assert.deepEqual(buf, data_, makeMsg(what, 'data mismatch'));
        });
      };
    },
    what: 'readFile'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var opens = 0;
        var reads = 0;
        var closes = 0;
        var path_ = '/foo/bar/baz';
        var handle_ = new Buffer('hi mom!');
        var data_ = new Buffer('hello world');
        server.on('OPEN', function(id, path, pflags, attrs) {
          assert(++opens === 1, makeMsg(what, 'Saw too many OPENs'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert(pflags === OPEN_MODE.READ,
                 makeMsg(what, 'Wrong flags: ' + flagsToHuman(pflags)));
          server.handle(id, handle_);
        }).on('READ', function(id, handle, offset, len) {
          assert(++reads <= 2, makeMsg(what, 'Saw too many READs'));
          assert(id === reads, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          if (reads === 1) {
            assert(offset === 0, makeMsg(what, 'Wrong read offset: ' + offset));
            server.data(id, data_);
          } else
            server.status(id, STATUS_CODE.EOF);
        }).on('CLOSE', function(id, handle) {
          ++self.state.requests;
          assert(++closes === 1, makeMsg(what, 'Saw too many CLOSEs'));
          assert(id === 3, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        });
        var buf = [];
        client.createReadStream(path_).on('readable', function() {
          var chunk;
          while ((chunk = this.read()) !== null) {
            buf.push(chunk);
          }
        }).on('end', function() {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          buf = Buffer.concat(buf);
          assert.deepEqual(buf, data_, makeMsg(what, 'data mismatch'));
        });
      };
    },
    what: 'ReadStream'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var opens = 0;
        var path_ = '/foo/bar/baz';
        var error;
        server.on('OPEN', function(id, path, pflags, attrs) {
          ++opens;
          ++self.state.requests;
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert(pflags === OPEN_MODE.READ,
                 makeMsg(what, 'Wrong flags: ' + flagsToHuman(pflags)));
          server.status(id, STATUS_CODE.NO_SUCH_FILE);
          server.end();
        });
        client.createReadStream(path_).on('error', function(err) {
          error = err;
        }).on('close', function() {
          assert(opens === 1, makeMsg(what, 'Saw ' + opens + ' OPENs'));
          assert(error, makeMsg(what, 'Expected error'));
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
        });
      };
    },
    what: 'ReadStream (error)'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var opens = 0;
        var writes = 0;
        var closes = 0;
        var fsetstat = false;
        var path_ = '/foo/bar/baz';
        var handle_ = new Buffer('hi mom!');
        var data_ = new Buffer('hello world');
        var expFlags = OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE;
        server.on('OPEN', function(id, path, pflags, attrs) {
          assert(++opens === 1, makeMsg(what, 'Saw too many OPENs'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert(path === path_, makeMsg(what, 'Wrong path: ' + path));
          assert(pflags === expFlags,
                 makeMsg(what, 'Wrong flags: ' + flagsToHuman(pflags)));
          server.handle(id, handle_);
        }).once('FSETSTAT', function(id, handle, attrs) {
          fsetstat = true;
          assert(id === 1, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert.strictEqual(attrs.mode,
                             parseInt('0666', 8),
                             makeMsg(what, 'Wrong file mode'));
          server.status(id, STATUS_CODE.OK);
        }).on('WRITE', function(id, handle, offset, data) {
          assert(++writes <= 3, makeMsg(what, 'Saw too many WRITEs'));
          assert(id === writes + 1, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          assert(offset === ((writes - 1) * data_.length),
                 makeMsg(what, 'Wrong write offset: ' + offset));
          assert.deepEqual(data, data_, makeMsg(what, 'Wrong data'));
          server.status(id, STATUS_CODE.OK);
        }).on('CLOSE', function(id, handle) {
          ++self.state.requests;
          assert(++closes === 1, makeMsg(what, 'Saw too many CLOSEs'));
          assert(id === 5, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.status(id, STATUS_CODE.OK);
          server.end();
        }).on('end', function() {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(opens === 1, makeMsg(what, 'Wrong OPEN count'));
          assert(writes === 3, makeMsg(what, 'Wrong WRITE count'));
          assert(closes === 1, makeMsg(what, 'Wrong CLOSE count'));
          assert(fsetstat, makeMsg(what, 'Expected FSETSTAT'));
        });

        var writer = client.createWriteStream(path_);
        if (writer.cork)
          writer.cork();
        writer.write(data_);
        writer.write(data_);
        writer.write(data_);
        if (writer.uncork)
          writer.uncork();
        writer.end();
      };
    },
    what: 'WriteStream'
  },

// other client request scenarios
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var handle_ = new Buffer('node.js');
        server.on('READDIR', function(id, handle) {
          assert(++self.state.requests === 1,
                 makeMsg(what, 'Saw too many requests'));
          assert(id === 0, makeMsg(what, 'Wrong request id: ' + id));
          assert.deepEqual(handle, handle_, makeMsg(what, 'handle mismatch'));
          server.status(id, STATUS_CODE.EOF);
          server.end();
        });
        client.readdir(handle_, function(err, list) {
          assert(++self.state.responses === 1,
                 makeMsg(what, 'Saw too many responses'));
          assert(err && err.code === STATUS_CODE.EOF,
                 makeMsg(what, 'Expected EOF, got: ' + err));
        });
      };
    },
    what: 'readdir (EOF)'
  },
  { run: function() {
      setup(this);

      var self = this;
      var what = this.what;
      var client = this.client;
      var server = this.server;

      this.onReady = function() {
        var path_ = '/tmp/foo.txt';
        var reqs = 0;
        var continues = 0;

        client.unpipe(server);

        function clientCb(err, handle) {
          assert(++self.state.responses <= reqs,
                 makeMsg(what, 'Saw too many responses'));
          if (self.state.responses === reqs) {
            assert(continues === 1, makeMsg(what, 'no continue event seen'));
            server.end();
          }
        }

        client.on('continue', function() {
          assert(++continues === 1, makeMsg(what, 'saw > 1 continue event'));
        });

        while (true) {
          ++reqs;
          if (!client.open(path_, 'w', clientCb))
            break;
        }

        client.pipe(server);
      };
    },
    expected: {
      requests: -1,
      responses: -1
    },
    what: '"continue" event after push() === false'
  },
  { run: function() {
      var self = this;
      var client = new SFTPStream();
      client.once('ready', function() {
        client.open('/foo/bar', 'w', function(err, handle) {
          assert(err, 'Expected error');
          assert.strictEqual(err.code, 4);
          assert.strictEqual(err.message, 'Uh oh');
          assert.strictEqual(err.lang, '');
          next();
        });
        client.write(new Buffer([
          0, 0, 0, 18,
          101,
          0, 0, 0, 0,
          0, 0, 0, SFTPStream.STATUS_CODE.FAILURE,
          0, 0, 0, 5,  85, 104, 32, 111, 104
        ]));
      });
      client.write(new Buffer([
        0, 0, 0, 5,
        2,
        0, 0, 0, 3
      ]));
    },
    what: 'Can parse status response without language'
  },
  { run: function() {
      var self = this;
      var client = new SFTPStream();
      client.once('ready', function() {
        client.open('/foo/bar', 'w', function(err, handle) {
          assert(err, 'Expected error');
          assert.strictEqual(err.code, 4);
          assert.strictEqual(err.message, 'Failure');
          assert.strictEqual(err.lang, '');
          next();
        });
        client.write(new Buffer([
          0, 0, 0, 9,
          101,
          0, 0, 0, 0,
          0, 0, 0, SFTPStream.STATUS_CODE.FAILURE
        ]));
      });
      client.write(new Buffer([
        0, 0, 0, 5,
        2,
        0, 0, 0, 3
      ]));
    },
    what: 'Can parse status response without message'
  },
];

function setup(self) {
  var expectedRequests = (self.expected && self.expected.requests) || 1;
  var expectedResponses = (self.expected && self.expected.responses) || 1;
  var clientEnded = false;
  var serverEnded = false;

  self.state = {
    clientReady: false,
    serverReady: false,
    requests: 0,
    responses: 0
  };

  self.client = new SFTPStream();
  self.server = new SFTPStream({ server: true });

  self.server.on('error', onError)
             .on('ready', onReady)
             .on('end', onEnd);
  self.client.on('error', onError)
             .on('ready', onReady)
             .on('end', onEnd);

  function onError(err) {
    var which = (this === self.server ? 'server' : 'client');
    assert(false, makeMsg(self.what, 'Unexpected ' + which + ' error: ' + err));
  }
  function onReady() {
    if (this === self.client) {
      assert(!self.state.clientReady,
             makeMsg(self.what, 'Received multiple ready events for client'));
      self.state.clientReady = true;
    } else {
      assert(!self.state.serverReady,
             makeMsg(self.what, 'Received multiple ready events for server'));
      self.state.serverReady = true;
    }
    if (self.state.clientReady && self.state.serverReady)
      self.onReady && self.onReady();
  }
  function onEnd() {
    if (this === self.client) {
      assert(!clientEnded,
             makeMsg(self.what, 'Received multiple close events for client'));
      clientEnded = true;
    } else {
      assert(!serverEnded,
             makeMsg(self.what, 'Received multiple close events for server'));
      serverEnded = true;
    }
    if (clientEnded && serverEnded) {
      var msg;
      if (expectedRequests > 0) {
        msg = 'Expected ' + expectedRequests + ' request(s) but received '
              + self.state.requests;
        assert(self.state.requests === expectedRequests,
               makeMsg(self.what, msg));
      }
      if (expectedResponses > 0) {
        msg = 'Expected ' + expectedResponses + ' response(s) but received '
              + self.state.responses;
        assert(self.state.responses === expectedResponses,
               makeMsg(self.what, msg));
      }
      next();
    }
  }

  process.nextTick(function() {
    self.client.pipe(self.server).pipe(self.client);
  });
}

function flagsToHuman(flags) {
  var ret = [];

  for (var i = 0, keys = Object.keys(OPEN_MODE), len = keys.length; i < len; ++i)
    if (flags & OPEN_MODE[keys[i]])
      ret.push(keys[i]);

  return ret.join(' | ');
}

function next() {
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
