// TODO: support EXTENDED request packets

var TransformStream = require('stream').Transform;
var ReadableStream = require('stream').Readable;
var WritableStream = require('stream').Writable;
var constants = require('fs').constants || process.binding('constants');
var util = require('util');
var inherits = util.inherits;
var isDate = util.isDate;
var listenerCount = require('events').EventEmitter.listenerCount;
var fs = require('fs');

var readString = require('./utils').readString;
var readInt = require('./utils').readInt;

var ATTR = {
  SIZE: 0x00000001,
  UIDGID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACMODTIME: 0x00000008,
  EXTENDED: 0x80000000
};

var STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
};
Object.keys(STATUS_CODE).forEach(function(key) {
  STATUS_CODE[STATUS_CODE[key]] = key;
});
var STATUS_CODE_STR = {
  0: 'No error',
  1: 'End of file',
  2: 'No such file or directory',
  3: 'Permission denied',
  4: 'Failure',
  5: 'Bad message',
  6: 'No connection',
  7: 'Connection lost',
  8: 'Operation unsupported'
};
SFTPStream.STATUS_CODE = STATUS_CODE;

var REQUEST = {
  INIT: 1,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  FSTAT: 8,
  SETSTAT: 9,
  FSETSTAT: 10,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  READLINK: 19,
  SYMLINK: 20,
  EXTENDED: 200
};
Object.keys(REQUEST).forEach(function(key) {
  REQUEST[REQUEST[key]] = key;
});

var RESPONSE = {
  VERSION: 2,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 201
};
Object.keys(RESPONSE).forEach(function(key) {
  RESPONSE[RESPONSE[key]] = key;
});

var OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020
};
SFTPStream.OPEN_MODE = OPEN_MODE;

var MAX_PKT_LEN = 34000;
var MAX_REQID = Math.pow(2, 32) - 1;
var CLIENT_VERSION_BUFFER = new Buffer([0, 0, 0, 5 /* length */,
                                        REQUEST.INIT,
                                        0, 0, 0, 3 /* version */]);
var SERVER_VERSION_BUFFER = new Buffer([0, 0, 0, 5 /* length */,
                                        RESPONSE.VERSION,
                                        0, 0, 0, 3 /* version */]);
/*
  http://tools.ietf.org/html/draft-ietf-secsh-filexfer-02:

     The maximum size of a packet is in practice determined by the client
     (the maximum size of read or write requests that it sends, plus a few
     bytes of packet overhead).  All servers SHOULD support packets of at
     least 34000 bytes (where the packet size refers to the full length,
     including the header above).  This should allow for reads and writes
     of at most 32768 bytes.

  OpenSSH caps this to 256kb instead of the ~34kb as mentioned in the sftpv3
  spec.
*/
var RE_OPENSSH = /^SSH-2.0-(?:OpenSSH|dropbear)/;
var OPENSSH_MAX_DATA_LEN = (256 * 1024) - (2 * 1024)/*account for header data*/;

function DEBUG_NOOP(msg) {}

function SFTPStream(cfg, remoteIdentRaw) {
  if (typeof cfg === 'string' && !remoteIdentRaw) {
    remoteIdentRaw = cfg;
    cfg = undefined;
  }
  if (typeof cfg !== 'object' || !cfg)
    cfg = {};

  TransformStream.call(this, {
    highWaterMark: (typeof cfg.highWaterMark === 'number'
                    ? cfg.highWaterMark
                    : 32 * 1024)
  });

  this.debug = (typeof cfg.debug === 'function' ? cfg.debug : DEBUG_NOOP);
  this.server = (cfg.server ? true : false);
  this._isOpenSSH = (remoteIdentRaw && RE_OPENSSH.test(remoteIdentRaw));
  this._needContinue = false;
  this._state = {
    // common
    status: 'packet_header',
    writeReqid: -1,
    pktLeft: undefined,
    pktHdrBuf: new Buffer(9), // room for pktLen + pktType + req id
    pktBuf: undefined,
    pktType: undefined,
    version: undefined,
    extensions: {},

    // client
    maxDataLen: (this._isOpenSSH ? OPENSSH_MAX_DATA_LEN : 32768),
    requests: {}
  };

  var self = this;
  this.on('end', function() {
    self.readable = false;
  }).on('finish', onFinish)
    .on('prefinish', onFinish);
  function onFinish() {
    self.writable = false;
    self._cleanup(false);
  }

  if (!this.server)
    this.push(CLIENT_VERSION_BUFFER);
}
inherits(SFTPStream, TransformStream);

SFTPStream.prototype.__read = TransformStream.prototype._read;
SFTPStream.prototype._read = function(n) {
  if (this._needContinue) {
    this._needContinue = false;
    this.emit('continue');
  }
  return this.__read(n);
};
SFTPStream.prototype.__push = TransformStream.prototype.push;
SFTPStream.prototype.push = function(chunk, encoding) {
  if (!this.readable)
    return false;
  if (chunk === null)
    this.readable = false;
  var ret = this.__push(chunk, encoding);
  this._needContinue = (ret === false);
  return ret;
};

SFTPStream.prototype._cleanup = function(callback) {
  var state = this._state;

  state.pktBuf = undefined; // give GC something to do

  var requests = state.requests;
  var keys = Object.keys(requests);
  var len = keys.length;
  if (len) {
    if (this.readable) {
      var err = new Error('SFTP session ended early');
      for (var i = 0, cb; i < len; ++i)
        (cb = requests[keys[i]].cb) && cb(err);
    }
    state.requests = {};
  }

  if (this.readable)
    this.push(null);
  else if (!this._readableState.endEmitted && !this._readableState.flowing) {
    // Ugh!
    this.resume();
  }
  if (callback !== false) {
    this.debug('DEBUG[SFTP]: Parser: Malformed packet');
    callback && callback(new Error('Malformed packet'));
  }
};

SFTPStream.prototype._transform = function(chunk, encoding, callback) {
  var state = this._state;
  var server = this.server;
  var status = state.status;
  var pktType = state.pktType;
  var pktBuf = state.pktBuf;
  var pktLeft = state.pktLeft;
  var version = state.version;
  var pktHdrBuf = state.pktHdrBuf;
  var requests = state.requests;
  var debug = this.debug;
  var chunkLen = chunk.length;
  var chunkPos = 0;
  var buffer;
  var chunkLeft;
  var id;

  while (true) {
    if (status === 'discard') {
      chunkLeft = (chunkLen - chunkPos);
      if (pktLeft <= chunkLeft) {
        chunkPos += pktLeft;
        pktLeft = 0;
        status = 'packet_header';
        buffer = pktBuf = undefined;
      } else {
        pktLeft -= chunkLeft;
        break;
      }
    } else if (pktBuf !== undefined) {
      chunkLeft = (chunkLen - chunkPos);
      if (pktLeft <= chunkLeft) {
        chunk.copy(pktBuf,
                   pktBuf.length - pktLeft,
                   chunkPos,
                   chunkPos + pktLeft);
        chunkPos += pktLeft;
        pktLeft = 0;
        buffer = pktBuf;
        pktBuf = undefined;
        continue;
      } else {
        chunk.copy(pktBuf, pktBuf.length - pktLeft, chunkPos);
        pktLeft -= chunkLeft;
        break;
      }
    } else if (status === 'packet_header') {
      if (!buffer) {
        pktLeft = 5;
        pktBuf = pktHdrBuf;
      } else {
        // here we read the right-most 5 bytes from buffer (pktHdrBuf)
        pktLeft = buffer.readUInt32BE(4, true) - 1; // account for type byte
        pktType = buffer[8];

        if (server) {
          if (version === undefined && pktType !== REQUEST.INIT) {
            debug('DEBUG[SFTP]: Parser: Unexpected packet before init');
            status = 'bad_pkt';
          } else if (version !== undefined && pktType === REQUEST.INIT) {
            debug('DEBUG[SFTP]: Parser: Unexpected duplicate init');
            status = 'bad_pkt';
          } else if (pktLeft > MAX_PKT_LEN) {
            debug('DEBUG[SFTP]: Parser: Packet length ('
                  + pktLeft
                  + ') exceeds max length ('
                  + MAX_PKT_LEN
                  + ')');
            status = 'bad_pkt';
          } else if (pktType === REQUEST.EXTENDED)
            status = 'bad_pkt';
          else if (REQUEST[pktType] === undefined) {
            debug('DEBUG[SFTP]: Parser: Unsupported packet type: ' + pktType);
            status = 'discard';
          }
        } else if (version === undefined && pktType !== RESPONSE.VERSION) {
          debug('DEBUG[SFTP]: Parser: Unexpected packet before version');
          status = 'bad_pkt';
        } else if (version !== undefined && pktType === RESPONSE.VERSION) {
          debug('DEBUG[SFTP]: Parser: Unexpected duplicate version');
          status = 'bad_pkt';
        } else if (RESPONSE[pktType] === undefined)
          status = 'discard';

        if (status === 'bad_pkt') {
          // copy original packet info
          pktHdrBuf.writeUInt32BE(pktLeft, 0, true);
          pktHdrBuf[4] = pktType;

          pktLeft = 4;
          pktBuf = pktHdrBuf;
        } else {
          pktBuf = new Buffer(pktLeft);
          status = 'payload';
        }
      }
    } else if (status === 'payload') {
      if (pktType === RESPONSE.VERSION || pktType === REQUEST.INIT) {
        /*
          uint32 version
          <extension data>
        */
        version = state.version = readInt(buffer, 0, this, callback);
        if (version === false)
          return;
        if (version < 3) {
          this._cleanup();
          return callback(new Error('Incompatible SFTP version: ' + version));
        } else if (server)
          this.push(SERVER_VERSION_BUFFER);

        var buflen = buffer.length;
        var extname;
        var extdata;
        buffer._pos = 4;
        while (buffer._pos < buflen) {
          extname = readString(buffer, buffer._pos, 'ascii', this, callback);
          if (extname === false)
            return;
          extdata = readString(buffer, buffer._pos, 'ascii', this, callback);
          if (extdata === false)
            return;
          if (state.extensions[extname])
            state.extensions[extname].push(extdata);
          else
            state.extensions[extname] = [ extdata ];
        }

        this.emit('ready');
      } else {
        /*
          All other packets (client and server) begin with a (client) request
          id:
          uint32     id
        */
        id = readInt(buffer, 0, this, callback);
        if (id === false)
          return;

        var filename;
        var attrs;
        var handle;
        var data;

        if (!server) {
          var req = requests[id];
          var cb = req && req.cb;
          debug('DEBUG[SFTP]: Parser: Response: ' + RESPONSE[pktType]);
          if (req && cb) {
            if (pktType === RESPONSE.STATUS) {
              /*
                uint32     error/status code
                string     error message (ISO-10646 UTF-8)
                string     language tag
              */
              var code = readInt(buffer, 4, this, callback);
              if (code === false)
                return;
              if (code === STATUS_CODE.OK) {
                cb();
              } else {
                // We borrow OpenSSH behavior here, specifically we make the
                // message and language fields optional, despite the
                // specification requiring them (even if they are empty). This
                // helps to avoid problems with buggy implementations that do
                // not fully conform to the SFTP(v3) specification.
                var msg;
                var lang = '';
                if (buffer.length >= 12) {
                  msg = readString(buffer, 8, 'utf8', this, callback);
                  if (msg === false)
                    return;
                  if ((buffer._pos + 4) < buffer.length) {
                    lang = readString(buffer,
                                      buffer._pos,
                                      'ascii',
                                      this,
                                      callback);
                    if (lang === false)
                      return;
                  }
                }
                var err = new Error(msg
                                    || STATUS_CODE_STR[code]
                                    || 'Unknown status');
                err.code = code;
                err.lang = lang;
                cb(err);
              }
            } else if (pktType === RESPONSE.HANDLE) {
              /*
                string     handle
              */
              handle = readString(buffer, 4, this, callback);
              if (handle === false)
                return;
              cb(undefined, handle);
            } else if (pktType === RESPONSE.DATA) {
              /*
                string     data
              */
              if (req.buffer) {
                // we have already pre-allocated space to store the data
                var dataLen = readInt(buffer, 4, this, callback);
                if (dataLen === false)
                  return;
                var reqBufLen = req.buffer.length;
                if (dataLen > reqBufLen) {
                  // truncate response data to fit expected size
                  buffer.writeUInt32BE(reqBufLen, 4, true);
                }
                data = readString(buffer, 4, req.buffer, this, callback);
                if (data === false)
                  return;
                cb(undefined, data, dataLen);
              } else {
                data = readString(buffer, 4, this, callback);
                if (data === false)
                  return;
                cb(undefined, data);
              }
            } else if (pktType === RESPONSE.NAME) {
              /*
                uint32     count
                repeats count times:
                        string     filename
                        string     longname
                        ATTRS      attrs
              */
              var namesLen = readInt(buffer, 4, this, callback);
              if (namesLen === false)
                return;
              var names = [],
                  longname;
              buffer._pos = 8;
              for (var i = 0; i < namesLen; ++i) {
                // we are going to assume UTF-8 for filenames despite the SFTPv3
                // spec not specifying an encoding because the specs for newer
                // versions of the protocol all explicitly specify UTF-8 for
                // filenames
                filename = readString(buffer,
                                      buffer._pos,
                                      'utf8',
                                      this,
                                      callback);
                if (filename === false)
                  return;
                // `longname` only exists in SFTPv3 and since it typically will
                // contain the filename, we assume it is also UTF-8
                longname = readString(buffer,
                                      buffer._pos,
                                      'utf8',
                                      this,
                                      callback);
                if (longname === false)
                  return;
                attrs = readAttrs(buffer, buffer._pos, this, callback);
                if (attrs === false)
                  return;
                names.push({
                  filename: filename,
                  longname: longname,
                  attrs: attrs
                });
              }
              cb(undefined, names);
            } else if (pktType === RESPONSE.ATTRS) {
              /*
                ATTRS      attrs
              */
              attrs = readAttrs(buffer, 4, this, callback);
              if (attrs === false)
                return;
              cb(undefined, attrs);
            } else if (pktType === RESPONSE.EXTENDED) {
              if (req.extended) {
                switch (req.extended) {
                  case 'statvfs@openssh.com':
                  case 'fstatvfs@openssh.com':
                    /*
                      uint64    f_bsize   // file system block size
                      uint64    f_frsize  // fundamental fs block size
                      uint64    f_blocks  // number of blocks (unit f_frsize)
                      uint64    f_bfree   // free blocks in file system
                      uint64    f_bavail  // free blocks for non-root
                      uint64    f_files   // total file inodes
                      uint64    f_ffree   // free file inodes
                      uint64    f_favail  // free file inodes for to non-root
                      uint64    f_fsid    // file system id
                      uint64    f_flag    // bit mask of f_flag values
                      uint64    f_namemax // maximum filename length
                    */
                    var stats = {
                      f_bsize: undefined,
                      f_frsize: undefined,
                      f_blocks: undefined,
                      f_bfree: undefined,
                      f_bavail: undefined,
                      f_files: undefined,
                      f_ffree: undefined,
                      f_favail: undefined,
                      f_sid: undefined,
                      f_flag: undefined,
                      f_namemax: undefined
                    };
                    stats.f_bsize = readUInt64BE(buffer, 4, this, callback);
                    if (stats.f_bsize === false)
                      return;
                    stats.f_frsize = readUInt64BE(buffer, 12, this, callback);
                    if (stats.f_frsize === false)
                      return;
                    stats.f_blocks = readUInt64BE(buffer, 20, this, callback);
                    if (stats.f_blocks === false)
                      return;
                    stats.f_bfree = readUInt64BE(buffer, 28, this, callback);
                    if (stats.f_bfree === false)
                      return;
                    stats.f_bavail = readUInt64BE(buffer, 36, this, callback);
                    if (stats.f_bavail === false)
                      return;
                    stats.f_files = readUInt64BE(buffer, 44, this, callback);
                    if (stats.f_files === false)
                      return;
                    stats.f_ffree = readUInt64BE(buffer, 52, this, callback);
                    if (stats.f_ffree === false)
                      return;
                    stats.f_favail = readUInt64BE(buffer, 60, this, callback);
                    if (stats.f_favail === false)
                      return;
                    stats.f_sid = readUInt64BE(buffer, 68, this, callback);
                    if (stats.f_sid === false)
                      return;
                    stats.f_flag = readUInt64BE(buffer, 76, this, callback);
                    if (stats.f_flag === false)
                      return;
                    stats.f_namemax = readUInt64BE(buffer, 84, this, callback);
                    if (stats.f_namemax === false)
                      return;
                    cb(undefined, stats);
                  break;
                }
              }
              // XXX: at least provide the raw buffer data to the callback in
              // case of unexpected extended response?
              cb();
            }
          }
          if (req)
            delete requests[id];
        } else {
          // server
          var evName = REQUEST[pktType];
          var offset;
          var path;

          debug('DEBUG[SFTP]: Parser: Request: ' + evName);
          if (listenerCount(this, evName)) {
            if (pktType === REQUEST.OPEN) {
              /*
                string        filename
                uint32        pflags
                ATTRS         attrs
              */
              filename = readString(buffer, 4, 'utf8', this, callback);
              if (filename === false)
                return;
              var pflags = readInt(buffer, buffer._pos, this, callback);
              if (pflags === false)
                return;
              attrs = readAttrs(buffer, buffer._pos + 4, this, callback);
              if (attrs === false)
                return;
              this.emit(evName, id, filename, pflags, attrs);
            } else if (pktType === REQUEST.CLOSE
                       || pktType === REQUEST.FSTAT
                       || pktType === REQUEST.READDIR) {
              /*
                string     handle
              */
              handle = readString(buffer, 4, this, callback);
              if (handle === false)
                return;
              this.emit(evName, id, handle);
            } else if (pktType === REQUEST.READ) {
              /*
                string     handle
                uint64     offset
                uint32     len
              */
              handle = readString(buffer, 4, this, callback);
              if (handle === false)
                return;
              offset = readUInt64BE(buffer, buffer._pos, this, callback);
              if (offset === false)
                return;
              var len = readInt(buffer, buffer._pos, this, callback);
              if (len === false)
                return;
              this.emit(evName, id, handle, offset, len);
            } else if (pktType === REQUEST.WRITE) {
              /*
                string     handle
                uint64     offset
                string     data
              */
              handle = readString(buffer, 4, this, callback);
              if (handle === false)
                return;
              offset = readUInt64BE(buffer, buffer._pos, this, callback);
              if (offset === false)
                return;
              data = readString(buffer, buffer._pos, this, callback);
              if (data === false)
                return;
              this.emit(evName, id, handle, offset, data);
            } else if (pktType === REQUEST.LSTAT
                       || pktType === REQUEST.STAT
                       || pktType === REQUEST.OPENDIR
                       || pktType === REQUEST.REMOVE
                       || pktType === REQUEST.RMDIR
                       || pktType === REQUEST.REALPATH
                       || pktType === REQUEST.READLINK) {
              /*
                string     path
              */
              path = readString(buffer, 4, 'utf8', this, callback);
              if (path === false)
                return;
              this.emit(evName, id, path);
            } else if (pktType === REQUEST.SETSTAT
                       || pktType === REQUEST.MKDIR) {
              /*
                string     path
                ATTRS      attrs
              */
              path = readString(buffer, 4, 'utf8', this, callback);
              if (path === false)
                return;
              attrs = readAttrs(buffer, buffer._pos, this, callback);
              if (attrs === false)
                return;
              this.emit(evName, id, path, attrs);
            } else if (pktType === REQUEST.FSETSTAT) {
              /*
                string     handle
                ATTRS      attrs
              */
              handle = readString(buffer, 4, this, callback);
              if (handle === false)
                return;
              attrs = readAttrs(buffer, buffer._pos, this, callback);
              if (attrs === false)
                return;
              this.emit(evName, id, handle, attrs);
            } else if (pktType === REQUEST.RENAME
                       || pktType === REQUEST.SYMLINK) {
              /*
                RENAME:
                  string     oldpath
                  string     newpath
                SYMLINK:
                  string     linkpath
                  string     targetpath
              */
              var str1;
              var str2;
              str1 = readString(buffer, 4, 'utf8', this, callback);
              if (str1 === false)
                return;
              str2 = readString(buffer, buffer._pos, 'utf8', this, callback);
              if (str2 === false)
                return;
              if (pktType === REQUEST.SYMLINK && this._isOpenSSH) {
                // OpenSSH has linkpath and targetpath positions switched
                this.emit(evName, id, str2, str1);
              } else
                this.emit(evName, id, str1, str2);
            }
          } else {
            // automatically reject request if no handler for request type
            this.status(id, STATUS_CODE.OP_UNSUPPORTED);
          }
        }
      }

      // prepare for next packet
      status = 'packet_header';
      buffer = pktBuf = undefined;
    } else if (status === 'bad_pkt') {
      if (server && buffer[4] !== REQUEST.INIT) {
        var errCode = (buffer[4] === REQUEST.EXTENDED
                       ? STATUS_CODE.OP_UNSUPPORTED
                       : STATUS_CODE.FAILURE);

        // no request id for init/version packets, so we have no way to send a
        // status response, so we just close up shop ...
        if (buffer[4] === REQUEST.INIT || buffer[4] === RESPONSE.VERSION)
          return this._cleanup(callback);

        id = readInt(buffer, 5, this, callback);
        if (id === false)
          return;
        this.status(id, errCode);
      }

      // by this point we have already read the type byte and the id bytes, so
      // we subtract those from the number of bytes to skip
      pktLeft = buffer.readUInt32BE(0, true) - 5;

      status = 'discard';
    }

    if (chunkPos >= chunkLen)
      break;
  }

  state.status = status;
  state.pktType = pktType;
  state.pktBuf = pktBuf;
  state.pktLeft = pktLeft;
  state.version = version;

  callback();
};

// client
SFTPStream.prototype.createReadStream = function(path, options) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  return new ReadStream(this, path, options);
};
SFTPStream.prototype.createWriteStream = function(path, options) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  return new WriteStream(this, path, options);
};
SFTPStream.prototype.open = function(path, flags_, attrs, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  if (typeof attrs === 'function') {
    cb = attrs;
    attrs = undefined;
  }

  var flags = stringToFlags(flags_);
  if (flags === null)
    throw new Error('Unknown flags string: ' + flags_);

  var attrFlags = 0;
  var attrBytes = 0;
  if (typeof attrs === 'string' || typeof attrs === 'number') {
    attrs = { mode: attrs };
  }
  if (typeof attrs === 'object') {
    attrs = attrsToBytes(attrs);
    attrFlags = attrs.flags;
    attrBytes = attrs.nbytes;
    attrs = attrs.bytes;
  }

  /*
    uint32        id
    string        filename
    uint32        pflags
    ATTRS         attrs
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen + 4 + 4 + attrBytes);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.OPEN;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');
  buf.writeUInt32BE(flags, p += pathlen, true);
  buf.writeUInt32BE(attrFlags, p += 4, true);
  if (attrs && attrFlags) {
    p += 4;
    for (var i = 0, len = attrs.length; i < len; ++i)
      for (var j = 0, len2 = attrs[i].length; j < len2; ++j)
        buf[p++] = attrs[i][j];
  }
  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing OPEN');
  return this.push(buf);
};
SFTPStream.prototype.close = function(handle, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  var state = this._state;

  /*
    uint32     id
    string     handle
  */
  var handlelen = handle.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + handlelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.CLOSE;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(handlelen, p, true);
  handle.copy(buf, p += 4);

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing CLOSE');
  return this.push(buf);
};
SFTPStream.prototype.readData = function(handle, buf, off, len, position, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');
  else if (!Buffer.isBuffer(buf))
    throw new Error('buffer is not a Buffer');
  else if (off >= buf.length)
    throw new Error('offset is out of bounds');
  else if (off + len > buf.length)
    throw new Error('length extends beyond buffer');
  else if (position === null)
    throw new Error('null position currently unsupported');

  var state = this._state;

  /*
    uint32     id
    string     handle
    uint64     offset
    uint32     len
  */
  var handlelen = handle.length;
  var p = 9;
  var pos = position;
  var out = new Buffer(4 + 1 + 4 + 4 + handlelen + 8 + 4);

  out.writeUInt32BE(out.length - 4, 0, true);
  out[4] = REQUEST.READ;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  out.writeUInt32BE(reqid, 5, true);

  out.writeUInt32BE(handlelen, p, true);
  handle.copy(out, p += 4);
  p += handlelen;
  for (var i = 7; i >= 0; --i) {
    out[p + i] = pos & 0xFF;
    pos /= 256;
  }
  out.writeUInt32BE(len, p += 8, true);

  state.requests[reqid] = {
    cb: function(err, data, nb) {
      if (err && err.code !== STATUS_CODE.EOF)
        return cb(err);
      cb(undefined, nb || 0, data, position);
    },
    buffer: buf.slice(off, off + len)
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing READ');
  return this.push(out);
};
SFTPStream.prototype.writeData = function(handle, buf, off, len, position, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');
  else if (!Buffer.isBuffer(buf))
    throw new Error('buffer is not a Buffer');
  else if (off > buf.length)
    throw new Error('offset is out of bounds');
  else if (off + len > buf.length)
    throw new Error('length extends beyond buffer');
  else if (position === null)
    throw new Error('null position currently unsupported');

  var self = this;
  var state = this._state;

  if (!len) {
    cb && process.nextTick(function() { cb(undefined, 0); });
    return;
  }

  var overflow = (len > state.maxDataLen
                  ? len - state.maxDataLen
                  : 0);
  var origPosition = position;

  if (overflow)
    len = state.maxDataLen;

  /*
    uint32     id
    string     handle
    uint64     offset
    string     data
  */
  var handlelen = handle.length;
  var p = 9;
  var out = new Buffer(4 + 1 + 4 + 4 + handlelen + 8 + 4 + len);

  out.writeUInt32BE(out.length - 4, 0, true);
  out[4] = REQUEST.WRITE;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  out.writeUInt32BE(reqid, 5, true);

  out.writeUInt32BE(handlelen, p, true);
  handle.copy(out, p += 4);
  p += handlelen;
  for (var i = 7; i >= 0; --i) {
    out[p + i] = position & 0xFF;
    position /= 256;
  }
  out.writeUInt32BE(len, p += 8, true);
  buf.copy(out, p += 4, off, off + len);

  state.requests[reqid] = {
    cb: function(err) {
      if (err)
        cb && cb(err);
      else if (overflow) {
        self.writeData(handle,
                       buf,
                       off + len,
                       overflow,
                       origPosition + len,
                       cb);
      } else
        cb && cb(undefined, off + len);
    }
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing WRITE');
  return this.push(out);
};
function tryCreateBuffer(size) {
  try {
    return new Buffer(size);
  } catch (ex) {
    return ex;
  }
}
function fastXfer(src, dst, srcPath, dstPath, opts, cb) {
  var concurrency = 64;
  var chunkSize = 32768;
  //var preserve = false;
  var onstep;
  var mode;

  if (typeof opts === 'function') {
    cb = opts;
  } else if (typeof opts === 'object') {
    if (typeof opts.concurrency === 'number'
        && opts.concurrency > 0
        && !isNaN(opts.concurrency))
      concurrency = opts.concurrency;
    if (typeof opts.chunkSize === 'number'
        && opts.chunkSize > 0
        && !isNaN(opts.chunkSize))
      chunkSize = opts.chunkSize;
    if (typeof opts.step === 'function')
      onstep = opts.step;
    //preserve = (opts.preserve ? true : false);
    if (typeof opts.mode === 'string' || typeof opts.mode === 'number')
      mode = modeNum(opts.mode);
  }

  // internal state variables
  var fsize;
  var chunk;
  var psrc = 0;
  var pdst = 0;
  var reads = 0;
  var total = 0;
  var hadError = false;
  var srcHandle;
  var dstHandle;
  var readbuf;
  var bufsize = chunkSize * concurrency;

  function onerror(err) {
    if (hadError)
      return;

    hadError = true;

    var left = 0;
    var cbfinal;

    if (srcHandle || dstHandle) {
      cbfinal = function() {
        if (--left === 0)
          cb(err);
      };
      if (srcHandle && (src === fs || src.writable))
        ++left;
      if (dstHandle && (dst === fs || dst.writable))
        ++left;
      if (srcHandle && (src === fs || src.writable))
        src.close(srcHandle, cbfinal);
      if (dstHandle && (dst === fs || dst.writable))
        dst.close(dstHandle, cbfinal);
    } else
      cb(err);
  }

  src.open(srcPath, 'r', function(err, sourceHandle) {
    if (err)
      return onerror(err);

    srcHandle = sourceHandle;

    src.fstat(srcHandle, function tryStat(err, attrs) {
      if (err) {
        if (src !== fs) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          src.stat(srcPath, function(err_, attrs_) {
            if (err_)
              return onerror(err);
            tryStat(null, attrs_);
          });
          return;
        }
        return onerror(err);
      }
      fsize = attrs.size;

      dst.open(dstPath, 'w', function(err, destHandle) {
        if (err)
          return onerror(err);

        dstHandle = destHandle;

        if (fsize <= 0)
          return onerror();

        // Use less memory where possible
        while (bufsize > fsize) {
          if (concurrency === 1) {
            bufsize = fsize;
            break;
          }
          bufsize -= chunkSize;
          --concurrency;
        }

        readbuf = tryCreateBuffer(bufsize);
        if (readbuf instanceof Error)
          return onerror(readbuf);

        if (mode !== undefined) {
          dst.fchmod(dstHandle, mode, function tryAgain(err) {
            if (err) {
              // Try chmod() for sftp servers that may not support fchmod() for
              // whatever reason
              dst.chmod(dstPath, mode, function(err_) {
                tryAgain();
              });
              return;
            }
            read();
          });
        } else {
          read();
        }

        function onread(err, nb, data, dstpos, datapos) {
          if (err)
            return onerror(err);

          if (src === fs)
            dst.writeData(dstHandle, data, datapos || 0, nb, dstpos, writeCb);
          else
            dst.write(dstHandle, data, datapos || 0, nb, dstpos, writeCb);

          function writeCb(err) {
            if (err)
              return onerror(err);

            total += nb;
            onstep && onstep(total, nb, fsize);

            if (--reads === 0) {
              if (total === fsize) {
                dst.close(dstHandle, function(err) {
                  dstHandle = undefined;
                  if (err)
                    return onerror(err);
                  src.close(srcHandle, function(err) {
                    srcHandle = undefined;
                    if (err)
                      return onerror(err);
                    cb();
                  });
                });
              } else
                read();
            }
          }
        }

        function makeCb(psrc, pdst) {
          return function(err, nb, data) {
            onread(err, nb, data, pdst, psrc);
          };
        }

        function read() {
          while (pdst < fsize && reads < concurrency) {
            chunk = (pdst + chunkSize > fsize ? fsize - pdst : chunkSize);
            if (src === fs) {
              src.read(srcHandle,
                       readbuf,
                       psrc,
                       chunk,
                       pdst,
                       makeCb(psrc, pdst));
            } else
              src.readData(srcHandle, readbuf, psrc, chunk, pdst, onread);
            psrc += chunk;
            pdst += chunk;
            ++reads;
          }
          psrc = 0;
        }
      });
    });
  });
}
SFTPStream.prototype.fastGet = function(remotePath, localPath, opts, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  fastXfer(this, fs, remotePath, localPath, opts, cb);
};
SFTPStream.prototype.fastPut = function(localPath, remotePath, opts, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  fastXfer(fs, this, localPath, remotePath, opts, cb);
};
SFTPStream.prototype.readFile = function(path, options, callback_) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var callback;
  if (typeof callback_ === 'function') {
    callback = callback_;
  } else if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  var self = this;

  if (typeof options === 'string')
    options = { encoding: options, flag: 'r' };
  else if (!options)
    options = { encoding: null, flag: 'r' };
  else if (typeof options !== 'object')
    throw new TypeError('Bad arguments');

  var encoding = options.encoding;
  if (encoding && !Buffer.isEncoding(encoding))
    throw new Error('Unknown encoding: ' + encoding);

  // first, stat the file, so we know the size.
  var size;
  var buffer; // single buffer with file data
  var buffers; // list for when size is unknown
  var pos = 0;
  var handle;

  // SFTPv3 does not support using -1 for read position, so we have to track
  // read position manually
  var bytesRead = 0;

  var flag = options.flag || 'r';
  this.open(path, flag, 438 /*=0666*/, function(er, handle_) {
    if (er)
      return callback && callback(er);
    handle = handle_;

    self.fstat(handle, function tryStat(er, st) {
      if (er) {
        // Try stat() for sftp servers that may not support fstat() for
        // whatever reason
        self.stat(path, function(er_, st_) {
          if (er_) {
            return self.close(handle, function() {
              callback && callback(er);
            });
          }
          tryStat(null, st_);
        });
        return;
      }

      size = st.size;
      if (size === 0) {
        // the kernel lies about many files.
        // Go ahead and try to read some bytes.
        buffers = [];
        return read();
      }

      buffer = new Buffer(size);
      read();
    });
  });

  function read() {
    if (size === 0) {
      buffer = new Buffer(8192);
      self.readData(handle, buffer, 0, 8192, bytesRead, afterRead);
    } else
      self.readData(handle, buffer, pos, size - pos, bytesRead, afterRead);
  }

  function afterRead(er, nbytes) {
    if (er) {
      return self.close(handle, function() {
        return callback && callback(er);
      });
    }

    if (nbytes === 0)
      return close();

    bytesRead += nbytes;
    pos += nbytes;
    if (size !== 0) {
      if (pos === size)
        close();
      else
        read();
    } else {
      // unknown size, just read until we don't get bytes.
      buffers.push(buffer.slice(0, nbytes));
      read();
    }
  }

  function close() {
    self.close(handle, function(er) {
      if (size === 0) {
        // collected the data into the buffers list.
        buffer = Buffer.concat(buffers, pos);
      } else if (pos < size)
        buffer = buffer.slice(0, pos);

      if (encoding)
        buffer = buffer.toString(encoding);
      return callback && callback(er, buffer);
    });
  }
};
function writeAll(self, handle, buffer, offset, length, position, callback_) {
  var callback = (typeof callback_ === 'function' ? callback_ : undefined);

  self.writeData(handle,
                 buffer,
                 offset,
                 length,
                 position,
                 function(writeErr, written) {
    if (writeErr) {
      return self.close(handle, function() {
        callback && callback(writeErr);
      });
    }
    if (written === length)
      self.close(handle, callback);
    else {
      offset += written;
      length -= written;
      position += written;
      writeAll(self, handle, buffer, offset, length, position, callback);
    }
  });
}
SFTPStream.prototype.writeFile = function(path, data, options, callback_) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var callback;
  if (typeof callback_ === 'function') {
    callback = callback_;
  } else if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  var self = this;

  if (typeof options === 'string')
    options = { encoding: options, mode: 438, flag: 'w' };
  else if (!options)
    options = { encoding: 'utf8', mode: 438 /*=0666*/, flag: 'w' };
  else if (typeof options !== 'object')
    throw new TypeError('Bad arguments');

  if (options.encoding && !Buffer.isEncoding(options.encoding))
    throw new Error('Unknown encoding: ' + options.encoding);

  var flag = options.flag || 'w';
  this.open(path, flag, options.mode, function(openErr, handle) {
    if (openErr)
      callback && callback(openErr);
    else {
      var buffer = (Buffer.isBuffer(data)
                    ? data
                    : new Buffer('' + data, options.encoding || 'utf8'));
      var position = (/a/.test(flag) ? null : 0);

      // SFTPv3 does not support the notion of 'current position'
      // (null position), so we just attempt to append to the end of the file
      // instead
      if (position === null) {
        self.fstat(handle, function tryStat(er, st) {
          if (er) {
            // Try stat() for sftp servers that may not support fstat() for
            // whatever reason
            self.stat(path, function(er_, st_) {
              if (er_) {
                return self.close(handle, function() {
                  callback && callback(er);
                });
              }
              tryStat(null, st_);
            });
            return;
          }
          writeAll(self, handle, buffer, 0, buffer.length, st.size, callback);
        });
        return;
      }
      writeAll(self, handle, buffer, 0, buffer.length, position, callback);
    }
  });
};
SFTPStream.prototype.appendFile = function(path, data, options, callback_) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var callback;
  if (typeof callback_ === 'function') {
    callback = callback_;
  } else if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  if (typeof options === 'string')
    options = { encoding: options, mode: 438, flag: 'a' };
  else if (!options)
    options = { encoding: 'utf8', mode: 438 /*=0666*/, flag: 'a' };
  else if (typeof options !== 'object')
    throw new TypeError('Bad arguments');

  if (!options.flag)
    options = util._extend({ flag: 'a' }, options);
  this.writeFile(path, data, options, callback);
};
SFTPStream.prototype.exists = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  this.stat(path, function(err) {
    cb && cb(err ? false : true);
  });
};
SFTPStream.prototype.unlink = function(filename, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     filename
  */
  var fnamelen = Buffer.byteLength(filename);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + fnamelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.REMOVE;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(fnamelen, p, true);
  buf.write(filename, p += 4, fnamelen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing REMOVE');
  return this.push(buf);
};
SFTPStream.prototype.rename = function(oldPath, newPath, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     oldpath
    string     newpath
  */
  var oldlen = Buffer.byteLength(oldPath);
  var newlen = Buffer.byteLength(newPath);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + oldlen + 4 + newlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.RENAME;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(oldlen, p, true);
  buf.write(oldPath, p += 4, oldlen, 'utf8');
  buf.writeUInt32BE(newlen, p += oldlen, true);
  buf.write(newPath, p += 4, newlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing RENAME');
  return this.push(buf);
};
SFTPStream.prototype.mkdir = function(path, attrs, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var flags = 0;
  var attrBytes = 0;
  var state = this._state;

  if (typeof attrs === 'function') {
    cb = attrs;
    attrs = undefined;
  }
  if (typeof attrs === 'object') {
    attrs = attrsToBytes(attrs);
    flags = attrs.flags;
    attrBytes = attrs.nbytes;
    attrs = attrs.bytes;
  }

  /*
    uint32     id
    string     path
    ATTRS      attrs
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen + 4 + attrBytes);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.MKDIR;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');
  buf.writeUInt32BE(flags, p += pathlen);
  if (flags) {
    p += 4;
    for (var i = 0, len = attrs.length; i < len; ++i)
      for (var j = 0, len2 = attrs[i].length; j < len2; ++j)
        buf[p++] = attrs[i][j];
  }

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing MKDIR');
  return this.push(buf);
};
SFTPStream.prototype.rmdir = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.RMDIR;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing RMDIR');
  return this.push(buf);
};
SFTPStream.prototype.readdir = function(where, opts, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;
  var doFilter;

  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (typeof opts !== 'object')
    opts = {};

  doFilter = (opts && opts.full ? false : true);

  if (!Buffer.isBuffer(where) && typeof where !== 'string')
    throw new Error('missing directory handle or path');

  if (typeof where === 'string') {
    var self = this;
    var entries = [];
    var e = 0;

    return this.opendir(where, function reread(err, handle) {
      if (err)
        return cb(err);

      self.readdir(handle, opts, function(err, list) {
        var eof = (err && err.code === STATUS_CODE.EOF);

        if (err && !eof) {
          return self.close(handle, function() {
            cb(err);
          });
        } else if (eof) {
          return self.close(handle, function(err) {
            if (err)
              return cb(err);
            cb(undefined, entries);
          });
        }

        for (var i = 0, len = list.length; i < len; ++i, ++e)
          entries[e] = list[i];

        reread(undefined, handle);
      });
    });
  }

  /*
    uint32     id
    string     handle
  */
  var handlelen = where.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + handlelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.READDIR;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(handlelen, p, true);
  where.copy(buf, p += 4);

  state.requests[reqid] = {
    cb: (doFilter
         ? function(err, list) {
             if (err)
               return cb(err);

             for (var i = list.length - 1; i >= 0; --i) {
               if (list[i].filename === '.' || list[i].filename === '..')
                 list.splice(i, 1);
             }

             cb(undefined, list);
           }
         : cb)
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing READDIR');
  return this.push(buf);
};
SFTPStream.prototype.fstat = function(handle, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  var state = this._state;

  /*
    uint32     id
    string     handle
  */
  var handlelen = handle.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + handlelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.FSTAT;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(handlelen, p, true);
  handle.copy(buf, p += 4);

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing FSTAT');
  return this.push(buf);
};
SFTPStream.prototype.stat = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.STAT;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing STAT');
  return this.push(buf);
};
SFTPStream.prototype.lstat = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.LSTAT;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing LSTAT');
  return this.push(buf);
};
SFTPStream.prototype.opendir = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.OPENDIR;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing OPENDIR');
  return this.push(buf);
};
SFTPStream.prototype.setstat = function(path, attrs, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var flags = 0;
  var attrBytes = 0;
  var state = this._state;

  if (typeof attrs === 'object') {
    attrs = attrsToBytes(attrs);
    flags = attrs.flags;
    attrBytes = attrs.nbytes;
    attrs = attrs.bytes;
  } else if (typeof attrs === 'function')
    cb = attrs;

  /*
    uint32     id
    string     path
    ATTRS      attrs
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen + 4 + attrBytes);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.SETSTAT;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');
  buf.writeUInt32BE(flags, p += pathlen);
  if (flags) {
    p += 4;
    for (var i = 0, len = attrs.length; i < len; ++i)
      for (var j = 0, len2 = attrs[i].length; j < len2; ++j)
        buf[p++] = attrs[i][j];
  }

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing SETSTAT');
  return this.push(buf);
};
SFTPStream.prototype.fsetstat = function(handle, attrs, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  var flags = 0;
  var attrBytes = 0;
  var state = this._state;

  if (typeof attrs === 'object') {
    attrs = attrsToBytes(attrs);
    flags = attrs.flags;
    attrBytes = attrs.nbytes;
    attrs = attrs.bytes;
  } else if (typeof attrs === 'function')
    cb = attrs;

  /*
    uint32     id
    string     handle
    ATTRS      attrs
  */
  var handlelen = handle.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + handlelen + 4 + attrBytes);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.FSETSTAT;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(handlelen, p, true);
  handle.copy(buf, p += 4);
  buf.writeUInt32BE(flags, p += handlelen);
  if (flags) {
    p += 4;
    for (var i = 0, len = attrs.length; i < len; ++i)
      for (var j = 0, len2 = attrs[i].length; j < len2; ++j)
        buf[p++] = attrs[i][j];
  }

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing FSETSTAT');
  return this.push(buf);
};
SFTPStream.prototype.futimes = function(handle, atime, mtime, cb) {
  return this.fsetstat(handle, {
    atime: toUnixTimestamp(atime),
    mtime: toUnixTimestamp(mtime)
  }, cb);
};
SFTPStream.prototype.utimes = function(path, atime, mtime, cb) {
  return this.setstat(path, {
    atime: toUnixTimestamp(atime),
    mtime: toUnixTimestamp(mtime)
  }, cb);
};
SFTPStream.prototype.fchown = function(handle, uid, gid, cb) {
  return this.fsetstat(handle, {
    uid: uid,
    gid: gid
  }, cb);
};
SFTPStream.prototype.chown = function(path, uid, gid, cb) {
  return this.setstat(path, {
    uid: uid,
    gid: gid
  }, cb);
};
SFTPStream.prototype.fchmod = function(handle, mode, cb) {
  return this.fsetstat(handle, {
    mode: mode
  }, cb);
};
SFTPStream.prototype.chmod = function(path, mode, cb) {
  return this.setstat(path, {
    mode: mode
  }, cb);
};
SFTPStream.prototype.readlink = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.READLINK;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = {
    cb: function(err, names) {
      if (err)
        return cb(err);
      else if (!names || !names.length)
        return cb(new Error('Response missing link info'));
      cb(undefined, names[0].filename);
    }
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing READLINK');
  return this.push(buf);
};
SFTPStream.prototype.symlink = function(targetPath, linkPath, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     linkpath
    string     targetpath
  */
  var linklen = Buffer.byteLength(linkPath);
  var targetlen = Buffer.byteLength(targetPath);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + linklen + 4 + targetlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.SYMLINK;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  if (this._isOpenSSH) {
    // OpenSSH has linkpath and targetpath positions switched
    buf.writeUInt32BE(targetlen, p, true);
    buf.write(targetPath, p += 4, targetlen, 'utf8');
    buf.writeUInt32BE(linklen, p += targetlen, true);
    buf.write(linkPath, p += 4, linklen, 'utf8');
  } else {
    buf.writeUInt32BE(linklen, p, true);
    buf.write(linkPath, p += 4, linklen, 'utf8');
    buf.writeUInt32BE(targetlen, p += linklen, true);
    buf.write(targetPath, p += 4, targetlen, 'utf8');
  }

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing SYMLINK');
  return this.push(buf);
};
SFTPStream.prototype.realpath = function(path, cb) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var state = this._state;

  /*
    uint32     id
    string     path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.REALPATH;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = {
    cb: function(err, names) {
      if (err)
        return cb(err);
      else if (!names || !names.length)
        return cb(new Error('Response missing path info'));
      cb(undefined, names[0].filename);
    }
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing REALPATH');
  return this.push(buf);
};
// extended requests
SFTPStream.prototype.ext_openssh_rename = function(oldPath, newPath, cb) {
  var state = this._state;

  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!state.extensions['posix-rename@openssh.com']
           || state.extensions['posix-rename@openssh.com'].indexOf('1') === -1)
    throw new Error('Server does not support this extended request');

  /*
    uint32    id
    string    "posix-rename@openssh.com"
    string    oldpath
    string    newpath
  */
  var oldlen = Buffer.byteLength(oldPath);
  var newlen = Buffer.byteLength(newPath);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + 24 + 4 + oldlen + 4 + newlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.EXTENDED;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);
  buf.writeUInt32BE(24, p, true);
  buf.write('posix-rename@openssh.com', p += 4, 24, 'ascii');

  buf.writeUInt32BE(oldlen, p += 24, true);
  buf.write(oldPath, p += 4, oldlen, 'utf8');
  buf.writeUInt32BE(newlen, p += oldlen, true);
  buf.write(newPath, p += 4, newlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing posix-rename@openssh.com');
  return this.push(buf);
};
SFTPStream.prototype.ext_openssh_statvfs = function(path, cb) {
  var state = this._state;

  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!state.extensions['statvfs@openssh.com']
           || state.extensions['statvfs@openssh.com'].indexOf('2') === -1)
    throw new Error('Server does not support this extended request');

  /*
    uint32    id
    string    "statvfs@openssh.com"
    string    path
  */
  var pathlen = Buffer.byteLength(path);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + 19 + 4 + pathlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.EXTENDED;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);
  buf.writeUInt32BE(19, p, true);
  buf.write('statvfs@openssh.com', p += 4, 19, 'ascii');

  buf.writeUInt32BE(pathlen, p += 19, true);
  buf.write(path, p += 4, pathlen, 'utf8');

  state.requests[reqid] = {
    extended: 'statvfs@openssh.com',
    cb: cb
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing statvfs@openssh.com');
  return this.push(buf);
};
SFTPStream.prototype.ext_openssh_fstatvfs = function(handle, cb) {
  var state = this._state;

  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!state.extensions['fstatvfs@openssh.com']
           || state.extensions['fstatvfs@openssh.com'].indexOf('2') === -1)
    throw new Error('Server does not support this extended request');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  /*
    uint32    id
    string    "fstatvfs@openssh.com"
    string    handle
  */
  var handlelen = handle.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + 20 + 4 + handlelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.EXTENDED;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);
  buf.writeUInt32BE(20, p, true);
  buf.write('fstatvfs@openssh.com', p += 4, 20, 'ascii');

  buf.writeUInt32BE(handlelen, p += 20, true);
  buf.write(handle, p += 4, handlelen, 'utf8');

  state.requests[reqid] = {
    extended: 'fstatvfs@openssh.com',
    cb: cb
  };

  this.debug('DEBUG[SFTP]: Outgoing: Writing fstatvfs@openssh.com');
  return this.push(buf);
};
SFTPStream.prototype.ext_openssh_hardlink = function(oldPath, newPath, cb) {
  var state = this._state;

  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!state.extensions['hardlink@openssh.com']
           || state.extensions['hardlink@openssh.com'].indexOf('1') === -1)
    throw new Error('Server does not support this extended request');

  /*
    uint32    id
    string    "hardlink@openssh.com"
    string    oldpath
    string    newpath
  */
  var oldlen = Buffer.byteLength(oldPath);
  var newlen = Buffer.byteLength(newPath);
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + 20 + 4 + oldlen + 4 + newlen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.EXTENDED;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);
  buf.writeUInt32BE(20, p, true);
  buf.write('hardlink@openssh.com', p += 4, 20, 'ascii');

  buf.writeUInt32BE(oldlen, p += 20, true);
  buf.write(oldPath, p += 4, oldlen, 'utf8');
  buf.writeUInt32BE(newlen, p += oldlen, true);
  buf.write(newPath, p += 4, newlen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing hardlink@openssh.com');
  return this.push(buf);
};
SFTPStream.prototype.ext_openssh_fsync = function(handle, cb) {
  var state = this._state;

  if (this.server)
    throw new Error('Client-only method called in server mode');
  else if (!state.extensions['fsync@openssh.com']
           || state.extensions['fsync@openssh.com'].indexOf('1') === -1)
    throw new Error('Server does not support this extended request');
  else if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  /*
    uint32    id
    string    "fsync@openssh.com"
    string    handle
  */
  var handlelen = handle.length;
  var p = 9;
  var buf = new Buffer(4 + 1 + 4 + 4 + 17 + 4 + handlelen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = REQUEST.EXTENDED;
  var reqid = state.writeReqid = (state.writeReqid + 1) % MAX_REQID;
  buf.writeUInt32BE(reqid, 5, true);
  buf.writeUInt32BE(17, p, true);
  buf.write('fsync@openssh.com', p += 4, 17, 'ascii');

  buf.writeUInt32BE(handlelen, p += 17, true);
  buf.write(handle, p += 4, handlelen, 'utf8');

  state.requests[reqid] = { cb: cb };

  this.debug('DEBUG[SFTP]: Outgoing: Writing fsync@openssh.com');
  return this.push(buf);
};

// server
SFTPStream.prototype.status = function(id, code, message, lang) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  if (!STATUS_CODE[code] || typeof code !== 'number')
    throw new Error('Bad status code: ' + code);

  message || (message = '');
  lang || (lang = '');

  var msgLen = Buffer.byteLength(message);
  var langLen = Buffer.byteLength(lang);
  var buf = new Buffer(4 + 1 + 4 + 4 + 4 + msgLen + 4 + langLen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = RESPONSE.STATUS;
  buf.writeUInt32BE(id, 5, true);

  buf.writeUInt32BE(code, 9, true);

  buf.writeUInt32BE(msgLen, 13, true);
  if (msgLen)
    buf.write(message, 17, msgLen, 'utf8');

  buf.writeUInt32BE(langLen, 17 + msgLen, true);
  if (langLen)
    buf.write(lang, 17 + msgLen + 4, langLen, 'ascii');

  this.debug('DEBUG[SFTP]: Outgoing: Writing STATUS');
  return this.push(buf);
};
SFTPStream.prototype.handle = function(id, handle) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  if (!Buffer.isBuffer(handle))
    throw new Error('handle is not a Buffer');

  var handleLen = handle.length;

  if (handleLen > 256)
    throw new Error('handle too large (> 256 bytes)');

  var buf = new Buffer(4 + 1 + 4 + 4 + handleLen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = RESPONSE.HANDLE;
  buf.writeUInt32BE(id, 5, true);

  buf.writeUInt32BE(handleLen, 9, true);
  if (handleLen)
    handle.copy(buf, 13);

  this.debug('DEBUG[SFTP]: Outgoing: Writing HANDLE');
  return this.push(buf);
};
SFTPStream.prototype.data = function(id, data, encoding) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var isBuffer = Buffer.isBuffer(data);

  if (!isBuffer && typeof data !== 'string')
    throw new Error('data is not a Buffer or string');

  if (!isBuffer)
    encoding || (encoding = 'utf8');

  var dataLen = (isBuffer ? data.length : Buffer.byteLength(data, encoding));
  var buf = new Buffer(4 + 1 + 4 + 4 + dataLen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = RESPONSE.DATA;
  buf.writeUInt32BE(id, 5, true);

  buf.writeUInt32BE(dataLen, 9, true);
  if (dataLen) {
    if (isBuffer)
      data.copy(buf, 13);
    else
      buf.write(data, 13, dataLen, encoding);
  }

  this.debug('DEBUG[SFTP]: Outgoing: Writing DATA');
  return this.push(buf);
};
SFTPStream.prototype.name = function(id, names) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  if (!Array.isArray(names) && typeof names === 'object')
    names = [ names ];
  else if (!Array.isArray(names))
    throw new Error('names is not an object or array');

  var count = names.length;
  var namesLen = 0;
  var nameAttrs;
  var attrs = [];
  var name;
  var filename;
  var longname;
  var attr;
  var len;
  var len2;
  var buf;
  var p;
  var i;
  var j;
  var k;

  for (i = 0; i < count; ++i) {
    name = names[i];
    filename = (!name || !name.filename || typeof name.filename !== 'string'
                ? ''
                : name.filename);
    namesLen += 4 + Buffer.byteLength(filename);
    longname = (!name || !name.longname || typeof name.longname !== 'string'
                ? ''
                : name.longname);
    namesLen += 4 + Buffer.byteLength(longname);

    if (typeof name.attrs === 'object') {
      nameAttrs = attrsToBytes(name.attrs);
      namesLen += 4 + nameAttrs.nbytes;
      attrs.push(nameAttrs);
    } else {
      namesLen += 4;
      attrs.push(null);
    }
  }

  buf = new Buffer(4 + 1 + 4 + 4 + namesLen);

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = RESPONSE.NAME;
  buf.writeUInt32BE(id, 5, true);

  buf.writeUInt32BE(count, 9, true);

  p = 13;

  for (i = 0; i < count; ++i) {
    name = names[i];

    filename = (!name || !name.filename || typeof name.filename !== 'string'
                ? ''
                : name.filename);
    len = Buffer.byteLength(filename);
    buf.writeUInt32BE(len, p, true);
    p += 4;
    if (len) {
      buf.write(filename, p, len, 'utf8');
      p += len;
    }

    longname = (!name || !name.longname || typeof name.longname !== 'string'
                ? ''
                : name.longname);
    len = Buffer.byteLength(longname);
    buf.writeUInt32BE(len, p, true);
    p += 4;
    if (len) {
      buf.write(longname, p, len, 'utf8');
      p += len;
    }

    attr = attrs[i];
    if (attr) {
      buf.writeUInt32BE(attr.flags, p, true);
      p += 4;
      if (attr.flags && attr.bytes) {
        var bytes = attr.bytes;
        for (j = 0, len = bytes.length; j < len; ++j)
          for (k = 0, len2 = bytes[j].length; k < len2; ++k)
            buf[p++] = bytes[j][k];
      }
    } else {
      buf.writeUInt32BE(0, p, true);
      p += 4;
    }
  }

  this.debug('DEBUG[SFTP]: Outgoing: Writing NAME');
  return this.push(buf);
};
SFTPStream.prototype.attrs = function(id, attrs) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  if (typeof attrs !== 'object')
    throw new Error('attrs is not an object');

  var info = attrsToBytes(attrs);
  var buf = new Buffer(4 + 1 + 4 + 4 + info.nbytes);
  var p = 13;

  buf.writeUInt32BE(buf.length - 4, 0, true);
  buf[4] = RESPONSE.ATTRS;
  buf.writeUInt32BE(id, 5, true);

  buf.writeUInt32BE(info.flags, 9, true);

  if (info.flags && info.bytes) {
    var bytes = info.bytes;
    for (var j = 0, len = bytes.length; j < len; ++j)
      for (var k = 0, len2 = bytes[j].length; k < len2; ++k)
        buf[p++] = bytes[j][k];
  }

  this.debug('DEBUG[SFTP]: Outgoing: Writing ATTRS');
  return this.push(buf);
};

function readAttrs(buf, p, stream, callback) {
  /*
    uint32   flags
    uint64   size           present only if flag SSH_FILEXFER_ATTR_SIZE
    uint32   uid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    uint32   gid            present only if flag SSH_FILEXFER_ATTR_UIDGID
    uint32   permissions    present only if flag SSH_FILEXFER_ATTR_PERMISSIONS
    uint32   atime          present only if flag SSH_FILEXFER_ACMODTIME
    uint32   mtime          present only if flag SSH_FILEXFER_ACMODTIME
    uint32   extended_count present only if flag SSH_FILEXFER_ATTR_EXTENDED
    string   extended_type
    string   extended_data
    ...      more extended data (extended_type - extended_data pairs),
               so that number of pairs equals extended_count
  */
  var flags = buf.readUInt32BE(p, true);
  var attrs = new Stats();

  p += 4;

  if (flags & ATTR.SIZE) {
    var size = readUInt64BE(buf, p, stream, callback);
    if (size === false)
      return false;
    attrs.size = size;
    p += 8;
  }
  if (flags & ATTR.UIDGID) {
    var uid;
    var gid;
    uid = readInt(buf, p, this, callback);
    if (uid === false)
      return false;
    attrs.uid = uid;
    p += 4;
    gid = readInt(buf, p, this, callback);
    if (gid === false)
      return false;
    attrs.gid = gid;
    p += 4;
  }
  if (flags & ATTR.PERMISSIONS) {
    var mode = readInt(buf, p, this, callback);
    if (mode === false)
      return false;
    attrs.mode = mode;
    // backwards compatibility
    attrs.permissions = mode;
    p += 4;
  }
  if (flags & ATTR.ACMODTIME) {
    var atime;
    var mtime;
    atime = readInt(buf, p, this, callback);
    if (atime === false)
      return false;
    attrs.atime = atime;
    p += 4;
    mtime = readInt(buf, p, this, callback);
    if (mtime === false)
      return false;
    attrs.mtime = mtime;
    p += 4;
  }
  if (flags & ATTR.EXTENDED) {
    // TODO: read/parse extended data
    var extcount = readInt(buf, p, this, callback);
    if (extcount === false)
      return false;
    p += 4;
    for (var i = 0, len; i < extcount; ++i) {
      len = readInt(buf, p, this, callback);
      if (len === false)
        return false;
      p += 4 + len;
    }
  }

  buf._pos = p;

  return attrs;
}

function readUInt64BE(buffer, p, stream, callback) {
  if ((buffer.length - p) < 8) {
    stream && stream._cleanup(callback);
    return false;
  }

  var val = 0;

  for (var len = p + 8; p < len; ++p) {
    val *= 256;
    val += buffer[p];
  }

  buffer._pos = p;

  return val;
}

function attrsToBytes(attrs) {
  var flags = 0;
  var attrBytes = 0;
  var ret = [];
  var i = 0;

  if (typeof attrs.size === 'number') {
    flags |= ATTR.SIZE;
    attrBytes += 8;
    var sizeBytes = new Array(8);
    var val = attrs.size;
    for (i = 7; i >= 0; --i) {
      sizeBytes[i] = val & 0xFF;
      val /= 256;
    }
    ret.push(sizeBytes);
  }
  if (typeof attrs.uid === 'number' && typeof attrs.gid === 'number') {
    flags |= ATTR.UIDGID;
    attrBytes += 8;
    ret.push([(attrs.uid >> 24) & 0xFF, (attrs.uid >> 16) & 0xFF,
              (attrs.uid >> 8) & 0xFF, attrs.uid & 0xFF]);
    ret.push([(attrs.gid >> 24) & 0xFF, (attrs.gid >> 16) & 0xFF,
              (attrs.gid >> 8) & 0xFF, attrs.gid & 0xFF]);
  }
  if (typeof attrs.permissions === 'number'
      || typeof attrs.permissions === 'string'
      || typeof attrs.mode === 'number'
      || typeof attrs.mode === 'string') {
    var mode = modeNum(attrs.mode || attrs.permissions);
    flags |= ATTR.PERMISSIONS;
    attrBytes += 4;
    ret.push([(mode >> 24) & 0xFF,
              (mode >> 16) & 0xFF,
              (mode >> 8) & 0xFF,
              mode & 0xFF]);
  }
  if ((typeof attrs.atime === 'number' || isDate(attrs.atime))
      && (typeof attrs.mtime === 'number' || isDate(attrs.mtime))) {
    var atime = toUnixTimestamp(attrs.atime);
    var mtime = toUnixTimestamp(attrs.mtime);

    flags |= ATTR.ACMODTIME;
    attrBytes += 8;
    ret.push([(atime >> 24) & 0xFF, (atime >> 16) & 0xFF,
              (atime >> 8) & 0xFF, atime & 0xFF]);
    ret.push([(mtime >> 24) & 0xFF, (mtime >> 16) & 0xFF,
              (mtime >> 8) & 0xFF, mtime & 0xFF]);
  }
  // TODO: extended attributes

  return { flags: flags, nbytes: attrBytes, bytes: ret };
}

function toUnixTimestamp(time) {
  if (typeof time === 'number' && !isNaN(time))
    return time;
  else if (isDate(time))
    return parseInt(time.getTime() / 1000, 10);
  throw new Error('Cannot parse time: ' + time);
}

function modeNum(mode) {
  if (typeof mode === 'number' && !isNaN(mode))
    return mode;
  else if (typeof mode === 'string')
    return modeNum(parseInt(mode, 8));
  throw new Error('Cannot parse mode: ' + mode);
}

var stringFlagMap = {
  'r': OPEN_MODE.READ,
  'r+': OPEN_MODE.READ | OPEN_MODE.WRITE,
  'w': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE,
  'wx': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE | OPEN_MODE.EXCL,
  'xw': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.WRITE | OPEN_MODE.EXCL,
  'w+': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE,
  'wx+': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE
         | OPEN_MODE.EXCL,
  'xw+': OPEN_MODE.TRUNC | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE
         | OPEN_MODE.EXCL,
  'a': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.WRITE,
  'ax': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.WRITE | OPEN_MODE.EXCL,
  'xa': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.WRITE | OPEN_MODE.EXCL,
  'a+': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE,
  'ax+': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE
         | OPEN_MODE.EXCL,
  'xa+': OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.READ | OPEN_MODE.WRITE
         | OPEN_MODE.EXCL
};
var stringFlagMapKeys = Object.keys(stringFlagMap);

function stringToFlags(str) {
  var flags = stringFlagMap[str];
  if (flags !== undefined)
    return flags;
  return null;
}
SFTPStream.stringToFlags = stringToFlags;

function flagsToString(flags) {
  for (var i = 0; i < stringFlagMapKeys.length; ++i) {
    var key = stringFlagMapKeys[i];
    if (stringFlagMap[key] === flags)
      return key;
  }
  return null;
}
SFTPStream.flagsToString = flagsToString;

function Stats(initial) {
  this.mode = (initial && initial.mode);
  this.permissions = this.mode; // backwards compatiblity
  this.uid = (initial && initial.uid);
  this.gid = (initial && initial.gid);
  this.size = (initial && initial.size);
  this.atime = (initial && initial.atime);
  this.mtime = (initial && initial.mtime);
}
Stats.prototype._checkModeProperty = function(property) {
  return ((this.mode & constants.S_IFMT) === property);
};
Stats.prototype.isDirectory = function() {
  return this._checkModeProperty(constants.S_IFDIR);
};
Stats.prototype.isFile = function() {
  return this._checkModeProperty(constants.S_IFREG);
};
Stats.prototype.isBlockDevice = function() {
  return this._checkModeProperty(constants.S_IFBLK);
};
Stats.prototype.isCharacterDevice = function() {
  return this._checkModeProperty(constants.S_IFCHR);
};
Stats.prototype.isSymbolicLink = function() {
  return this._checkModeProperty(constants.S_IFLNK);
};
Stats.prototype.isFIFO = function() {
  return this._checkModeProperty(constants.S_IFIFO);
};
Stats.prototype.isSocket = function() {
  return this._checkModeProperty(constants.S_IFSOCK);
};
SFTPStream.Stats = Stats;


// ReadStream-related
var kMinPoolSpace = 128;
var pool;
function allocNewPool(poolSize) {
  pool = new Buffer(poolSize);
  pool.used = 0;
}

function ReadStream(sftp, path, options) {
  if (!(this instanceof ReadStream))
    return new ReadStream(sftp, path, options);

  var self = this;

  if (options === undefined)
    options = {};
  else if (typeof options === 'string')
    options = { encoding: options };
  else if (options === null || typeof options !== 'object')
    throw new TypeError('"options" argument must be a string or an object');
  else
    options = Object.create(options);

  // a little bit bigger buffer and water marks by default
  if (options.highWaterMark === undefined)
    options.highWaterMark = 64 * 1024;

  ReadableStream.call(this, options);

  this.path = path;
  this.handle = options.handle === undefined ? null : options.handle;
  this.flags = options.flags === undefined ? 'r' : options.flags;
  this.mode = options.mode === undefined ? 438/*0666*/ : options.mode;

  this.start = options.start === undefined ? undefined : options.start;
  this.end = options.end === undefined ? undefined : options.end;
  this.autoClose = options.autoClose === undefined ? true : options.autoClose;
  this.pos = 0;
  this.sftp = sftp;

  if (this.start !== undefined) {
    if (typeof this.start !== 'number')
      throw new TypeError('start must be a Number');
    if (this.end === undefined)
      this.end = Infinity;
    else if (typeof this.end !== 'number')
      throw new TypeError('end must be a Number');

    if (this.start > this.end)
      throw new Error('start must be <= end');
    else if (this.start < 0)
      throw new Error('start must be >= zero');

    this.pos = this.start;
  }

  this.on('end', function() {
    if (self.autoClose) {
      self.destroy();
    }
  });

  if (!Buffer.isBuffer(this.handle))
    this.open();
}
inherits(ReadStream, ReadableStream);

ReadStream.prototype.open = function() {
  var self = this;
  this.sftp.open(this.path, this.flags, this.mode, function(er, handle) {
    if (er) {
      self.emit('error', er);
      this.destroyed = this.closed = true;
      self.emit('close');
      return;
    }

    self.handle = handle;
    self.emit('open', handle);
    // start the flow of data.
    self.read();
  });
};

ReadStream.prototype._read = function(n) {
  if (!Buffer.isBuffer(this.handle)) {
    return this.once('open', function() {
      this._read(n);
    });
  }

  if (this.destroyed)
    return;

  if (!pool || pool.length - pool.used < kMinPoolSpace) {
    // discard the old pool.
    pool = null;
    allocNewPool(this._readableState.highWaterMark);
  }

  // Grab another reference to the pool in the case that while we're
  // in the thread pool another read() finishes up the pool, and
  // allocates a new one.
  var thisPool = pool;
  var toRead = Math.min(pool.length - pool.used, n);
  var start = pool.used;

  if (this.end !== undefined)
    toRead = Math.min(this.end - this.pos + 1, toRead);

  // already read everything we were supposed to read!
  // treat as EOF.
  if (toRead <= 0)
    return this.push(null);

  // the actual read.
  var self = this;
  this.sftp.readData(this.handle, pool, pool.used, toRead, this.pos, onread);

  // move the pool positions, and internal position for reading.
  this.pos += toRead;
  pool.used += toRead;

  function onread(er, bytesRead) {
    if (er) {
      if (self.autoClose)
        self.destroy();
      self.emit('error', er);
    } else {
      var b = null;
      if (bytesRead > 0)
        b = thisPool.slice(start, start + bytesRead);

      self.push(b);
    }
  }
};

ReadStream.prototype.destroy = function() {
  if (this.destroyed)
    return;
  this.destroyed = true;
  if (Buffer.isBuffer(this.handle))
    this.close();
};


ReadStream.prototype.close = function(cb) {
  var self = this;
  if (cb)
    this.once('close', cb);
  if (this.closed || !Buffer.isBuffer(this.handle)) {
    if (!Buffer.isBuffer(this.handle)) {
      this.once('open', close);
      return;
    }
    return process.nextTick(this.emit.bind(this, 'close'));
  }
  this.closed = true;
  close();

  function close(handle) {
    self.sftp.close(handle || self.handle, function(er) {
      if (er)
        self.emit('error', er);
      else
        self.emit('close');
    });
    self.handle = null;
  }
};


function WriteStream(sftp, path, options) {
  if (!(this instanceof WriteStream))
    return new WriteStream(sftp, path, options);

  if (options === undefined)
    options = {};
  else if (typeof options === 'string')
    options = { encoding: options };
  else if (options === null || typeof options !== 'object')
    throw new TypeError('"options" argument must be a string or an object');
  else
    options = Object.create(options);

  WritableStream.call(this, options);

  this.path = path;
  this.handle = options.handle === undefined ? null : options.handle;
  this.flags = options.flags === undefined ? 'w' : options.flags;
  this.mode = options.mode === undefined ? 438/*0666*/ : options.mode;

  this.start = options.start === undefined ? undefined : options.start;
  this.autoClose = options.autoClose === undefined ? true : options.autoClose;
  this.pos = 0;
  this.bytesWritten = 0;
  this.sftp = sftp;

  if (this.start !== undefined) {
    if (typeof this.start !== 'number')
      throw new TypeError('start must be a Number');
    if (this.start < 0)
      throw new Error('start must be >= zero');

    this.pos = this.start;
  }

  if (options.encoding)
    this.setDefaultEncoding(options.encoding);

  if (!Buffer.isBuffer(this.handle))
    this.open();

  // dispose on finish.
  this.once('finish', function onclose() {
    if (this.autoClose)
      this.close();
  });
}
inherits(WriteStream, WritableStream);

WriteStream.prototype.open = function() {
  var self = this;
  this.sftp.open(this.path, this.flags, this.mode, function(er, handle) {
    if (er) {
      self.emit('error', er);
      if (this.autoClose) {
        this.destroyed = this.closed = true;
        self.emit('close');
      }
      return;
    }

    self.handle = handle;

    self.sftp.fchmod(handle, self.mode, function tryAgain(err) {
      if (err) {
        // Try chmod() for sftp servers that may not support fchmod() for
        // whatever reason
        self.sftp.chmod(self.path, self.mode, function(err_) {
          tryAgain();
        });
        return;
      }

      // SFTPv3 requires absolute offsets, no matter the open flag used
      if (self.flags[0] === 'a') {
        self.sftp.fstat(handle, function tryStat(err, st) {
          if (err) {
            // Try stat() for sftp servers that may not support fstat() for
            // whatever reason
            self.sftp.stat(self.path, function(err_, st_) {
              if (err_) {
                self.destroy();
                self.emit('error', err);
                return;
              }
              tryStat(null, st_);
            });
            return;
          }

          self.pos = st.size;
          self.emit('open', handle);
        });
        return;
      }
      self.emit('open', handle);
    });
  });
};

WriteStream.prototype._write = function(data, encoding, cb) {
  if (!Buffer.isBuffer(data))
    return this.emit('error', new Error('Invalid data'));

  if (!Buffer.isBuffer(this.handle)) {
    return this.once('open', function() {
      this._write(data, encoding, cb);
    });
  }

  var self = this;
  this.sftp.writeData(this.handle,
                      data,
                      0,
                      data.length,
                      this.pos,
                      function(er, bytes) {
    if (er) {
      if (self.autoClose)
        self.destroy();
      return cb(er);
    }
    self.bytesWritten += bytes;
    cb();
  });

  this.pos += data.length;
};

WriteStream.prototype._writev = function(data, cb) {
  if (!Buffer.isBuffer(this.handle)) {
    return this.once('open', function() {
      this._writev(data, cb);
    });
  }

  var sftp = this.sftp;
  var handle = this.handle;
  var writesLeft = data.length;
  var self = this;

  for (var i = 0; i < data.length; ++i) {
    var chunk = data[i].chunk;

    sftp.writeData(handle, chunk, 0, chunk.length, this.pos, onwrite);
    this.pos += chunk.length;
  }

  function onwrite(er, bytes) {
    if (er) {
      self.destroy();
      return cb(er);
    }
    self.bytesWritten += bytes;
    if (--writesLeft === 0)
      cb();
  }
};

WriteStream.prototype.destroy = ReadStream.prototype.destroy;
WriteStream.prototype.close = ReadStream.prototype.close;

// There is no shutdown() for files.
WriteStream.prototype.destroySoon = WriteStream.prototype.end;


module.exports = SFTPStream;

