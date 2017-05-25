// TODO: * Automatic re-key every (configurable) n bytes or length of time
//         - RFC suggests every 1GB of transmitted data or 1 hour, whichever
//           comes sooner
//       * Filter control codes from strings
//         (as per http://tools.ietf.org/html/rfc4251#section-9.2)

var crypto = require('crypto');
var zlib = require('zlib');
var TransformStream = require('stream').Transform;
var inherits = require('util').inherits;
var inspect = require('util').inspect;
var BUFFER_MAX_LEN = require('buffer').kMaxLength;

var StreamSearch = require('streamsearch');

var consts = require('./constants');
var utils = require('./utils');
var isStreamCipher = utils.isStreamCipher;
var iv_inc = utils.iv_inc;
var readString = utils.readString;
var readInt = utils.readInt;
var DSASigBERToBare = utils.DSASigBERToBare;
var DSASigBareToBER = utils.DSASigBareToBER;
var ECDSASigSSHToASN1 = utils.ECDSASigSSHToASN1;
var ECDSASigASN1ToSSH = utils.ECDSASigASN1ToSSH;
var RSAKeySSHToASN1 = utils.RSAKeySSHToASN1;
var DSAKeySSHToASN1 = utils.DSAKeySSHToASN1;
var ECDSAKeySSHToASN1 = utils.ECDSAKeySSHToASN1;

var MESSAGE = consts.MESSAGE;
var DYNAMIC_KEXDH_MESSAGE = consts.DYNAMIC_KEXDH_MESSAGE;
var KEXDH_MESSAGE = consts.KEXDH_MESSAGE;
var ALGORITHMS = consts.ALGORITHMS;
var DISCONNECT_REASON = consts.DISCONNECT_REASON;
var CHANNEL_OPEN_FAILURE = consts.CHANNEL_OPEN_FAILURE;
var SSH_TO_OPENSSL = consts.SSH_TO_OPENSSL;
var TERMINAL_MODE = consts.TERMINAL_MODE;
var SIGNALS = consts.SIGNALS;
var BUGS = consts.BUGS;
var BUGGY_IMPLS = consts.BUGGY_IMPLS;
var BUGGY_IMPLS_LEN = BUGGY_IMPLS.length;
var MODULE_VER = require('../package.json').version;
var I = 0;
var IN_INIT = I++;
var IN_GREETING = I++;
var IN_HEADER = I++;
var IN_PACKETBEFORE = I++;
var IN_PACKET = I++;
var IN_PACKETDATA = I++;
var IN_PACKETDATAVERIFY = I++;
var IN_PACKETDATAAFTER = I++;
var OUT_INIT = I++;
var OUT_READY = I++;
var OUT_REKEYING = I++;
var MAX_SEQNO = 4294967295;
var MAX_PACKET_SIZE = 35000;
var MAX_PACKETS_REKEYING = 50;
var EXP_TYPE_HEADER = 0;
var EXP_TYPE_LF = 1;
var EXP_TYPE_BYTES = 2; // Waits until n bytes have been seen
var Z_PARTIAL_FLUSH = zlib.Z_PARTIAL_FLUSH;
var ZLIB_OPTS = { flush: Z_PARTIAL_FLUSH };

var RE_KEX_HASH = /-(.+)$/;
var RE_GEX = /^gex-/;
var RE_NULL = /\x00/g;
var RE_GCM = /^aes\d+-gcm/i;

var IDENT_PREFIX_BUFFER = new Buffer('SSH-');
var EMPTY_BUFFER = new Buffer(0);
var PING_PACKET = new Buffer([
  MESSAGE.GLOBAL_REQUEST,
  // "keepalive@openssh.com"
  0, 0, 0, 21,
    107, 101, 101, 112, 97, 108, 105, 118, 101, 64, 111, 112, 101, 110, 115,
    115, 104, 46, 99, 111, 109,
  // Request a reply
  1
]);
var NEWKEYS_PACKET = new Buffer([MESSAGE.NEWKEYS]);
var USERAUTH_SUCCESS_PACKET = new Buffer([MESSAGE.USERAUTH_SUCCESS]);
var REQUEST_SUCCESS_PACKET = new Buffer([MESSAGE.REQUEST_SUCCESS]);
var REQUEST_FAILURE_PACKET = new Buffer([MESSAGE.REQUEST_FAILURE]);
var NO_TERMINAL_MODES_BUFFER = new Buffer([TERMINAL_MODE.TTY_OP_END]);
var KEXDH_GEX_REQ_PACKET = new Buffer([
  MESSAGE.KEXDH_GEX_REQUEST,
  // Minimal size in bits of an acceptable group
  0, 0, 4, 0, // 1024, modp2
  // Preferred size in bits of the group the server will send
  0, 0, 10, 0, // 4096, modp16
  // Maximal size in bits of an acceptable group
  0, 0, 20, 0 // 8192, modp18
]);

function DEBUG_NOOP(msg) {}

function SSH2Stream(cfg) {
  if (typeof cfg !== 'object' || cfg === null)
    cfg = {};

  TransformStream.call(this, {
    highWaterMark: (typeof cfg.highWaterMark === 'number'
                    ? cfg.highWaterMark
                    : 32 * 1024)
  });

  this._needContinue = false;
  this.bytesSent = this.bytesReceived = 0;
  this.debug = (typeof cfg.debug === 'function' ? cfg.debug : DEBUG_NOOP);
  this.server = (cfg.server === true);
  this.maxPacketSize = (typeof cfg.maxPacketSize === 'number'
                        ? cfg.maxPacketSize
                        : MAX_PACKET_SIZE);
  // Bitmap that indicates any bugs the remote side has. This is determined
  // by the reported software version.
  this.remoteBugs = 0;

  if (this.server) {
    // TODO: Remove when we support group exchange for server implementation
    this.remoteBugs = BUGS.BAD_DHGEX;
  }

  var self = this;

  var hostKeys = cfg.hostKeys;
  if (this.server && (typeof hostKeys !== 'object' || hostKeys === null))
    throw new Error('hostKeys must be an object keyed on host key type');

  this.config = {
    // Server
    hostKeys: hostKeys, // All keys supported by server

    // Client/Server
    ident: 'SSH-2.0-'
           + (cfg.ident
              || ('ssh2js' + MODULE_VER + (this.server ? 'srv' : ''))),
    algorithms: {
      kex: ALGORITHMS.KEX,
      kexBuf: ALGORITHMS.KEX_BUF,
      serverHostKey: ALGORITHMS.SERVER_HOST_KEY,
      serverHostKeyBuf: ALGORITHMS.SERVER_HOST_KEY_BUF,
      cipher: ALGORITHMS.CIPHER,
      cipherBuf: ALGORITHMS.CIPHER_BUF,
      hmac: ALGORITHMS.HMAC,
      hmacBuf: ALGORITHMS.HMAC_BUF,
      compress: ALGORITHMS.COMPRESS,
      compressBuf: ALGORITHMS.COMPRESS_BUF
    }
  };
  // RFC 4253 states the identification string must not contain NULL
  this.config.ident.replace(RE_NULL, '');

  if (this.config.ident.length + 2 /* Account for "\r\n" */ > 255)
    throw new Error('ident too long');

  if (typeof cfg.algorithms === 'object' && cfg.algorithms !== null) {
    var algos = cfg.algorithms;
    if (Array.isArray(algos.kex) && algos.kex.length > 0) {
      this.config.algorithms.kex = algos.kex;
      if (!Buffer.isBuffer(algos.kexBuf))
        algos.kexBuf = new Buffer(algos.kex.join(','), 'ascii');
      this.config.algorithms.kexBuf = algos.kexBuf;
    }
    if (Array.isArray(algos.serverHostKey) && algos.serverHostKey.length > 0) {
      this.config.algorithms.serverHostKey = algos.serverHostKey;
      if (!Buffer.isBuffer(algos.serverHostKeyBuf)) {
        algos.serverHostKeyBuf = new Buffer(algos.serverHostKey.join(','),
                                            'ascii');
      }
      this.config.algorithms.serverHostKeyBuf = algos.serverHostKeyBuf;
    }
    if (Array.isArray(algos.cipher) && algos.cipher.length > 0) {
      this.config.algorithms.cipher = algos.cipher;
      if (!Buffer.isBuffer(algos.cipherBuf))
        algos.cipherBuf = new Buffer(algos.cipher.join(','), 'ascii');
      this.config.algorithms.cipherBuf = algos.cipherBuf;
    }
    if (Array.isArray(algos.hmac) && algos.hmac.length > 0) {
      this.config.algorithms.hmac = algos.hmac;
      if (!Buffer.isBuffer(algos.hmacBuf))
        algos.hmacBuf = new Buffer(algos.hmac.join(','), 'ascii');
      this.config.algorithms.hmacBuf = algos.hmacBuf;
    }
    if (Array.isArray(algos.compress) && algos.compress.length > 0) {
      this.config.algorithms.compress = algos.compress;
      if (!Buffer.isBuffer(algos.compressBuf))
        algos.compressBuf = new Buffer(algos.compress.join(','), 'ascii');
      this.config.algorithms.compressBuf = algos.compressBuf;
    }
  }

  this.reset(true);

  // Common events
  this.on('end', function() {
    // Let GC collect any Buffers we were previously storing
    self._state = undefined;
    self.reset();
    self._state.incoming.hmac.bufCompute = undefined;
    self._state.outgoing.bufSeqno = undefined;
  });
  this.on('DISCONNECT', function(reason, code, desc, lang) {
    onDISCONNECT(self, reason, code, desc, lang);
  });
  this.on('KEXINIT', function(init, firstFollows) {
    onKEXINIT(self, init, firstFollows);
  });
  this.on('NEWKEYS', function() { onNEWKEYS(self); });

  if (this.server) {
    // Server-specific events
    this.on('KEXDH_INIT', function(e) { onKEXDH_INIT(self, e); });
  } else {
    // Client-specific events
    this.on('KEXDH_REPLY', function(info) { onKEXDH_REPLY(self, info); })
        .on('KEXDH_GEX_GROUP',
            function(prime, gen) { onKEXDH_GEX_GROUP(self, prime, gen); });
  }

  if (this.server) {
    // Greeting displayed before the ssh identification string is sent, this is
    // usually ignored by most clients
    if (typeof cfg.greeting === 'string' && cfg.greeting.length) {
      if (cfg.greeting.slice(-2) === '\r\n')
        this.push(cfg.greeting);
      else
        this.push(cfg.greeting + '\r\n');
    }
    // Banner shown after the handshake completes, but before user
    // authentication begins
    if (typeof cfg.banner === 'string' && cfg.banner.length) {
      if (cfg.banner.slice(-2) === '\r\n')
        this.banner = cfg.banner;
      else
        this.banner = cfg.banner + '\r\n';
    }
  }
  this.debug('DEBUG: Local ident: ' + inspect(this.config.ident));
  this.push(this.config.ident + '\r\n');

  this._state.incoming.expectedPacket = 'KEXINIT';
}
inherits(SSH2Stream, TransformStream);

SSH2Stream.prototype.__read = TransformStream.prototype._read;
SSH2Stream.prototype._read = function(n) {
  if (this._needContinue) {
    this._needContinue = false;
    this.emit('continue');
  }
  return this.__read(n);
};
SSH2Stream.prototype.__push = TransformStream.prototype.push;
SSH2Stream.prototype.push = function(chunk, encoding) {
  var ret = this.__push(chunk, encoding);
  this._needContinue = (ret === false);
  return ret;
};

SSH2Stream.prototype._cleanup = function(callback) {
  this.reset();
  this.debug('DEBUG: Parser: Malformed packet');
  callback && callback(new Error('Malformed packet'));
};

SSH2Stream.prototype._transform = function(chunk, encoding, callback, decomp) {
  var skipDecrypt = false;
  var doDecryptGCM = false;
  var state = this._state;
  var instate = state.incoming;
  var outstate = state.outgoing;
  var expect = instate.expect;
  var decrypt = instate.decrypt;
  var decompress = instate.decompress;
  var chlen = chunk.length;
  var chleft = 0;
  var debug = this.debug;
  var self = this;
  var i = 0;
  var p = i;
  var buffer;
  var buf;
  var r;

  this.bytesReceived += chlen;

  while (true) {
    if (expect.type !== undefined) {
      if (i >= chlen)
        break;
      if (expect.type === EXP_TYPE_BYTES) {
        chleft = (chlen - i);
        var pktLeft = (expect.buf.length - expect.ptr);
        if (pktLeft <= chleft) {
          chunk.copy(expect.buf, expect.ptr, i, i + pktLeft);
          i += pktLeft;
          buffer = expect.buf;
          expect.buf = undefined;
          expect.ptr = 0;
          expect.type = undefined;
        } else {
          chunk.copy(expect.buf, expect.ptr, i);
          expect.ptr += chleft;
          i += chleft;
        }
        continue;
      } else if (expect.type === EXP_TYPE_HEADER) {
        i += instate.search.push(chunk);
        if (expect.type !== undefined)
          continue;
      } else if (expect.type === EXP_TYPE_LF) {
        if (++expect.ptr + 4 /* Account for "SSH-" */ > 255) {
          this.reset();
          debug('DEBUG: Parser: Identification string exceeded 255 characters');
          return callback(new Error('Max identification string size exceeded'));
        }
        if (chunk[i] === 0x0A) {
          expect.type = undefined;
          if (p < i) {
            if (expect.buf === undefined)
              expect.buf = chunk.toString('ascii', p, i);
            else
              expect.buf += chunk.toString('ascii', p, i);
          }
          buffer = expect.buf;
          expect.buf = undefined;
          ++i;
        } else {
          if (++i === chlen && p < i) {
            if (expect.buf === undefined)
              expect.buf = chunk.toString('ascii', p, i);
            else
              expect.buf += chunk.toString('ascii', p, i);
          }
          continue;
        }
      }
    }

    if (instate.status === IN_INIT) {
      if (this.server) {
        // Retrieve what should be the start of the protocol version exchange
        if (!buffer) {
          debug('DEBUG: Parser: IN_INIT (waiting for identification begin)');
          expectData(this, EXP_TYPE_BYTES, 4);
        } else {
          if (buffer[0] === 0x53       // S
              && buffer[1] === 0x53    // S
              && buffer[2] === 0x48    // H
              && buffer[3] === 0x2D) { // -
            instate.status = IN_GREETING;
            debug('DEBUG: Parser: IN_INIT (waiting for rest of identification)');
          } else {
            this.reset();
            debug('DEBUG: Parser: Bad identification start');
            return callback(new Error('Bad identification start'));
          }
        }
      } else {
        debug('DEBUG: Parser: IN_INIT');
        // Retrieve any bytes that may come before the protocol version exchange
        var ss = instate.search = new StreamSearch(IDENT_PREFIX_BUFFER);
        ss.on('info', function onInfo(matched, data, start, end) {
          if (data) {
            if (instate.greeting === undefined)
              instate.greeting = data.toString('binary', start, end);
            else
              instate.greeting += data.toString('binary', start, end);
          }
          if (matched) {
            expect.type = undefined;
            instate.search.removeListener('info', onInfo);
          }
        });
        ss.maxMatches = 1;
        expectData(this, EXP_TYPE_HEADER);
        instate.status = IN_GREETING;
      }
    } else if (instate.status === IN_GREETING) {
      debug('DEBUG: Parser: IN_GREETING');
      instate.search = undefined;
      // Retrieve the identification bytes after the "SSH-" header
      p = i;
      expectData(this, EXP_TYPE_LF);
      instate.status = IN_HEADER;
    } else if (instate.status === IN_HEADER) {
      debug('DEBUG: Parser: IN_HEADER');
      buffer = buffer.trim();
      var idxDash = buffer.indexOf('-');
      var idxSpace = buffer.indexOf(' ');
      var header = {
        // RFC says greeting SHOULD be utf8
        greeting: instate.greeting,
        identRaw: 'SSH-' + buffer,
        versions: {
          protocol: buffer.substr(0, idxDash),
          software: (idxSpace === -1
                     ? buffer.substring(idxDash + 1)
                     : buffer.substring(idxDash + 1, idxSpace))
        },
        comments: (idxSpace > -1 ? buffer.substring(idxSpace + 1) : undefined)
      };
      instate.greeting = undefined;

      if (header.versions.protocol !== '1.99'
          && header.versions.protocol !== '2.0') {
        this.reset();
        debug('DEBUG: Parser: protocol version not supported: '
              + header.versions.protocol);
        return callback(new Error('Protocol version not supported'));
      } else
        this.emit('header', header);

      if (instate.status === IN_INIT) {
        // We reset from an event handler, possibly due to an unsupported SSH
        // protocol version?
        return;
      }

      var identRaw = header.identRaw;
      var software = header.versions.software;
      this.debug('DEBUG: Remote ident: ' + inspect(identRaw));
      for (var j = 0, rule; j < BUGGY_IMPLS_LEN; ++j) {
        rule = BUGGY_IMPLS[j];
        if (typeof rule[0] === 'string') {
          if (software === rule[0])
            this.remoteBugs |= rule[1];
        } else if (rule[0].test(software))
          this.remoteBugs |= rule[1];
      }
      instate.identRaw = identRaw;
      // Adjust bytesReceived first otherwise it will have an incorrectly larger
      // total when we call back into this function after completing KEXINIT
      this.bytesReceived -= (chlen - i);
      KEXINIT(this, function() {
        if (i === chlen)
          callback();
        else
          self._transform(chunk.slice(i), encoding, callback);
      });
      instate.status = IN_PACKETBEFORE;
      return;
    } else if (instate.status === IN_PACKETBEFORE) {
      debug('DEBUG: Parser: IN_PACKETBEFORE (expecting ' + decrypt.size + ')');
      // Wait for the right number of bytes so we can determine the incoming
      // packet length
      expectData(this, EXP_TYPE_BYTES, decrypt.size, decrypt.buf);
      instate.status = IN_PACKET;
    } else if (instate.status === IN_PACKET) {
      debug('DEBUG: Parser: IN_PACKET');
      doDecryptGCM = (decrypt.instance && decrypt.isGCM);
      if (decrypt.instance && !decrypt.isGCM)
        buffer = decryptData(this, buffer);

      r = readInt(buffer, 0, this, callback);
      if (r === false)
        return;
      var macSize = (instate.hmac.size || 0);
      var fullPacketLen = r + 4 + macSize;
      var maxPayloadLen = this.maxPacketSize;
      if (decompress.instance) {
        // Account for compressed payloads
        // This formula is taken from dropbear which derives it from zlib's
        // documentation. Explanation from dropbear:
        /* For exact details see http://www.zlib.net/zlib_tech.html
         * 5 bytes per 16kB block, plus 6 bytes for the stream.
         * We might allocate 5 unnecessary bytes here if it's an
         * exact multiple. */
        maxPayloadLen += (((this.maxPacketSize / 16384) + 1) * 5 + 6);
      }
      if (r > maxPayloadLen
          // TODO: Change 16 to "MAX(16, decrypt.size)" when/if SSH2 adopts
          // 512-bit ciphers
          || fullPacketLen < (16 + macSize)
          || ((r + (doDecryptGCM ? 0 : 4)) % decrypt.size) !== 0) {
        this.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
        debug('DEBUG: Parser: Bad packet length (' + fullPacketLen + ')');
        return callback(new Error('Bad packet length'));
      }

      instate.pktLen = r;
      var remainLen = instate.pktLen + 4 - decrypt.size;
      if (doDecryptGCM) {
        decrypt.instance.setAAD(buffer.slice(0, 4));
        debug('DEBUG: Parser: pktLen:'
              + instate.pktLen
              + ',remainLen:'
              + remainLen);
      } else {
        instate.padLen = buffer[4];
        debug('DEBUG: Parser: pktLen:'
              + instate.pktLen
              + ',padLen:'
              + instate.padLen
              + ',remainLen:'
              + remainLen);
      }
      if (remainLen > 0) {
        if (doDecryptGCM)
          instate.pktExtra = buffer.slice(4);
        else
          instate.pktExtra = buffer.slice(5);
        // Grab the rest of the packet
        expectData(this, EXP_TYPE_BYTES, remainLen);
        instate.status = IN_PACKETDATA;
      } else if (remainLen < 0)
        instate.status = IN_PACKETBEFORE;
      else {
        // Entire message fit into one block
        skipDecrypt = true;
        instate.status = IN_PACKETDATA;
        continue;
      }
    } else if (instate.status === IN_PACKETDATA) {
      debug('DEBUG: Parser: IN_PACKETDATA');
      doDecryptGCM = (decrypt.instance && decrypt.isGCM);
      if (decrypt.instance && !skipDecrypt && !doDecryptGCM)
        buffer = decryptData(this, buffer);
      else if (skipDecrypt)
        skipDecrypt = false;
      var padStart = instate.pktLen - instate.padLen - 1;
      // TODO: Allocate a Buffer once that is slightly larger than maxPacketSize
      // (to accommodate for packet length field and MAC) and re-use that
      // instead
      if (instate.pktExtra) {
        buf = new Buffer(instate.pktExtra.length + buffer.length);
        instate.pktExtra.copy(buf);
        buffer.copy(buf, instate.pktExtra.length);
        instate.payload = buf.slice(0, padStart);
      } else {
        // Entire message fit into one block
        if (doDecryptGCM)
          buf = buffer.slice(4);
        else
          buf = buffer.slice(5);
        instate.payload = buffer.slice(5, 5 + padStart);
      }
      if (instate.hmac.size !== undefined) {
        // Wait for hmac hash
        debug('DEBUG: Parser: HMAC size:' + instate.hmac.size);
        expectData(this, EXP_TYPE_BYTES, instate.hmac.size, instate.hmac.buf);
        instate.status = IN_PACKETDATAVERIFY;
        instate.packet = buf;
      } else
        instate.status = IN_PACKETDATAAFTER;
      instate.pktExtra = undefined;
      buf = undefined;
    } else if (instate.status === IN_PACKETDATAVERIFY) {
      debug('DEBUG: Parser: IN_PACKETDATAVERIFY');
      // Verify packet data integrity
      if (hmacVerify(this, buffer)) {
        debug('DEBUG: Parser: IN_PACKETDATAVERIFY (Valid HMAC)');
        instate.status = IN_PACKETDATAAFTER;
        instate.packet = undefined;
      } else {
        this.reset();
        debug('DEBUG: Parser: IN_PACKETDATAVERIFY (Invalid HMAC)');
        return callback(new Error('Invalid HMAC'));
      }
    } else if (instate.status === IN_PACKETDATAAFTER) {
      if (decompress.instance) {
        if (!decomp) {
          debug('DEBUG: Parser: Decompressing');
          decompress.instance.write(instate.payload);
          var decompBuf = [];
          var decompBufLen = 0;
          decompress.instance.on('readable', function() {
            var buf;
            while (buf = this.read()) {
              decompBuf.push(buf);
              decompBufLen += buf.length;
            }
          }).flush(Z_PARTIAL_FLUSH, function() {
            decompress.instance.removeAllListeners('readable');
            if (decompBuf.length === 1)
              instate.payload = decompBuf[0];
            else
              instate.payload = Buffer.concat(decompBuf, decompBufLen);
            decompBuf = null;
            var nextSlice;
            if (i === chlen)
              nextSlice = EMPTY_BUFFER; // Avoid slicing a zero-length buffer
            else
              nextSlice = chunk.slice(i);
            self._transform(nextSlice, encoding, callback, true);
          });
          return;
        } else {
          // Make sure we reset this after this first time in the loop,
          // otherwise we could end up trying to interpret as-is another
          // compressed packet that is within the same chunk
          decomp = false;
        }
      }

      this.emit('packet');

      var ptype = instate.payload[0];

      if (debug !== DEBUG_NOOP) {
        var msgPacket = 'DEBUG: Parser: IN_PACKETDATAAFTER, packet: ';
        var kexdh = state.kexdh;
        var authMethod = state.authsQueue[0];
        var msgPktType = null;

        if (outstate.status === OUT_REKEYING
            && !(ptype <= 4 || (ptype >= 20 && ptype <= 49)))
          msgPacket += '(enqueued) ';

        if (ptype === MESSAGE.KEXDH_INIT) {
          if (kexdh === 'group')
            msgPktType = 'KEXDH_INIT';
          else if (kexdh[0] === 'e')
            msgPktType = 'KEXECDH_INIT';
          else
            msgPktType = 'KEXDH_GEX_REQUEST';
        } else if (ptype === MESSAGE.KEXDH_REPLY) {
          if (kexdh === 'group')
            msgPktType = 'KEXDH_REPLY';
          else if (kexdh[0] === 'e')
            msgPktType = 'KEXECDH_REPLY';
          else
            msgPktType = 'KEXDH_GEX_GROUP';
        } else if (ptype === MESSAGE.KEXDH_GEX_GROUP)
          msgPktType = 'KEXDH_GEX_GROUP';
        else if (ptype === MESSAGE.KEXDH_GEX_REPLY)
          msgPktType = 'KEXDH_GEX_REPLY';
        else if (ptype === 60) {
          if (authMethod === 'password')
            msgPktType = 'USERAUTH_PASSWD_CHANGEREQ';
          else if (authMethod === 'keyboard-interactive')
            msgPktType = 'USERAUTH_INFO_REQUEST';
          else if (authMethod === 'publickey')
            msgPktType = 'USERAUTH_PK_OK';
          else
            msgPktType = 'UNKNOWN PACKET 60';
        } else if (ptype === 61) {
          if (authMethod === 'keyboard-interactive')
            msgPktType = 'USERAUTH_INFO_RESPONSE';
          else
            msgPktType = 'UNKNOWN PACKET 61';
        }

        if (msgPktType === null)
          msgPktType = MESSAGE[ptype];

        // Don't write debug output for messages we custom make in parsePacket()
        if (ptype !== MESSAGE.CHANNEL_OPEN
            && ptype !== MESSAGE.CHANNEL_REQUEST
            && ptype !== MESSAGE.CHANNEL_SUCCESS
            && ptype !== MESSAGE.CHANNEL_FAILURE
            && ptype !== MESSAGE.CHANNEL_EOF
            && ptype !== MESSAGE.CHANNEL_CLOSE
            && ptype !== MESSAGE.CHANNEL_DATA
            && ptype !== MESSAGE.CHANNEL_EXTENDED_DATA
            && ptype !== MESSAGE.CHANNEL_WINDOW_ADJUST
            && ptype !== MESSAGE.DISCONNECT
            && ptype !== MESSAGE.USERAUTH_REQUEST)
          debug(msgPacket + msgPktType);
      }

      // Only parse packet if we are not re-keying or the packet is not a
      // transport layer packet needed for re-keying
      if (outstate.status === OUT_READY
          || ptype <= 4
          || (ptype >= 20 && ptype <= 49)) {
        if (parsePacket(this, callback) === false)
          return;

        if (instate.status === IN_INIT) {
          // We were reset due to some error/disagreement ?
          return;
        }
      } else if (outstate.status === OUT_REKEYING) {
        if (instate.rekeyQueue.length === MAX_PACKETS_REKEYING) {
          debug('DEBUG: Parser: Max incoming re-key queue length reached');
          this.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
          return callback(
            new Error('Incoming re-key queue length limit reached')
          );
        }

        // Make sure to record the sequence number in case we need it later on
        // when we drain the queue (e.g. unknown packet)
        var seqno = instate.seqno;
        if (++instate.seqno > MAX_SEQNO)
          instate.seqno = 0;

        instate.rekeyQueue.push(seqno, instate.payload);
      }

      instate.status = IN_PACKETBEFORE;
      instate.payload = undefined;
    }
    if (buffer !== undefined)
      buffer = undefined;
  }

  callback();
};

SSH2Stream.prototype.reset = function(noend) {
  if (this._state) {
    var state = this._state;
    state.incoming.status = IN_INIT;
    state.outgoing.status = OUT_INIT;
  } else {
    this._state = {
      authsQueue: [],
      hostkeyFormat: undefined,
      kex: undefined,
      kexdh: undefined,

      incoming: {
        status: IN_INIT,
        expectedPacket: undefined,
        search: undefined,
        greeting: undefined,
        seqno: 0,
        pktLen: undefined,
        padLen: undefined,
        pktExtra: undefined,
        payload: undefined,
        packet: undefined,
        kexinit: undefined,
        identRaw: undefined,
        rekeyQueue: [],
        ignoreNext: false,

        expect: {
          amount: undefined,
          type: undefined,
          ptr: 0,
          buf: undefined
        },

        decrypt: {
          instance: false,
          size: 8,
          isGCM: false,
          iv: undefined, // GCM
          key: undefined, // GCM
          buf: undefined,
          type: undefined
        },

        hmac: {
          size: undefined,
          key: undefined,
          buf: undefined,
          bufCompute: new Buffer(9),
          type: false
        },

        decompress: {
          instance: false,
          type: false
        }
      },

      outgoing: {
        status: OUT_INIT,
        seqno: 0,
        bufSeqno: new Buffer(4),
        rekeyQueue: [],
        kexinit: undefined,
        kexsecret: undefined,
        pubkey: undefined,
        exchangeHash: undefined,
        sessionId: undefined,
        sentNEWKEYS: false,

        encrypt: {
          instance: false,
          size: 8,
          isGCM: false,
          iv: undefined, // GCM
          key: undefined, // GCM
          type: undefined
        },

        hmac: {
          size: undefined,
          key: undefined,
          buf: undefined,
          type: false
        },

        compress: {
          instance: false,
          type: false
        }
      }
    };
  }
  if (!noend) {
    if (this.readable)
      this.push(null);
  }
};

// Common methods
// Global
SSH2Stream.prototype.disconnect = function(reason) {
  /*
    byte      SSH_MSG_DISCONNECT
    uint32    reason code
    string    description in ISO-10646 UTF-8 encoding
    string    language tag
  */
  var buf = new Buffer(1 + 4 + 4 + 4);

  buf.fill(0);
  buf[0] = MESSAGE.DISCONNECT;

  if (DISCONNECT_REASON[reason] === undefined)
    reason = DISCONNECT_REASON.BY_APPLICATION;
  buf.writeUInt32BE(reason, 1, true);

  this.debug('DEBUG: Outgoing: Writing DISCONNECT ('
             + DISCONNECT_REASON[reason]
             + ')');
  send(this, buf);
  this.reset();

  return false;
};
SSH2Stream.prototype.ping = function() {
  this.debug('DEBUG: Outgoing: Writing ping (GLOBAL_REQUEST: keepalive@openssh.com)');
  return send(this, PING_PACKET);
};
SSH2Stream.prototype.rekey = function() {
  var status = this._state.outgoing.status;
  if (status === OUT_REKEYING)
    throw new Error('A re-key is already in progress');
  else if (status !== OUT_READY)
    throw new Error('Cannot re-key yet');

  this.debug('DEBUG: Outgoing: Starting re-key');
  return KEXINIT(this);
};

// 'ssh-connection' service-specific
SSH2Stream.prototype.requestSuccess = function(data) {
  var buf;
  if (Buffer.isBuffer(data)) {
    buf = new Buffer(1 + data.length);

    buf[0] = MESSAGE.REQUEST_SUCCESS;

    data.copy(buf, 1);
  } else
    buf = REQUEST_SUCCESS_PACKET;

  this.debug('DEBUG: Outgoing: Writing REQUEST_SUCCESS');
  return send(this, buf);
};
SSH2Stream.prototype.requestFailure = function() {
  this.debug('DEBUG: Outgoing: Writing REQUEST_FAILURE');
  return send(this, REQUEST_FAILURE_PACKET);
};
SSH2Stream.prototype.channelSuccess = function(chan) {
  // Does not consume window space
  var buf = new Buffer(1 + 4);

  buf[0] = MESSAGE.CHANNEL_SUCCESS;

  buf.writeUInt32BE(chan, 1, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_SUCCESS (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelFailure = function(chan) {
  // Does not consume window space
  var buf = new Buffer(1 + 4);

  buf[0] = MESSAGE.CHANNEL_FAILURE;

  buf.writeUInt32BE(chan, 1, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_FAILURE (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelEOF = function(chan) {
  // Does not consume window space
  var buf = new Buffer(1 + 4);

  buf[0] = MESSAGE.CHANNEL_EOF;

  buf.writeUInt32BE(chan, 1, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_EOF (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelClose = function(chan) {
  // Does not consume window space
  var buf = new Buffer(1 + 4);

  buf[0] = MESSAGE.CHANNEL_CLOSE;

  buf.writeUInt32BE(chan, 1, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_CLOSE (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelWindowAdjust = function(chan, amount) {
  // Does not consume window space
  var buf = new Buffer(1 + 4 + 4);

  buf[0] = MESSAGE.CHANNEL_WINDOW_ADJUST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(amount, 5, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_WINDOW_ADJUST ('
             + chan
             + ', '
             + amount
             + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelData = function(chan, data) {
  var dataIsBuffer = Buffer.isBuffer(data);
  var dataLen = (dataIsBuffer ? data.length : Buffer.byteLength(data));
  var buf = new Buffer(1 + 4 + 4 + dataLen);

  buf[0] = MESSAGE.CHANNEL_DATA;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(dataLen, 5, true);
  if (dataIsBuffer)
    data.copy(buf, 9);
  else
    buf.write(data, 9, dataLen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_DATA (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelExtData = function(chan, data, type) {
  var dataIsBuffer = Buffer.isBuffer(data);
  var dataLen = (dataIsBuffer ? data.length : Buffer.byteLength(data));
  var buf = new Buffer(1 + 4 + 4 + 4 + dataLen);

  buf[0] = MESSAGE.CHANNEL_EXTENDED_DATA;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(type, 5, true);

  buf.writeUInt32BE(dataLen, 9, true);
  if (dataIsBuffer)
    data.copy(buf, 13);
  else
    buf.write(data, 13, dataLen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_EXTENDED_DATA (' + chan + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelOpenConfirm = function(remoteChan, localChan,
                                                   initWindow, maxPacket) {
  var buf = new Buffer(1 + 4 + 4 + 4 + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN_CONFIRMATION;

  buf.writeUInt32BE(remoteChan, 1, true);

  buf.writeUInt32BE(localChan, 5, true);

  buf.writeUInt32BE(initWindow, 9, true);

  buf.writeUInt32BE(maxPacket, 13, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN_CONFIRMATION (r:'
             + remoteChan
             + ', l:'
             + localChan
             + ')');
  return send(this, buf);
};
SSH2Stream.prototype.channelOpenFail = function(remoteChan, reason, desc,
                                                lang) {
  if (typeof desc !== 'string')
    desc = '';
  if (typeof lang !== 'string')
    lang = '';

  var descLen = Buffer.byteLength(desc);
  var langLen = Buffer.byteLength(lang);
  var p = 9;
  var buf = new Buffer(1 + 4 + 4 + 4 + descLen + 4 + langLen);

  buf[0] = MESSAGE.CHANNEL_OPEN_FAILURE;

  buf.writeUInt32BE(remoteChan, 1, true);

  buf.writeUInt32BE(reason, 5, true);

  buf.writeUInt32BE(descLen, p, true);
  p += 4;
  if (descLen) {
    buf.write(desc, p, descLen, 'utf8');
    p += descLen;
  }

  buf.writeUInt32BE(langLen, p, true);
  if (langLen)
    buf.write(lang, p += 4, langLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN_FAILURE ('
             + remoteChan
             + ')');
  return send(this, buf);
};

// Client-specific methods
// Global
SSH2Stream.prototype.service = function(svcName) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var svcNameLen = Buffer.byteLength(svcName);
  var buf = new Buffer(1 + 4 + svcNameLen);

  buf[0] = MESSAGE.SERVICE_REQUEST;

  buf.writeUInt32BE(svcNameLen, 1, true);
  buf.write(svcName, 5, svcNameLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing SERVICE_REQUEST (' + svcName + ')');
  return send(this, buf);
};
// 'ssh-connection' service-specific
SSH2Stream.prototype.tcpipForward = function(bindAddr, bindPort, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var addrlen = Buffer.byteLength(bindAddr);
  var buf = new Buffer(1 + 4 + 13 + 1 + 4 + addrlen + 4);

  buf[0] = MESSAGE.GLOBAL_REQUEST;

  buf.writeUInt32BE(13, 1, true);
  buf.write('tcpip-forward', 5, 13, 'ascii');

  buf[18] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(addrlen, 19, true);
  buf.write(bindAddr, 23, addrlen, 'ascii');

  buf.writeUInt32BE(bindPort, 23 + addrlen, true);

  this.debug('DEBUG: Outgoing: Writing GLOBAL_REQUEST (tcpip-forward)');
  return send(this, buf);
};
SSH2Stream.prototype.cancelTcpipForward = function(bindAddr, bindPort,
                                                   wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var addrlen = Buffer.byteLength(bindAddr);
  var buf = new Buffer(1 + 4 + 20 + 1 + 4 + addrlen + 4);

  buf[0] = MESSAGE.GLOBAL_REQUEST;

  buf.writeUInt32BE(20, 1, true);
  buf.write('cancel-tcpip-forward', 5, 20, 'ascii');

  buf[25] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(addrlen, 26, true);
  buf.write(bindAddr, 30, addrlen, 'ascii');

  buf.writeUInt32BE(bindPort, 30 + addrlen, true);

  this.debug('DEBUG: Outgoing: Writing GLOBAL_REQUEST (cancel-tcpip-forward)');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_streamLocalForward = function(socketPath,
                                                           wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var pathlen = Buffer.byteLength(pathlen);
  var buf = new Buffer(1 + 4 + 31 + 1 + 4 + pathlen);

  buf[0] = MESSAGE.GLOBAL_REQUEST;

  buf.writeUInt32BE(31, 1, true);
  buf.write('streamlocal-forward@openssh.com', 5, 31, 'ascii');

  buf[36] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(pathlen, 37, true);
  buf.write(socketPath, 41, pathlen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing GLOBAL_REQUEST (streamlocal-forward@openssh.com)');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_cancelStreamLocalForward = function(socketPath,
                                                                 wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var pathlen = Buffer.byteLength(pathlen);
  var buf = new Buffer(1 + 4 + 38 + 1 + 4 + pathlen);

  buf[0] = MESSAGE.GLOBAL_REQUEST;

  buf.writeUInt32BE(38, 1, true);
  buf.write('cancel-streamlocal-forward@openssh.com', 5, 38, 'ascii');

  buf[43] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(pathlen, 44, true);
  buf.write(socketPath, 48, pathlen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing GLOBAL_REQUEST (cancel-streamlocal-forward@openssh.com)');
  return send(this, buf);
};
SSH2Stream.prototype.directTcpip = function(chan, initWindow, maxPacket, cfg) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var srclen = Buffer.byteLength(cfg.srcIP);
  var dstlen = Buffer.byteLength(cfg.dstIP);
  var p = 29;
  var buf = new Buffer(1 + 4 + 12 + 4 + 4 + 4 + 4 + srclen + 4 + 4 + dstlen
                       + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(12, 1, true);
  buf.write('direct-tcpip', 5, 12, 'ascii');

  buf.writeUInt32BE(chan, 17, true);

  buf.writeUInt32BE(initWindow, 21, true);

  buf.writeUInt32BE(maxPacket, 25, true);

  buf.writeUInt32BE(dstlen, p, true);
  buf.write(cfg.dstIP, p += 4, dstlen, 'ascii');

  buf.writeUInt32BE(cfg.dstPort, p += dstlen, true);

  buf.writeUInt32BE(srclen, p += 4, true);
  buf.write(cfg.srcIP, p += 4, srclen, 'ascii');

  buf.writeUInt32BE(cfg.srcPort, p += srclen, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', direct-tcpip)');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_directStreamLocal = function(chan, initWindow,
                                                          maxPacket, cfg) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var pathlen = Buffer.byteLength(cfg.socketPath);
  var p = 47;
  var buf = new Buffer(1 + 4 + 30 + 4 + 4 + 4 + 4 + pathlen + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(30, 1, true);
  buf.write('direct-streamlocal@openssh.com', 5, 30, 'ascii');

  buf.writeUInt32BE(chan, 35, true);

  buf.writeUInt32BE(initWindow, 39, true);

  buf.writeUInt32BE(maxPacket, 43, true);

  buf.writeUInt32BE(pathlen, p, true);
  buf.write(cfg.socketPath, p += 4, pathlen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', direct-streamlocal@openssh.com)');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_noMoreSessions = function(wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var buf = new Buffer(1 + 4 + 28 + 1);

  buf[0] = MESSAGE.GLOBAL_REQUEST;

  buf.writeUInt32BE(28, 1, true);
  buf.write('no-more-sessions@openssh.com', 5, 28, 'ascii');

  buf[33] = (wantReply === undefined || wantReply === true ? 1 : 0);

  this.debug('DEBUG: Outgoing: Writing GLOBAL_REQUEST (no-more-sessions@openssh.com)');
  return send(this, buf);
};
SSH2Stream.prototype.session = function(chan, initWindow, maxPacket) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var buf = new Buffer(1 + 4 + 7 + 4 + 4 + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(7, 1, true);
  buf.write('session', 5, 7, 'ascii');

  buf.writeUInt32BE(chan, 12, true);

  buf.writeUInt32BE(initWindow, 16, true);

  buf.writeUInt32BE(maxPacket, 20, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', session)');
  return send(this, buf);
};
SSH2Stream.prototype.windowChange = function(chan, rows, cols, height, width) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var buf = new Buffer(1 + 4 + 4 + 13 + 1 + 4 + 4 + 4 + 4);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(13, 5, true);
  buf.write('window-change', 9, 13, 'ascii');

  buf[22] = 0;

  buf.writeUInt32BE(cols, 23, true);

  buf.writeUInt32BE(rows, 27, true);

  buf.writeUInt32BE(width, 31, true);

  buf.writeUInt32BE(height, 35, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', window-change)');
  return send(this, buf);
};
SSH2Stream.prototype.pty = function(chan, rows, cols, height,
                                    width, term, modes, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  if (!term || !term.length)
    term = 'vt100';
  if (modes
      && !Buffer.isBuffer(modes)
      && !Array.isArray(modes)
      && typeof modes === 'object')
    modes = modesToBytes(modes);
  if (!modes || !modes.length)
    modes = NO_TERMINAL_MODES_BUFFER;

  var termLen = term.length;
  var modesLen = modes.length;
  var p = 21;
  var buf = new Buffer(1 + 4 + 4 + 7 + 1 + 4 + termLen + 4 + 4 + 4 + 4 + 4
                       + modesLen);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(7, 5, true);
  buf.write('pty-req', 9, 7, 'ascii');

  buf[16] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(termLen, 17, true);
  buf.write(term, 21, termLen, 'utf8');

  buf.writeUInt32BE(cols, p += termLen, true);

  buf.writeUInt32BE(rows, p += 4, true);

  buf.writeUInt32BE(width, p += 4, true);

  buf.writeUInt32BE(height, p += 4, true);

  buf.writeUInt32BE(modesLen, p += 4, true);
  p += 4;
  if (Array.isArray(modes)) {
    for (var i = 0; i < modesLen; ++i)
      buf[p++] = modes[i];
  } else if (Buffer.isBuffer(modes)) {
    modes.copy(buf, p);
  }

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', pty-req)');
  return send(this, buf);
};
SSH2Stream.prototype.shell = function(chan, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var buf = new Buffer(1 + 4 + 4 + 5 + 1);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(5, 5, true);
  buf.write('shell', 9, 5, 'ascii');

  buf[14] = (wantReply === undefined || wantReply === true ? 1 : 0);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', shell)');
  return send(this, buf);
};
SSH2Stream.prototype.exec = function(chan, cmd, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var cmdlen = (Buffer.isBuffer(cmd) ? cmd.length : Buffer.byteLength(cmd));
  var buf = new Buffer(1 + 4 + 4 + 4 + 1 + 4 + cmdlen);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(4, 5, true);
  buf.write('exec', 9, 4, 'ascii');

  buf[13] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(cmdlen, 14, true);
  if (Buffer.isBuffer(cmd))
    cmd.copy(buf, 18);
  else
    buf.write(cmd, 18, cmdlen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', exec)');
  return send(this, buf);
};
SSH2Stream.prototype.signal = function(chan, signal) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  signal = signal.toUpperCase();
  if (signal.slice(0, 3) === 'SIG')
    signal = signal.substring(3);

  if (SIGNALS.indexOf(signal) === -1)
    throw new Error('Invalid signal: ' + signal);

  var signalLen = signal.length;
  var buf = new Buffer(1 + 4 + 4 + 6 + 1 + 4 + signalLen);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(6, 5, true);
  buf.write('signal', 9, 6, 'ascii');

  buf[15] = 0;

  buf.writeUInt32BE(signalLen, 16, true);
  buf.write(signal, 20, signalLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', signal)');
  return send(this, buf);
};
SSH2Stream.prototype.env = function(chan, key, val, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var keyLen = Buffer.byteLength(key);
  var valLen = (Buffer.isBuffer(val) ? val.length : Buffer.byteLength(val));
  var buf = new Buffer(1 + 4 + 4 + 3 + 1 + 4 + keyLen + 4 + valLen);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(3, 5, true);
  buf.write('env', 9, 3, 'ascii');

  buf[12] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(keyLen, 13, true);
  buf.write(key, 17, keyLen, 'ascii');

  buf.writeUInt32BE(valLen, 17 + keyLen, true);
  if (Buffer.isBuffer(val))
    val.copy(buf, 17 + keyLen + 4);
  else
    buf.write(val, 17 + keyLen + 4, valLen, 'utf8');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', env)');
  return send(this, buf);
};
SSH2Stream.prototype.x11Forward = function(chan, cfg, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var protolen = Buffer.byteLength(cfg.protocol);
  var cookielen = Buffer.byteLength(cfg.cookie);
  var buf = new Buffer(1 + 4 + 4 + 7 + 1 + 1 + 4 + protolen + 4 + cookielen
                       + 4);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(7, 5, true);
  buf.write('x11-req', 9, 7, 'ascii');

  buf[16] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf[17] = (cfg.single ? 1 : 0);

  buf.writeUInt32BE(protolen, 18, true);
  var bp = 22;
  if (Buffer.isBuffer(cfg.protocol))
    cfg.protocol.copy(buf, bp);
  else
    buf.write(cfg.protocol, bp, protolen, 'utf8');
  bp += protolen;

  buf.writeUInt32BE(cookielen, bp, true);
  bp += 4;
  if (Buffer.isBuffer(cfg.cookie))
    cfg.cookie.copy(buf, bp);
  else
    buf.write(cfg.cookie, bp, cookielen, 'utf8');
  bp += cookielen;

  buf.writeUInt32BE((cfg.screen || 0), bp, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', x11-req)');
  return send(this, buf);
};
SSH2Stream.prototype.subsystem = function(chan, name, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var nameLen = Buffer.byteLength(name);
  var buf = new Buffer(1 + 4 + 4 + 9 + 1 + 4 + nameLen);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(9, 5, true);
  buf.write('subsystem', 9, 9, 'ascii');

  buf[18] = (wantReply === undefined || wantReply === true ? 1 : 0);

  buf.writeUInt32BE(nameLen, 19, true);
  buf.write(name, 23, nameLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', subsystem: '
             + name
             + ')');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_agentForward = function(chan, wantReply) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  // Does not consume window space
  var buf = new Buffer(1 + 4 + 4 + 26 + 1);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(26, 5, true);
  buf.write('auth-agent-req@openssh.com', 9, 26, 'ascii');

  buf[35] = (wantReply === undefined || wantReply === true ? 1 : 0);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', auth-agent-req@openssh.com)');
  return send(this, buf);
};
// 'ssh-userauth' service-specific
SSH2Stream.prototype.authPassword = function(username, password) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var userLen = Buffer.byteLength(username);
  var passLen = Buffer.byteLength(password);
  var p = 0;
  var buf = new Buffer(1
                       + 4 + userLen
                       + 4 + 14 // "ssh-connection"
                       + 4 + 8 // "password"
                       + 1
                       + 4 + passLen);

  buf[p] = MESSAGE.USERAUTH_REQUEST;

  buf.writeUInt32BE(userLen, ++p, true);
  buf.write(username, p += 4, userLen, 'utf8');

  buf.writeUInt32BE(14, p += userLen, true);
  buf.write('ssh-connection', p += 4, 14, 'ascii');

  buf.writeUInt32BE(8, p += 14, true);
  buf.write('password', p += 4, 8, 'ascii');

  buf[p += 8] = 0;

  buf.writeUInt32BE(passLen, ++p, true);
  buf.write(password, p += 4, passLen, 'utf8');

  this._state.authsQueue.push('password');
  this.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (password)');
  return send(this, buf);
};
SSH2Stream.prototype.authPK = function(username, pubKey, cbSign) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var self = this;
  var outstate = this._state.outgoing;
  var pubKeyFullType;

  if (pubKey.public) {
    pubKeyFullType = pubKey.fulltype;
    pubKey = pubKey.public;
  } else {
    pubKeyFullType = pubKey.toString('ascii',
                                     4,
                                     4 + pubKey.readUInt32BE(0, true));
  }

  var userLen = Buffer.byteLength(username);
  var algoLen = Buffer.byteLength(pubKeyFullType);
  var pubKeyLen = pubKey.length;
  var sesLen = outstate.sessionId.length;
  var p = 0;
  var buf = new Buffer((cbSign ? 4 + sesLen : 0)
                       + 1
                       + 4 + userLen
                       + 4 + 14 // "ssh-connection"
                       + 4 + 9 // "publickey"
                       + 1
                       + 4 + algoLen
                       + 4 + pubKeyLen
                      );

  if (cbSign) {
    buf.writeUInt32BE(sesLen, p, true);
    outstate.sessionId.copy(buf, p += 4);
    buf[p += sesLen] = MESSAGE.USERAUTH_REQUEST;
  } else
    buf[p] = MESSAGE.USERAUTH_REQUEST;

  buf.writeUInt32BE(userLen, ++p, true);
  buf.write(username, p += 4, userLen, 'utf8');

  buf.writeUInt32BE(14, p += userLen, true);
  buf.write('ssh-connection', p += 4, 14, 'ascii');

  buf.writeUInt32BE(9, p += 14, true);
  buf.write('publickey', p += 4, 9, 'ascii');

  buf[p += 9] = (cbSign ? 1 : 0);

  buf.writeUInt32BE(algoLen, ++p, true);
  buf.write(pubKeyFullType, p += 4, algoLen, 'ascii');

  buf.writeUInt32BE(pubKeyLen, p += algoLen, true);
  pubKey.copy(buf, p += 4);

  if (!cbSign) {
    this._state.authsQueue.push('publickey');
    this.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (publickey -- check)');
    return send(this, buf);
  }

  cbSign(buf, function(signature) {
    if (pubKeyFullType === 'ssh-dss') {
      signature = DSASigBERToBare(signature);
    } else if (pubKeyFullType !== 'ssh-rsa') {
      // ECDSA
      signature = ECDSASigASN1ToSSH(signature);
    }

    var sigLen = signature.length;
    var sigbuf = new Buffer(1
                            + 4 + userLen
                            + 4 + 14 // "ssh-connection"
                            + 4 + 9 // "publickey"
                            + 1
                            + 4 + algoLen
                            + 4 + pubKeyLen
                            + 4 // 4 + algoLen + 4 + sigLen
                            + 4 + algoLen
                            + 4 + sigLen);

    p = 0;

    sigbuf[p] = MESSAGE.USERAUTH_REQUEST;

    sigbuf.writeUInt32BE(userLen, ++p, true);
    sigbuf.write(username, p += 4, userLen, 'utf8');

    sigbuf.writeUInt32BE(14, p += userLen, true);
    sigbuf.write('ssh-connection', p += 4, 14, 'ascii');

    sigbuf.writeUInt32BE(9, p += 14, true);
    sigbuf.write('publickey', p += 4, 9, 'ascii');

    sigbuf[p += 9] = 1;

    sigbuf.writeUInt32BE(algoLen, ++p, true);
    sigbuf.write(pubKeyFullType, p += 4, algoLen, 'ascii');

    sigbuf.writeUInt32BE(pubKeyLen, p += algoLen, true);
    pubKey.copy(sigbuf, p += 4);
    sigbuf.writeUInt32BE(4 + algoLen + 4 + sigLen, p += pubKeyLen, true);
    sigbuf.writeUInt32BE(algoLen, p += 4, true);
    sigbuf.write(pubKeyFullType, p += 4, algoLen, 'ascii');
    sigbuf.writeUInt32BE(sigLen, p += algoLen, true);
    signature.copy(sigbuf, p += 4);

    // Servers shouldn't send packet type 60 in response to signed publickey
    // attempts, but if they do, interpret as type 60.
    self._state.authsQueue.push('publickey');
    self.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (publickey)');
    return send(self, sigbuf);
  });
  return true;
};
SSH2Stream.prototype.authHostbased = function(username, pubKey, hostname,
                                              userlocal, cbSign) {
  // TODO: Make DRY by sharing similar code with authPK()

  if (this.server)
    throw new Error('Client-only method called in server mode');

  var self = this;
  var outstate = this._state.outgoing;
  var pubKeyFullType;

  if (pubKey.public) {
    pubKeyFullType = pubKey.fulltype;
    pubKey = pubKey.public;
  } else {
    pubKeyFullType = pubKey.toString('ascii',
                                     4,
                                     4 + pubKey.readUInt32BE(0, true));
  }

  var userLen = Buffer.byteLength(username);
  var algoLen = Buffer.byteLength(pubKeyFullType);
  var pubKeyLen = pubKey.length;
  var sesLen = outstate.sessionId.length;
  var hostnameLen = Buffer.byteLength(hostname);
  var userlocalLen = Buffer.byteLength(userlocal);
  var p = 0;
  var buf = new Buffer(4 + sesLen
                       + 1
                       + 4 + userLen
                       + 4 + 14 // "ssh-connection"
                       + 4 + 9 // "hostbased"
                       + 4 + algoLen
                       + 4 + pubKeyLen
                       + 4 + hostnameLen
                       + 4 + userlocalLen
                      );

  buf.writeUInt32BE(sesLen, p, true);
  outstate.sessionId.copy(buf, p += 4);

  buf[p += sesLen] = MESSAGE.USERAUTH_REQUEST;

  buf.writeUInt32BE(userLen, ++p, true);
  buf.write(username, p += 4, userLen, 'utf8');

  buf.writeUInt32BE(14, p += userLen, true);
  buf.write('ssh-connection', p += 4, 14, 'ascii');

  buf.writeUInt32BE(9, p += 14, true);
  buf.write('hostbased', p += 4, 9, 'ascii');

  buf.writeUInt32BE(algoLen, p += 9, true);
  buf.write(pubKeyFullType, p += 4, algoLen, 'ascii');

  buf.writeUInt32BE(pubKeyLen, p += algoLen, true);
  pubKey.copy(buf, p += 4);

  buf.writeUInt32BE(hostnameLen, p += pubKeyLen, true);
  buf.write(hostname, p += 4, hostnameLen, 'ascii');

  buf.writeUInt32BE(userlocalLen, p += hostnameLen, true);
  buf.write(userlocal, p += 4, userlocalLen, 'utf8');

  cbSign(buf, function(signature) {
    if (pubKeyFullType === 'ssh-dss') {
      signature = DSASigBERToBare(signature);
    } else if (pubKeyFullType !== 'ssh-rsa') {
      // ECDSA
      signature = ECDSASigASN1ToSSH(signature);
    }
    var sigLen = signature.length;
    var sigbuf = new Buffer((buf.length - sesLen) + sigLen);

    buf.copy(sigbuf, 0, 4 + sesLen);
    sigbuf.writeUInt32BE(sigLen, sigbuf.length - sigLen - 4, true);
    signature.copy(sigbuf, sigbuf.length - sigLen);

    self._state.authsQueue.push('hostbased');
    self.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (hostbased)');
    return send(self, sigbuf);
  });
  return true;
};
SSH2Stream.prototype.authKeyboard = function(username) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var userLen = Buffer.byteLength(username);
  var p = 0;
  var buf = new Buffer(1
                       + 4 + userLen
                       + 4 + 14 // "ssh-connection"
                       + 4 + 20 // "keyboard-interactive"
                       + 4 // no language set
                       + 4 // no submethods
                      );

  buf[p] = MESSAGE.USERAUTH_REQUEST;

  buf.writeUInt32BE(userLen, ++p, true);
  buf.write(username, p += 4, userLen, 'utf8');

  buf.writeUInt32BE(14, p += userLen, true);
  buf.write('ssh-connection', p += 4, 14, 'ascii');

  buf.writeUInt32BE(20, p += 14, true);
  buf.write('keyboard-interactive', p += 4, 20, 'ascii');

  buf.writeUInt32BE(0, p += 20, true);

  buf.writeUInt32BE(0, p += 4, true);

  this._state.authsQueue.push('keyboard-interactive');
  this.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (keyboard-interactive)');
  return send(this, buf);
};
SSH2Stream.prototype.authNone = function(username) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var userLen = Buffer.byteLength(username);
  var p = 0;
  var buf = new Buffer(1
                       + 4 + userLen
                       + 4 + 14 // "ssh-connection"
                       + 4 + 4 // "none"
                      );

  buf[p] = MESSAGE.USERAUTH_REQUEST;

  buf.writeUInt32BE(userLen, ++p, true);
  buf.write(username, p += 4, userLen, 'utf8');

  buf.writeUInt32BE(14, p += userLen, true);
  buf.write('ssh-connection', p += 4, 14, 'ascii');

  buf.writeUInt32BE(4, p += 14, true);
  buf.write('none', p += 4, 4, 'ascii');

  this._state.authsQueue.push('none');
  this.debug('DEBUG: Outgoing: Writing USERAUTH_REQUEST (none)');
  return send(this, buf);
};
SSH2Stream.prototype.authInfoRes = function(responses) {
  if (this.server)
    throw new Error('Client-only method called in server mode');

  var responsesLen = 0;
  var p = 0;
  var resLen;
  var len;
  var i;

  if (responses) {
    for (i = 0, len = responses.length; i < len; ++i)
      responsesLen += 4 + Buffer.byteLength(responses[i]);
  }
  var buf = new Buffer(1 + 4 + responsesLen);

  buf[p++] = MESSAGE.USERAUTH_INFO_RESPONSE;

  buf.writeUInt32BE(responses ? responses.length : 0, p, true);
  if (responses) {
    p += 4;
    for (i = 0, len = responses.length; i < len; ++i) {
      resLen = Buffer.byteLength(responses[i]);
      buf.writeUInt32BE(resLen, p, true);
      p += 4;
      if (resLen) {
        buf.write(responses[i], p, resLen, 'utf8');
        p += resLen;
      }
    }
  }

  this.debug('DEBUG: Outgoing: Writing USERAUTH_INFO_RESPONSE');
  return send(this, buf);
};

// Server-specific methods
// Global
SSH2Stream.prototype.serviceAccept = function(svcName) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var svcNameLen = svcName.length;
  var buf = new Buffer(1 + 4 + svcNameLen);

  buf[0] = MESSAGE.SERVICE_ACCEPT;

  buf.writeUInt32BE(svcNameLen, 1, true);
  buf.write(svcName, 5, svcNameLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing SERVICE_ACCEPT (' + svcName + ')');
  send(this, buf);

  if (this.server && this.banner && svcName === 'ssh-userauth') {
    /*
      byte      SSH_MSG_USERAUTH_BANNER
      string    message in ISO-10646 UTF-8 encoding
      string    language tag
    */
    var bannerLen = Buffer.byteLength(this.banner);
    var packetLen = 1 + 4 + bannerLen + 4;
    if (packetLen > BUFFER_MAX_LEN) {
      bannerLen -= 1 + 4 + 4;
      packetLen -= 1 + 4 + 4;
    }
    var packet = new Buffer(packetLen);
    packet[0] = MESSAGE.USERAUTH_BANNER;
    packet.writeUInt32BE(bannerLen, 1, true);
    packet.write(this.banner, 5, bannerLen, 'utf8');
    packet.fill(0, packetLen - 4); // Empty language tag
    this.debug('DEBUG: Outgoing: Writing USERAUTH_BANNER');
    send(this, packet);
    this.banner = undefined; // Prevent banner from being displayed again
  }
};
// 'ssh-connection' service-specific
SSH2Stream.prototype.forwardedTcpip = function(chan, initWindow, maxPacket,
                                               cfg) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var boundAddrLen = Buffer.byteLength(cfg.boundAddr);
  var remoteAddrLen = Buffer.byteLength(cfg.remoteAddr);
  var p = 36 + boundAddrLen;
  var buf = new Buffer(1 + 4 + 15 + 4 + 4 + 4 + 4 + boundAddrLen + 4 + 4
                       + remoteAddrLen + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(15, 1, true);
  buf.write('forwarded-tcpip', 5, 15, 'ascii');

  buf.writeUInt32BE(chan, 20, true);

  buf.writeUInt32BE(initWindow, 24, true);

  buf.writeUInt32BE(maxPacket, 28, true);

  buf.writeUInt32BE(boundAddrLen, 32, true);
  buf.write(cfg.boundAddr, 36, boundAddrLen, 'ascii');

  buf.writeUInt32BE(cfg.boundPort, p, true);

  buf.writeUInt32BE(remoteAddrLen, p += 4, true);
  buf.write(cfg.remoteAddr, p += 4, remoteAddrLen, 'ascii');

  buf.writeUInt32BE(cfg.remotePort, p += remoteAddrLen, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', forwarded-tcpip)');
  return send(this, buf);
};
SSH2Stream.prototype.x11 = function(chan, initWindow, maxPacket, cfg) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var addrLen = Buffer.byteLength(cfg.originAddr);
  var p = 24 + addrLen;
  var buf = new Buffer(1 + 4 + 3 + 4 + 4 + 4 + 4 + addrLen + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(3, 1, true);
  buf.write('x11', 5, 3, 'ascii');

  buf.writeUInt32BE(chan, 8, true);

  buf.writeUInt32BE(initWindow, 12, true);

  buf.writeUInt32BE(maxPacket, 16, true);

  buf.writeUInt32BE(addrLen, 20, true);
  buf.write(cfg.originAddr, 24, addrLen, 'ascii');

  buf.writeUInt32BE(cfg.originPort, p, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', x11)');
  return send(this, buf);
};
SSH2Stream.prototype.openssh_forwardedStreamLocal = function(chan, initWindow,
                                                             maxPacket, cfg) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var pathlen = Buffer.byteLength(cfg.socketPath);
  var buf = new Buffer(1 + 4 + 33 + 4 + 4 + 4 + 4 + pathlen + 4);

  buf[0] = MESSAGE.CHANNEL_OPEN;

  buf.writeUInt32BE(33, 1, true);
  buf.write('forwarded-streamlocal@openssh.com', 5, 33, 'ascii');

  buf.writeUInt32BE(chan, 38, true);

  buf.writeUInt32BE(initWindow, 42, true);

  buf.writeUInt32BE(maxPacket, 46, true);

  buf.writeUInt32BE(pathlen, 50, true);
  buf.write(cfg.socketPath, 54, pathlen, 'utf8');

  buf.writeUInt32BE(0, 54 + pathlen, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_OPEN ('
             + chan
             + ', forwarded-streamlocal@openssh.com)');
  return send(this, buf);
};
SSH2Stream.prototype.exitStatus = function(chan, status) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  // Does not consume window space
  var buf = new Buffer(1 + 4 + 4 + 11 + 1 + 4);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(11, 5, true);
  buf.write('exit-status', 9, 11, 'ascii');

  buf[20] = 0;

  buf.writeUInt32BE(status, 21, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', exit-status)');
  return send(this, buf);
};
SSH2Stream.prototype.exitSignal = function(chan, name, coreDumped, msg) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  // Does not consume window space
  var nameLen = Buffer.byteLength(name);
  var msgLen = (msg ? Buffer.byteLength(msg) : 0);
  var p = 25 + nameLen;
  var buf = new Buffer(1 + 4 + 4 + 11 + 1 + 4 + nameLen + 1 + 4 + msgLen + 4);

  buf[0] = MESSAGE.CHANNEL_REQUEST;

  buf.writeUInt32BE(chan, 1, true);

  buf.writeUInt32BE(11, 5, true);
  buf.write('exit-signal', 9, 11, 'ascii');

  buf[20] = 0;

  buf.writeUInt32BE(nameLen, 21, true);
  buf.write(name, 25, nameLen, 'utf8');

  buf[p++] = (coreDumped ? 1 : 0);

  buf.writeUInt32BE(msgLen, p, true);
  p += 4;
  if (msgLen) {
    buf.write(msg, p, msgLen, 'utf8');
    p += msgLen;
  }

  buf.writeUInt32BE(0, p, true);

  this.debug('DEBUG: Outgoing: Writing CHANNEL_REQUEST ('
             + chan
             + ', exit-signal)');
  return send(this, buf);
};
// 'ssh-userauth' service-specific
SSH2Stream.prototype.authFailure = function(authMethods, isPartial) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var authsQueue = this._state.authsQueue;
  if (!authsQueue.length)
    throw new Error('No auth in progress');

  var methods;

  if (typeof authMethods === 'boolean') {
    isPartial = authMethods;
    authMethods = undefined;
  }

  if (authMethods) {
    methods = [];
    for (var i = 0, len = authMethods.length; i < len; ++i) {
      if (authMethods[i].toLowerCase() === 'none')
        continue;
      methods.push(authMethods[i]);
    }
    methods = methods.join(',');
  } else
    methods = '';

  var methodsLen = methods.length;
  var buf = new Buffer(1 + 4 + methodsLen + 1);

  buf[0] = MESSAGE.USERAUTH_FAILURE;

  buf.writeUInt32BE(methodsLen, 1, true);
  buf.write(methods, 5, methodsLen, 'ascii');

  buf[5 + methodsLen] = (isPartial === true ? 1 : 0);

  this._state.authsQueue.shift();
  this.debug('DEBUG: Outgoing: Writing USERAUTH_FAILURE');
  return send(this, buf);
};
SSH2Stream.prototype.authSuccess = function() {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var authsQueue = this._state.authsQueue;
  if (!authsQueue.length)
    throw new Error('No auth in progress');

  this._state.authsQueue.shift();
  this.debug('DEBUG: Outgoing: Writing USERAUTH_SUCCESS');
  return send(this, USERAUTH_SUCCESS_PACKET);
};
SSH2Stream.prototype.authPKOK = function(keyAlgo, key) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var authsQueue = this._state.authsQueue;
  if (!authsQueue.length || authsQueue[0] !== 'publickey')
    throw new Error('"publickey" auth not in progress');

  var keyAlgoLen = keyAlgo.length;
  var keyLen = key.length;
  var buf = new Buffer(1 + 4 + keyAlgoLen + 4 + keyLen);

  buf[0] = MESSAGE.USERAUTH_PK_OK;

  buf.writeUInt32BE(keyAlgoLen, 1, true);
  buf.write(keyAlgo, 5, keyAlgoLen, 'ascii');

  buf.writeUInt32BE(keyLen, 5 + keyAlgoLen, true);
  key.copy(buf, 5 + keyAlgoLen + 4);

  this._state.authsQueue.shift();
  this.debug('DEBUG: Outgoing: Writing USERAUTH_PK_OK');
  return send(this, buf);
};
SSH2Stream.prototype.authPasswdChg = function(prompt, lang) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var promptLen = Buffer.byteLength(prompt);
  var langLen = lang ? lang.length : 0;
  var p = 0;
  var buf = new Buffer(1 + 4 + promptLen + 4 + langLen);

  buf[p] = MESSAGE.USERAUTH_PASSWD_CHANGEREQ;

  buf.writeUInt32BE(promptLen, ++p, true);
  buf.write(prompt, p += 4, promptLen, 'utf8');

  buf.writeUInt32BE(langLen, p += promptLen, true);
  if (langLen)
    buf.write(lang, p += 4, langLen, 'ascii');

  this.debug('DEBUG: Outgoing: Writing USERAUTH_PASSWD_CHANGEREQ');
  return send(this, buf);
};
SSH2Stream.prototype.authInfoReq = function(name, instructions, prompts) {
  if (!this.server)
    throw new Error('Server-only method called in client mode');

  var promptsLen = 0;
  var nameLen = name ? Buffer.byteLength(name) : 0;
  var instrLen = instructions ? Buffer.byteLength(instructions) : 0;
  var p = 0;
  var promptLen;
  var prompt;
  var len;
  var i;

  for (i = 0, len = prompts.length; i < len; ++i)
    promptsLen += 4 + Buffer.byteLength(prompts[i].prompt) + 1;
  var buf = new Buffer(1 + 4 + nameLen + 4 + instrLen + 4 + 4 + promptsLen);

  buf[p++] = MESSAGE.USERAUTH_INFO_REQUEST;

  buf.writeUInt32BE(nameLen, p, true);
  p += 4;
  if (name) {
    buf.write(name, p, nameLen, 'utf8');
    p += nameLen;
  }

  buf.writeUInt32BE(instrLen, p, true);
  p += 4;
  if (instructions) {
    buf.write(instructions, p, instrLen, 'utf8');
    p += instrLen;
  }

  buf.writeUInt32BE(0, p, true);
  p += 4;

  buf.writeUInt32BE(prompts.length, p, true);
  p += 4;
  for (i = 0, len = prompts.length; i < len; ++i) {
    prompt = prompts[i];
    promptLen = Buffer.byteLength(prompt.prompt);
    buf.writeUInt32BE(promptLen, p, true);
    p += 4;
    if (promptLen) {
      buf.write(prompt.prompt, p, promptLen, 'utf8');
      p += promptLen;
    }
    buf[p++] = (prompt.echo ? 1 : 0);
  }

  this.debug('DEBUG: Outgoing: Writing USERAUTH_INFO_REQUEST');
  return send(this, buf);
};

// Shared incoming/parser functions
function onDISCONNECT(self, reason, code, desc, lang) { // Client/Server
  if (code !== DISCONNECT_REASON.BY_APPLICATION) {
    var err = new Error(desc || reason);
    err.code = code;
    self.emit('error', err);
  }
  self.reset();
}

function onKEXINIT(self, init, firstFollows) { // Client/Server
  var state = self._state;
  var outstate = state.outgoing;

  if (outstate.status === OUT_READY) {
    self.debug('DEBUG: Received re-key request');
    outstate.status = OUT_REKEYING;
    outstate.kexinit = undefined;
    KEXINIT(self, check);
  } else
    check();

  function check() {
    if (check_KEXINIT(self, init, firstFollows) === true) {
      var isGEX = RE_GEX.test(state.kexdh);
      if (!self.server) {
        if (isGEX)
          KEXDH_GEX_REQ(self);
        else
          KEXDH_INIT(self);
      } else {
        if (isGEX)
          state.incoming.expectedPacket = 'KEXDH_GEX_REQ';
        else
          state.incoming.expectedPacket = 'KEXDH_INIT';
      }
    }
  }
}

function check_KEXINIT(self, init, firstFollows) {
  var state = self._state;
  var instate = state.incoming;
  var outstate = state.outgoing;
  var debug = self.debug;
  var serverList;
  var clientList;
  var val;
  var len;
  var i;

  debug('DEBUG: Comparing KEXINITs ...');

  var algos = self.config.algorithms;

  var kexList = algos.kex;
  if (self.remoteBugs & BUGS.BAD_DHGEX) {
    var copied = false;
    for (var j = kexList.length - 1; j >= 0; --j) {
      if (kexList[j].indexOf('group-exchange') !== -1) {
        if (!copied) {
          kexList = kexList.slice();
          copied = true;
        }
        kexList.splice(j, 1);
      }
    }
  }

  debug('DEBUG: (local) KEX algorithms: ' + kexList);
  debug('DEBUG: (remote) KEX algorithms: ' + init.algorithms.kex);
  if (self.server) {
    serverList = kexList;
    clientList = init.algorithms.kex;
  } else {
    serverList = init.algorithms.kex;
    clientList = kexList;
  }
  // Check for agreeable key exchange algorithm
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching key exchange algorithm');
    var err = new Error('Handshake failed: no matching key exchange algorithm');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  var kex_algorithm = clientList[i];
  debug('DEBUG: KEX algorithm: ' + kex_algorithm);
  if (firstFollows
      && (!init.algorithms.kex.length
          || kex_algorithm !== init.algorithms.kex[0])) {
    // Ignore next incoming packet, it was a wrong first guess at KEX algorithm
    instate.ignoreNext = true;
  }

  debug('DEBUG: (local) Host key formats: ' + algos.serverHostKey);
  debug('DEBUG: (remote) Host key formats: ' + init.algorithms.srvHostKey);
  if (self.server) {
    serverList = algos.serverHostKey;
    clientList = init.algorithms.srvHostKey;
  } else {
    serverList = init.algorithms.srvHostKey;
    clientList = algos.serverHostKey;
  }
  // Check for agreeable server host key format
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching host key format');
    var err = new Error('Handshake failed: no matching host key format');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  state.hostkeyFormat = clientList[i];
  debug('DEBUG: Host key format: ' + state.hostkeyFormat);

  debug('DEBUG: (local) Client->Server ciphers: ' + algos.cipher);
  debug('DEBUG: (remote) Client->Server ciphers: '
        + init.algorithms.cs.encrypt);
  if (self.server) {
    serverList = algos.cipher;
    clientList = init.algorithms.cs.encrypt;
  } else {
    serverList = init.algorithms.cs.encrypt;
    clientList = algos.cipher;
  }
  // Check for agreeable client->server cipher
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Client->Server cipher');
    var err = new Error('Handshake failed: no matching client->server cipher');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server) {
    val = instate.decrypt.type = clientList[i];
    instate.decrypt.isGCM = RE_GCM.test(val);
  } else {
    val = outstate.encrypt.type = clientList[i];
    outstate.encrypt.isGCM = RE_GCM.test(val);
  }
  debug('DEBUG: Client->Server Cipher: ' + val);

  debug('DEBUG: (local) Server->Client ciphers: ' + algos.cipher);
  debug('DEBUG: (remote) Server->Client ciphers: '
        + (init.algorithms.sc.encrypt));
  if (self.server) {
    serverList = algos.cipher;
    clientList = init.algorithms.sc.encrypt;
  } else {
    serverList = init.algorithms.sc.encrypt;
    clientList = algos.cipher;
  }
  // Check for agreeable server->client cipher
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Server->Client cipher');
    var err = new Error('Handshake failed: no matching server->client cipher');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server) {
    val = outstate.encrypt.type = clientList[i];
    outstate.encrypt.isGCM = RE_GCM.test(val);
  } else {
    val = instate.decrypt.type = clientList[i];
    instate.decrypt.isGCM = RE_GCM.test(val);
  }
  debug('DEBUG: Server->Client Cipher: ' + val);

  debug('DEBUG: (local) Client->Server HMAC algorithms: ' + algos.hmac);
  debug('DEBUG: (remote) Client->Server HMAC algorithms: '
        + init.algorithms.cs.mac);
  if (self.server) {
    serverList = algos.hmac;
    clientList = init.algorithms.cs.mac;
  } else {
    serverList = init.algorithms.cs.mac;
    clientList = algos.hmac;
  }
  // Check for agreeable client->server hmac algorithm
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Client->Server HMAC algorithm');
    var err = new Error('Handshake failed: no matching client->server HMAC');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server)
    val = instate.hmac.type = clientList[i];
  else
    val = outstate.hmac.type = clientList[i];
  debug('DEBUG: Client->Server HMAC algorithm: ' + val);

  debug('DEBUG: (local) Server->Client HMAC algorithms: ' + algos.hmac);
  debug('DEBUG: (remote) Server->Client HMAC algorithms: '
        + init.algorithms.sc.mac);
  if (self.server) {
    serverList = algos.hmac;
    clientList = init.algorithms.sc.mac;
  } else {
    serverList = init.algorithms.sc.mac;
    clientList = algos.hmac;
  }
  // Check for agreeable server->client hmac algorithm
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Server->Client HMAC algorithm');
    var err = new Error('Handshake failed: no matching server->client HMAC');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server)
    val = outstate.hmac.type = clientList[i];
  else
    val = instate.hmac.type = clientList[i];
  debug('DEBUG: Server->Client HMAC algorithm: ' + val);

  debug('DEBUG: (local) Client->Server compression algorithms: '
        + algos.compress);
  debug('DEBUG: (remote) Client->Server compression algorithms: '
        + init.algorithms.cs.compress);
  if (self.server) {
    serverList = algos.compress;
    clientList = init.algorithms.cs.compress;
  } else {
    serverList = init.algorithms.cs.compress;
    clientList = algos.compress;
  }
  // Check for agreeable client->server compression algorithm
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Client->Server compression algorithm');
    var err = new Error('Handshake failed: no matching client->server '
                        + 'compression algorithm');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server)
    val = instate.decompress.type = clientList[i];
  else
    val = outstate.compress.type = clientList[i];
  debug('DEBUG: Client->Server compression algorithm: ' + val);

  debug('DEBUG: (local) Server->Client compression algorithms: '
        + algos.compress);
  debug('DEBUG: (remote) Server->Client compression algorithms: '
        + init.algorithms.sc.compress);
  if (self.server) {
    serverList = algos.compress;
    clientList = init.algorithms.sc.compress;
  } else {
    serverList = init.algorithms.sc.compress;
    clientList = algos.compress;
  }
  // Check for agreeable server->client compression algorithm
  for (i = 0, len = clientList.length;
       i < len && serverList.indexOf(clientList[i]) === -1;
       ++i);
  if (i === len) {
    // No suitable match found!
    debug('DEBUG: No matching Server->Client compression algorithm');
    var err = new Error('Handshake failed: no matching server->client '
                        + 'compression algorithm');
    err.level = 'handshake';
    self.emit('error', err);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (self.server)
    val = outstate.compress.type = clientList[i];
  else
    val = instate.decompress.type = clientList[i];
  debug('DEBUG: Server->Client compression algorithm: ' + val);

  switch (kex_algorithm) {
    case 'diffie-hellman-group1-sha1':
      state.kexdh = 'group';
      state.kex = crypto.getDiffieHellman('modp2');
      break;
    case 'diffie-hellman-group14-sha1':
      state.kexdh = 'group';
      state.kex = crypto.getDiffieHellman('modp14');
      break;
    case 'ecdh-sha2-nistp256':
      state.kexdh = 'ec-sha256';
      state.kex = crypto.createECDH(SSH_TO_OPENSSL[kex_algorithm]);
      break;
    case 'ecdh-sha2-nistp384':
      state.kexdh = 'ec-sha384';
      state.kex = crypto.createECDH(SSH_TO_OPENSSL[kex_algorithm]);
      break;
    case 'ecdh-sha2-nistp521':
      state.kexdh = 'ec-sha512';
      state.kex = crypto.createECDH(SSH_TO_OPENSSL[kex_algorithm]);
      break;
    default:
      if (kex_algorithm === 'diffie-hellman-group-exchange-sha1')
        state.kexdh = 'gex-sha1';
      else if (kex_algorithm === 'diffie-hellman-group-exchange-sha256')
        state.kexdh = 'gex-sha256';
      // Reset kex object if DH group exchange is selected on re-key and DH
      // group exchange was used before the re-key. This ensures that we send
      // the right DH packet after the KEXINIT exchange
      state.kex = undefined;
  }

  if (state.kex) {
    outstate.pubkey = state.kex.generateKeys();
    var idx = 0;
    len = outstate.pubkey.length;
    while (outstate.pubkey[idx] === 0x00) {
      ++idx;
      --len;
    }
    if (outstate.pubkey[idx] & 0x80) {
      var key = new Buffer(len + 1);
      key[0] = 0;
      outstate.pubkey.copy(key, 1, idx);
      outstate.pubkey = key;
    }
  }

  return true;
}

function onKEXDH_GEX_GROUP(self, prime, gen) {
  var state = self._state;
  var outstate = state.outgoing;

  state.kex = crypto.createDiffieHellman(prime, gen);
  outstate.pubkey = state.kex.generateKeys();
  var idx = 0;
  var len = outstate.pubkey.length;
  while (outstate.pubkey[idx] === 0x00) {
    ++idx;
    --len;
  }
  if (outstate.pubkey[idx] & 0x80) {
    var key = new Buffer(len + 1);
    key[0] = 0;
    outstate.pubkey.copy(key, 1, idx);
    outstate.pubkey = key;
  }
  KEXDH_INIT(self);
}

function onKEXDH_INIT(self, e) { // Server
  KEXDH_REPLY(self, e);
}

function onKEXDH_REPLY(self, info, verifiedHost) { // Client
  var state = self._state;
  var instate = state.incoming;
  var outstate = state.outgoing;
  var debug = self.debug;
  var len;
  var i;

  if (verifiedHost === undefined) {
    instate.expectedPacket = 'NEWKEYS';
    outstate.sentNEWKEYS = false;

    debug('DEBUG: Checking host key format');
    // Ensure all host key formats agree
    var hostkey_format = readString(info.hostkey, 0, 'ascii', self);
    if (hostkey_format === false)
      return false;
    if (info.hostkey_format !== state.hostkeyFormat
        || info.hostkey_format !== hostkey_format) {
      // Expected and actual server host key format do not match!
      debug('DEBUG: Host key format mismatch');
      self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
      self.reset();
      var err = new Error('Handshake failed: host key format mismatch');
      err.level = 'handshake';
      self.emit('error', err);
      return false;
    }

    debug('DEBUG: Checking signature format');
    // Ensure signature formats agree
    var sig_format = readString(info.sig, 0, 'ascii', self);
    if (sig_format === false)
      return false;
    if (info.sig_format !== sig_format) {
      debug('DEBUG: Signature format mismatch');
      self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
      self.reset();
      var err = new Error('Handshake failed: signature format mismatch');
      err.level = 'handshake';
      self.emit('error', err);
      return false;
    }
  }

  // Verify the host fingerprint first if needed
  if (outstate.status === OUT_INIT) {
    if (verifiedHost === undefined) {
      debug('DEBUG: Verifying host fingerprint');
      var sync = true;
      var emitted = self.emit('fingerprint', info.hostkey, function(permitted) {
        // Prevent multiple calls to this callback
        if (verifiedHost !== undefined)
          return;
        verifiedHost = !!permitted;
        if (!sync) {
          // Continue execution by re-entry
          onKEXDH_REPLY(self, info, verifiedHost);
        }
      });
      sync = false;
      // Support async calling of verification callback
      if (emitted && verifiedHost === undefined)
        return;
    }
    if (verifiedHost === undefined)
      debug('DEBUG: Host accepted by default (no verification)');
    else if (verifiedHost === true)
      debug('DEBUG: Host accepted (verified)');
    else {
      debug('DEBUG: Host denied via fingerprint verification');
      self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
      self.reset();
      var err = new Error('Handshake failed: '
                          + 'host fingerprint verification failed');
      err.level = 'handshake';
      self.emit('error', err);
      return false;
    }
  }

  var slicepos = -1;
  for (i = 0, len = info.pubkey.length; i < len; ++i) {
    if (info.pubkey[i] === 0)
      ++slicepos;
    else
      break;
  }
  if (slicepos > -1)
    info.pubkey = info.pubkey.slice(slicepos + 1);
  info.secret = tryComputeSecret(state.kex, info.pubkey);
  if (info.secret instanceof Error) {
    info.secret.message = 'Error while computing DH secret ('
                          + state.kexdh + '): '
                          + info.secret.message;
    info.secret.level = 'handshake';
    self.emit('error', info.secret);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  var hashAlgo;
  if (state.kexdh === 'group')
    hashAlgo = 'sha1';
  else
    hashAlgo = RE_KEX_HASH.exec(state.kexdh)[1];
  var hash = crypto.createHash(hashAlgo);

  var len_ident = Buffer.byteLength(self.config.ident);
  var len_sident = Buffer.byteLength(instate.identRaw);
  var len_init = outstate.kexinit.length;
  var len_sinit = instate.kexinit.length;
  var len_hostkey = info.hostkey.length;
  var len_pubkey = outstate.pubkey.length;
  var len_spubkey = info.pubkey.length;
  var len_secret = info.secret.length;

  var idx_pubkey = 0;
  var idx_spubkey = 0;
  var idx_secret = 0;

  while (outstate.pubkey[idx_pubkey] === 0x00) {
    ++idx_pubkey;
    --len_pubkey;
  }
  while (info.pubkey[idx_spubkey] === 0x00) {
    ++idx_spubkey;
    --len_spubkey;
  }
  while (info.secret[idx_secret] === 0x00) {
    ++idx_secret;
    --len_secret;
  }
  if (outstate.pubkey[idx_pubkey] & 0x80)
    ++len_pubkey;
  if (info.pubkey[idx_spubkey] & 0x80)
    ++len_spubkey;
  if (info.secret[idx_secret] & 0x80)
    ++len_secret;

  var exchangeBufLen = len_ident
                       + len_sident
                       + len_init
                       + len_sinit
                       + len_hostkey
                       + len_pubkey
                       + len_spubkey
                       + len_secret
                       + (4 * 8); // Length fields for above values

  // Group exchange-related
  var isGEX = RE_GEX.test(state.kexdh);
  var len_gex_prime = 0;
  var len_gex_gen = 0;
  var idx_gex_prime = 0;
  var idx_gex_gen = 0;
  var gex_prime;
  var gex_gen;
  if (isGEX) {
    gex_prime = state.kex.getPrime();
    gex_gen = state.kex.getGenerator();
    len_gex_prime = gex_prime.length;
    len_gex_gen = gex_gen.length;
    while (gex_prime[idx_gex_prime] === 0x00) {
      ++idx_gex_prime;
      --len_gex_prime;
    }
    while (gex_gen[idx_gex_gen] === 0x00) {
      ++idx_gex_gen;
      --len_gex_gen;
    }
    if (gex_prime[idx_gex_prime] & 0x80)
      ++len_gex_prime;
    if (gex_gen[idx_gex_gen] & 0x80)
      ++len_gex_gen;
    exchangeBufLen += (4 * 3); // min, n, max values
    exchangeBufLen += (4 * 2); // prime, generator length fields
    exchangeBufLen += len_gex_prime;
    exchangeBufLen += len_gex_gen;
  }


  var bp = 0;
  var exchangeBuf = new Buffer(exchangeBufLen);

  exchangeBuf.writeUInt32BE(len_ident, bp, true);
  bp += 4;
  exchangeBuf.write(self.config.ident, bp, 'utf8'); // V_C
  bp += len_ident;

  exchangeBuf.writeUInt32BE(len_sident, bp, true);
  bp += 4;
  exchangeBuf.write(instate.identRaw, bp, 'utf8'); // V_S
  bp += len_sident;

  exchangeBuf.writeUInt32BE(len_init, bp, true);
  bp += 4;
  outstate.kexinit.copy(exchangeBuf, bp); // I_C
  bp += len_init;
  outstate.kexinit = undefined;

  exchangeBuf.writeUInt32BE(len_sinit, bp, true);
  bp += 4;
  instate.kexinit.copy(exchangeBuf, bp); // I_S
  bp += len_sinit;
  instate.kexinit = undefined;

  exchangeBuf.writeUInt32BE(len_hostkey, bp, true);
  bp += 4;
  info.hostkey.copy(exchangeBuf, bp); // K_S
  bp += len_hostkey;

  if (isGEX) {
    KEXDH_GEX_REQ_PACKET.slice(1).copy(exchangeBuf, bp); // min, n, max
    bp += (4 * 3); // Skip over bytes just copied

    exchangeBuf.writeUInt32BE(len_gex_prime, bp, true);
    bp += 4;
    if (gex_prime[idx_gex_prime] & 0x80)
      exchangeBuf[bp++] = 0;
    gex_prime.copy(exchangeBuf, bp, idx_gex_prime); // p
    bp += len_gex_prime - (gex_prime[idx_gex_prime] & 0x80 ? 1 : 0);

    exchangeBuf.writeUInt32BE(len_gex_gen, bp, true);
    bp += 4;
    if (gex_gen[idx_gex_gen] & 0x80)
      exchangeBuf[bp++] = 0;
    gex_gen.copy(exchangeBuf, bp, idx_gex_gen); // g
    bp += len_gex_gen - (gex_gen[idx_gex_gen] & 0x80 ? 1 : 0);
  }

  exchangeBuf.writeUInt32BE(len_pubkey, bp, true);
  bp += 4;
  if (outstate.pubkey[idx_pubkey] & 0x80)
    exchangeBuf[bp++] = 0;
  outstate.pubkey.copy(exchangeBuf, bp, idx_pubkey); // e
  bp += len_pubkey - (outstate.pubkey[idx_pubkey] & 0x80 ? 1 : 0);

  exchangeBuf.writeUInt32BE(len_spubkey, bp, true);
  bp += 4;
  if (info.pubkey[idx_spubkey] & 0x80)
    exchangeBuf[bp++] = 0;
  info.pubkey.copy(exchangeBuf, bp, idx_spubkey); // f
  bp += len_spubkey - (info.pubkey[idx_spubkey] & 0x80 ? 1 : 0);

  exchangeBuf.writeUInt32BE(len_secret, bp, true);
  bp += 4;
  if (info.secret[idx_secret] & 0x80)
    exchangeBuf[bp++] = 0;
  info.secret.copy(exchangeBuf, bp, idx_secret); // K

  outstate.exchangeHash = hash.update(exchangeBuf).digest(); // H

  var rawsig = readString(info.sig, info.sig._pos, self); // s
  if (rawsig === false)
    return false;

  var keyAlgo;
  switch (info.sig_format) {
    case 'ssh-rsa':
      keyAlgo = 'RSA-SHA1';
      break;
    case 'ssh-dss':
      keyAlgo = 'DSA-SHA1';
      break;
    case 'ecdsa-sha2-nistp256':
      keyAlgo = 'sha256';
      break;
    case 'ecdsa-sha2-nistp384':
      keyAlgo = 'sha384';
      break;
    case 'ecdsa-sha2-nistp521':
      keyAlgo = 'sha512';
      break;
    default:
      debug('DEBUG: Signature format unsupported: ' + info.sig_format);
      self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
      self.reset();
      var err = new Error('Handshake failed: signature format unsupported: '
                          + info.sig_format);
      err.level = 'handshake';
      self.emit('error', err);
      return false;
  }
  var verifier = crypto.createVerify(keyAlgo);
  verifier.update(outstate.exchangeHash);

  var asn1KeyBuf;
  if (keyAlgo === 'RSA-SHA1') {
    asn1KeyBuf = RSAKeySSHToASN1(info.hostkey, self);
  } else if (keyAlgo === 'DSA-SHA1') {
    asn1KeyBuf = DSAKeySSHToASN1(info.hostkey, self);
    rawsig = DSASigBareToBER(rawsig);
  } else {
    // ECDSA
    asn1KeyBuf = ECDSAKeySSHToASN1(info.hostkey, self);
    rawsig = ECDSASigSSHToASN1(rawsig, self);
  }

  if (!asn1KeyBuf || !rawsig)
    return false;

  debug('DEBUG: Verifying signature');

  var b64key = asn1KeyBuf.toString('base64').replace(/(.{64})/g, '$1\n');
  var fullkey = '-----BEGIN PUBLIC KEY-----\n'
                + b64key
                + (b64key[b64key.length - 1] === '\n' ? '' : '\n')
                + '-----END PUBLIC KEY-----';

  var verified = verifier.verify(fullkey, rawsig);

  if (!verified) {
    debug('DEBUG: Signature verification failed');
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    self.reset();
    var err = new Error('Handshake failed: signature verification failed');
    err.level = 'handshake';
    self.emit('error', err);
    return false;
  }

  if (outstate.sessionId === undefined)
    outstate.sessionId = outstate.exchangeHash;
  outstate.kexsecret = info.secret;

  debug('DEBUG: Outgoing: Writing NEWKEYS');
  if (outstate.status === OUT_REKEYING)
    send(self, NEWKEYS_PACKET, undefined, true);
  else
    send(self, NEWKEYS_PACKET);
  outstate.sentNEWKEYS = true;

  if (verifiedHost !== undefined && instate.expectedPacket === undefined) {
    // We received NEWKEYS while we were waiting for the fingerprint
    // verification callback to be called. In this case we have to re-execute
    // onNEWKEYS to finish the handshake.
    onNEWKEYS(self);
  }
}

function onNEWKEYS(self) { // Client/Server
  var state = self._state;
  var outstate = state.outgoing;
  var instate = state.incoming;

  instate.expectedPacket = undefined;

  if (!outstate.sentNEWKEYS)
    return;

  var idx_secret = 0;
  var len = outstate.kexsecret.length;
  while (outstate.kexsecret[idx_secret] === 0x00) {
    ++idx_secret;
    --len;
  }

  var blocklen = 8;
  var keylen = 0;
  var p = 0;

  var dhHashAlgo;
  if (state.kexdh === 'group')
    dhHashAlgo = 'sha1';
  else
    dhHashAlgo = RE_KEX_HASH.exec(state.kexdh)[1];

  var len_secret = (outstate.kexsecret[idx_secret] & 0x80 ? 1 : 0) + len;
  var secret = new Buffer(4 + len_secret);
  var iv;
  var key;

  // Whenever the client sends a new authentication request, it is enqueued
  // here.  Once the request is resolved (success, fail, or PK_OK),
  // dequeue.  Whatever is at the front of the queue determines how we
  // interpret packet type 60.
  state.authsQueue = [];

  secret.writeUInt32BE(len_secret, p, true);
  p += 4;
  if (outstate.kexsecret[idx_secret] & 0x80)
    secret[p++] = 0;
  outstate.kexsecret.copy(secret, p, idx_secret);
  outstate.kexsecret = undefined;
  if (!isStreamCipher(outstate.encrypt.type)) {
    iv = crypto.createHash(dhHashAlgo)
               .update(secret)
               .update(outstate.exchangeHash)
               .update(!self.server ? 'A' : 'B', 'ascii')
               .update(outstate.sessionId)
               .digest();
    switch (outstate.encrypt.type) {
      case 'aes128-gcm':
      case 'aes256-gcm':
      case 'aes128-gcm@openssh.com':
      case 'aes256-gcm@openssh.com':
        blocklen = 12;
      break;
      case 'aes256-cbc':
      case 'aes192-cbc':
      case 'aes128-cbc':
      case 'aes256-ctr':
      case 'aes192-ctr':
      case 'aes128-ctr':
        blocklen = 16;
    }
    outstate.encrypt.size = blocklen;
    while (blocklen > iv.length) {
      iv = Buffer.concat([iv,
                          crypto.createHash(dhHashAlgo)
                                .update(secret)
                                .update(outstate.exchangeHash)
                                .update(iv)
                                .digest()]);
    }
    iv = iv.slice(0, blocklen);
  } else {
    outstate.encrypt.size = blocklen;
    iv = EMPTY_BUFFER; // Streaming ciphers don't use an IV upfront
  }
  switch (outstate.encrypt.type) {
    case 'aes256-gcm':
    case 'aes256-gcm@openssh.com':
    case 'aes256-cbc':
    case 'aes256-ctr':
    case 'arcfour256':
      keylen = 32;
      break;
    case '3des-cbc':
    case '3des-ctr':
    case 'aes192-cbc':
    case 'aes192-ctr':
      keylen = 24;
      break;
    case 'aes128-gcm':
    case 'aes128-gcm@openssh.com':
    case 'aes128-cbc':
    case 'aes128-ctr':
    case 'cast128-cbc':
    case 'blowfish-cbc':
    case 'arcfour':
    case 'arcfour128':
      keylen = 16;
      break;
  }

  key = crypto.createHash(dhHashAlgo)
              .update(secret)
              .update(outstate.exchangeHash)
              .update(!self.server ? 'C' : 'D', 'ascii')
              .update(outstate.sessionId)
              .digest();
  while (keylen > key.length) {
    key = Buffer.concat([key,
                         crypto.createHash(dhHashAlgo)
                               .update(secret)
                               .update(outstate.exchangeHash)
                               .update(key)
                               .digest()]);
  }
  key = key.slice(0, keylen);

  if (outstate.encrypt.isGCM) {
    outstate.encrypt.size = 16;
    outstate.encrypt.iv = iv;
    outstate.encrypt.key = key;
    outstate.encrypt.instance = true;
  } else {
    var cipherAlgo = SSH_TO_OPENSSL[outstate.encrypt.type];
    outstate.encrypt.instance = crypto.createCipheriv(cipherAlgo, key, iv);
    outstate.encrypt.instance.setAutoPadding(false);
  }

  // And now for decrypting ...

  blocklen = 8;
  keylen = 0;
  if (!isStreamCipher(instate.decrypt.type)) {
    iv = crypto.createHash(dhHashAlgo)
               .update(secret)
               .update(outstate.exchangeHash)
               .update(!self.server ? 'B' : 'A', 'ascii')
               .update(outstate.sessionId)
               .digest();
    switch (instate.decrypt.type) {
      case 'aes128-gcm':
      case 'aes256-gcm':
      case 'aes128-gcm@openssh.com':
      case 'aes256-gcm@openssh.com':
        blocklen = 12;
      break;
      case 'aes256-cbc':
      case 'aes192-cbc':
      case 'aes128-cbc':
      case 'aes256-ctr':
      case 'aes192-ctr':
      case 'aes128-ctr':
        blocklen = 16;
    }
    if (instate.decrypt.isGCM)
      instate.decrypt.size = 16;
    else
      instate.decrypt.size = blocklen;
    while (blocklen > iv.length) {
      iv = Buffer.concat([iv,
                          crypto.createHash(dhHashAlgo)
                                .update(secret)
                                .update(outstate.exchangeHash)
                                .update(iv)
                                .digest()]);
    }
    iv = iv.slice(0, blocklen);
  } else {
    instate.decrypt.size = blocklen;
    iv = EMPTY_BUFFER; // Streaming ciphers don't use an IV upfront
  }

  // Create a reusable buffer for decryption purposes
  instate.decrypt.buf = new Buffer(instate.decrypt.size);

  switch (instate.decrypt.type) {
    case 'aes256-gcm':
    case 'aes256-gcm@openssh.com':
    case 'aes256-cbc':
    case 'aes256-ctr':
    case 'arcfour256':
      keylen = 32;
      break;
    case '3des-cbc':
    case '3des-ctr':
    case 'aes192-cbc':
    case 'aes192-ctr':
      keylen = 24;
      break;
    case 'aes128-gcm':
    case 'aes128-gcm@openssh.com':
    case 'aes128-cbc':
    case 'aes128-ctr':
    case 'cast128-cbc':
    case 'blowfish-cbc':
    case 'arcfour':
    case 'arcfour128':
      keylen = 16;
      break;
  }
  key = crypto.createHash(dhHashAlgo)
              .update(secret)
              .update(outstate.exchangeHash)
              .update(!self.server ? 'D' : 'C', 'ascii')
              .update(outstate.sessionId)
              .digest();
  while (keylen > key.length) {
    key = Buffer.concat([key,
                         crypto.createHash(dhHashAlgo)
                               .update(secret)
                               .update(outstate.exchangeHash)
                               .update(key)
                               .digest()]);
  }
  key = key.slice(0, keylen);

  var decipherAlgo = SSH_TO_OPENSSL[instate.decrypt.type];
  instate.decrypt.instance = crypto.createDecipheriv(decipherAlgo, key, iv);
  instate.decrypt.instance.setAutoPadding(false);
  instate.decrypt.iv = iv;
  instate.decrypt.key = key;

  /* The "arcfour128" algorithm is the RC4 cipher, as described in
     [SCHNEIER], using a 128-bit key.  The first 1536 bytes of keystream
     generated by the cipher MUST be discarded, and the first byte of the
     first encrypted packet MUST be encrypted using the 1537th byte of
     keystream.

     -- http://tools.ietf.org/html/rfc4345#section-4 */
  var emptyBuf;
  if (outstate.encrypt.type.substr(0, 7) === 'arcfour') {
    emptyBuf = new Buffer(1536);
    emptyBuf.fill(0);
    outstate.encrypt.instance.update(emptyBuf);
  }
  if (instate.decrypt.type.substr(0, 7) === 'arcfour') {
    emptyBuf = new Buffer(1536);
    emptyBuf.fill(0);
    instate.decrypt.instance.update(emptyBuf);
  }

  var createKeyLen = 0;
  var checkKeyLen = 0;
  switch (outstate.hmac.type) {
    case 'hmac-ripemd160':
    case 'hmac-sha1':
      createKeyLen = 20;
      outstate.hmac.size = 20;
      break;
    case 'hmac-sha1-96':
      createKeyLen = 20;
      outstate.hmac.size = 12;
      break;
    case 'hmac-sha2-256':
      createKeyLen = 32;
      outstate.hmac.size = 32;
      break;
    case 'hmac-sha2-256-96':
      createKeyLen = 32;
      outstate.hmac.size = 12;
      break;
    case 'hmac-sha2-512':
      createKeyLen = 64;
      outstate.hmac.size = 64;
      break;
    case 'hmac-sha2-512-96':
      createKeyLen = 64;
      outstate.hmac.size = 12;
      break;
    case 'hmac-md5':
      createKeyLen = 16;
      outstate.hmac.size = 16;
      break;
    case 'hmac-md5-96':
      createKeyLen = 16;
      outstate.hmac.size = 12;
      break;
  }
  switch (instate.hmac.type) {
    case 'hmac-ripemd160':
    case 'hmac-sha1':
      checkKeyLen = 20;
      instate.hmac.size = 20;
      break;
    case 'hmac-sha1-96':
      checkKeyLen = 20;
      instate.hmac.size = 12;
      break;
    case 'hmac-sha2-256':
      checkKeyLen = 32;
      instate.hmac.size = 32;
      break;
    case 'hmac-sha2-256-96':
      checkKeyLen = 32;
      instate.hmac.size = 12;
      break;
    case 'hmac-sha2-512':
      checkKeyLen = 64;
      instate.hmac.size = 64;
      break;
    case 'hmac-sha2-512-96':
      checkKeyLen = 64;
      instate.hmac.size = 12;
      break;
    case 'hmac-md5':
      checkKeyLen = 16;
      instate.hmac.size = 16;
      break;
    case 'hmac-md5-96':
      checkKeyLen = 16;
      instate.hmac.size = 12;
      break;
  }

  if (!outstate.encrypt.isGCM) {
    key = crypto.createHash(dhHashAlgo)
                .update(secret)
                .update(outstate.exchangeHash)
                .update(!self.server ? 'E' : 'F', 'ascii')
                .update(outstate.sessionId)
                .digest();
    while (createKeyLen > key.length) {
      key = Buffer.concat([key,
                           crypto.createHash(dhHashAlgo)
                                 .update(secret)
                                 .update(outstate.exchangeHash)
                                 .update(key)
                                 .digest()]);
    }
    outstate.hmac.key = key.slice(0, createKeyLen);
  } else
    outstate.hmac.key = undefined;
  if (!instate.decrypt.isGCM) {
    key = crypto.createHash(dhHashAlgo)
                .update(secret)
                .update(outstate.exchangeHash)
                .update(!self.server ? 'F' : 'E', 'ascii')
                .update(outstate.sessionId)
                .digest();
    while (checkKeyLen > key.length) {
      key = Buffer.concat([key,
                           crypto.createHash(dhHashAlgo)
                                 .update(secret)
                                 .update(outstate.exchangeHash)
                                 .update(key)
                                 .digest()]);
    }
    instate.hmac.key = key.slice(0, checkKeyLen);
  } else {
    instate.hmac.key = undefined;
    instate.hmac.size = 16;
  }

  outstate.exchangeHash = undefined;

  // Create a reusable buffer for message verification purposes
  if (!instate.hmac.buf
      || instate.hmac.buf.length !== instate.hmac.size)
    instate.hmac.buf = new Buffer(instate.hmac.size);

  if (outstate.compress.type === 'zlib')
    outstate.compress.instance = zlib.createDeflate(ZLIB_OPTS);
  else if (outstate.compress.type === 'none')
    outstate.compress.instance = false;
  if (instate.decompress.type === 'zlib')
    instate.decompress.instance = zlib.createInflate(ZLIB_OPTS);
  else if (instate.decompress.type === 'none')
    instate.decompress.instance = false;

  self.bytesSent = self.bytesReceived = 0;

  if (outstate.status === OUT_REKEYING) {
    outstate.status = OUT_READY;

    // Empty our outbound buffer of any data we tried to send during the
    // re-keying process
    var queue = outstate.rekeyQueue;
    var qlen = queue.length;
    var q = 0;

    outstate.rekeyQueue = [];

    for (; q < qlen; ++q) {
      if (Buffer.isBuffer(queue[q]))
        send(self, queue[q]);
      else
        send(self, queue[q][0], queue[q][1]);
    }

    // Now empty our inbound buffer of any non-transport layer packets we
    // received during the re-keying process
    queue = instate.rekeyQueue;
    qlen = queue.length;
    q = 0;

    instate.rekeyQueue = [];

    var curSeqno = instate.seqno;
    for (; q < qlen; ++q) {
      instate.seqno = queue[q][0];
      instate.payload = queue[q][1];
      if (parsePacket(self) === false)
        return;

      if (instate.status === IN_INIT) {
        // We were reset due to some error/disagreement ?
        return;
      }
    }
    instate.seqno = curSeqno;
  } else {
    outstate.status = OUT_READY;
    if (instate.status === IN_PACKET) {
      // Explicitly update incoming packet parser status in order to get the
      // correct decipher, hmac, etc. states.

      // We only get here if the host fingerprint callback was called
      // asynchronously and the incoming packet parser is still expecting an
      // unencrypted packet, etc.

      self.debug('DEBUG: Parser: IN_PACKETBEFORE (update) (expecting '
                 + instate.decrypt.size + ')');
      // Wait for the right number of bytes so we can determine the incoming
      // packet length
      expectData(self,
                 EXP_TYPE_BYTES,
                 instate.decrypt.size,
                 instate.decrypt.buf);
    }
    self.emit('ready');
  }
}

function parsePacket(self, callback) {
  var instate = self._state.incoming;
  var outstate = self._state.outgoing;
  var payload = instate.payload;
  var seqno = instate.seqno;
  var serviceName;
  var lang;
  var message;
  var info;
  var chan;
  var data;
  var srcIP;
  var srcPort;
  var sender;
  var window;
  var packetSize;
  var recipient;
  var description;
  var socketPath;

  if (++instate.seqno > MAX_SEQNO)
    instate.seqno = 0;

  if (instate.ignoreNext) {
    self.debug('DEBUG: Parser: Packet ignored');
    instate.ignoreNext = false;
    return;
  }

  var type = payload[0];
  if (type === undefined)
    return false;

  // If we receive a packet during handshake that is not the expected packet
  // and it is not one of: DISCONNECT, IGNORE, UNIMPLEMENTED, or DEBUG, then we
  // close the stream
  if (outstate.status !== OUT_READY
      && MESSAGE[type] !== instate.expectedPacket
      && type < 1
      && type > 4) {
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, expected: '
               + instate.expectedPacket
               + ' but got: '
               + MESSAGE[type]);
    // XXX: Potential issue where the module user decides to initiate a rekey
    // via KEXINIT() (which sets `expectedPacket`) after receiving a packet
    // and there is still another packet already waiting to be parsed at the
    // time the KEXINIT is written. this will cause an unexpected disconnect...
    self.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
    var err = new Error('Received unexpected packet');
    err.level = 'protocol';
    self.emit('error', err);
    return false;
  }

  if (type === MESSAGE.CHANNEL_DATA) {
    /*
      byte      SSH_MSG_CHANNEL_DATA
      uint32    recipient channel
      string    data
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    // TODO: MAX_CHAN_DATA_LEN here should really be dependent upon the
    //       channel's packet size. The ssh2 module uses 32KB, so we'll hard
    //       code this for now ...
    data = readString(payload, 5, self, callback, 32768);
    if (data === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_DATA ('
               + chan
               + ')');
    self.emit('CHANNEL_DATA:' + chan, data);
  } else if (type === MESSAGE.CHANNEL_EXTENDED_DATA) {
    /*
      byte      SSH_MSG_CHANNEL_EXTENDED_DATA
      uint32    recipient channel
      uint32    data_type_code
      string    data
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    var dataType = readInt(payload, 5, self, callback);
    if (dataType === false)
      return false;
    data = readString(payload, 9, self, callback);
    if (data === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: '
               + 'CHANNEL_EXTENDED_DATA ('
               + chan
               + ')');
    self.emit('CHANNEL_EXTENDED_DATA:' + chan, dataType, data);
  } else if (type === MESSAGE.CHANNEL_WINDOW_ADJUST) {
    /*
      byte      SSH_MSG_CHANNEL_WINDOW_ADJUST
      uint32    recipient channel
      uint32    bytes to add
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    var bytesToAdd = readInt(payload, 5, self, callback);
    if (bytesToAdd === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: '
               + 'CHANNEL_WINDOW_ADJUST ('
               + chan
               + ', '
               + bytesToAdd
               + ')');
    self.emit('CHANNEL_WINDOW_ADJUST:' + chan, bytesToAdd);
  } else if (type === MESSAGE.CHANNEL_SUCCESS) {
    /*
      byte      SSH_MSG_CHANNEL_SUCCESS
      uint32    recipient channel
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_SUCCESS ('
               + chan
               + ')');
    self.emit('CHANNEL_SUCCESS:' + chan);
  } else if (type === MESSAGE.CHANNEL_FAILURE) {
    /*
      byte      SSH_MSG_CHANNEL_FAILURE
      uint32    recipient channel
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_FAILURE ('
               + chan
               + ')');
    self.emit('CHANNEL_FAILURE:' + chan);
  } else if (type === MESSAGE.CHANNEL_EOF) {
    /*
      byte      SSH_MSG_CHANNEL_EOF
      uint32    recipient channel
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_EOF ('
               + chan
               + ')');
    self.emit('CHANNEL_EOF:' + chan);
  } else if (type === MESSAGE.CHANNEL_OPEN) {
    /*
      byte      SSH_MSG_CHANNEL_OPEN
      string    channel type in US-ASCII only
      uint32    sender channel
      uint32    initial window size
      uint32    maximum packet size
      ....      channel type specific data follows
    */
    var chanType = readString(payload, 1, 'ascii', self, callback);
    if (chanType === false)
      return false;
    sender = readInt(payload, payload._pos, self, callback);
    if (sender === false)
      return false;
    window = readInt(payload, payload._pos += 4, self, callback);
    if (window === false)
      return false;
    packetSize = readInt(payload, payload._pos += 4, self, callback);
    if (packetSize === false)
      return false;
    var channel;

    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_OPEN ('
               + sender
               + ', '
               + chanType
               + ')');

    if (chanType === 'forwarded-tcpip' // Server->Client
        || chanType === 'direct-tcpip') { // Client->Server
      /*
        string    address that was connected / host to connect
        uint32    port that was connected / port to connect
        string    originator IP address
        uint32    originator port
      */
      var destIP = readString(payload,
                              payload._pos += 4,
                              'ascii',
                              self,
                              callback);
      if (destIP === false)
        return false;
      var destPort = readInt(payload, payload._pos, self, callback);
      if (destPort === false)
        return false;
      srcIP = readString(payload, payload._pos += 4, 'ascii', self, callback);
      if (srcIP === false)
        return false;
      srcPort = readInt(payload, payload._pos, self, callback);
      if (srcPort === false)
        return false;
      channel = {
        type: chanType,
        sender: sender,
        window: window,
        packetSize: packetSize,
        data: {
          destIP: destIP,
          destPort: destPort,
          srcIP: srcIP,
          srcPort: srcPort
        }
      };
    } else if (// Server->Client
               chanType === 'forwarded-streamlocal@openssh.com'
               // Client->Server
               || chanType === 'direct-streamlocal@openssh.com') {
      /*
        string    socket path
        string    reserved for future use
      */
      socketPath = readString(payload,
                              payload._pos += 4,
                              'utf8',
                              self,
                              callback);
      if (socketPath === false)
        return false;
      channel = {
        type: chanType,
        sender: sender,
        window: window,
        packetSize: packetSize,
        data: {
          socketPath: socketPath,
        }
      };
    } else if (chanType === 'x11') { // Server->Client
      /*
        string    originator address (e.g., "192.168.7.38")
        uint32    originator port
      */
      srcIP = readString(payload, payload._pos += 4, 'ascii', self, callback);
      if (srcIP === false)
        return false;
      srcPort = readInt(payload, payload._pos, self, callback);
      if (srcPort === false)
        return false;
      channel = {
        type: chanType,
        sender: sender,
        window: window,
        packetSize: packetSize,
        data: {
          srcIP: srcIP,
          srcPort: srcPort
        }
      };
    } else {
      // 'session' (Client->Server), 'auth-agent@openssh.com' (Server->Client)
      channel = {
        type: chanType,
        sender: sender,
        window: window,
        packetSize: packetSize,
        data: {}
      };
    }

    self.emit('CHANNEL_OPEN', channel);
  } else if (type === MESSAGE.CHANNEL_OPEN_CONFIRMATION) {
    /*
      byte      SSH_MSG_CHANNEL_OPEN_CONFIRMATION
      uint32    recipient channel
      uint32    sender channel
      uint32    initial window size
      uint32    maximum packet size
      ....      channel type specific data follows
    */
    // "The 'recipient channel' is the channel number given in the
    // original open request, and 'sender channel' is the channel number
    // allocated by the other side."
    recipient = readInt(payload, 1, self, callback);
    if (recipient === false)
      return false;
    sender = readInt(payload, 5, self, callback);
    if (sender === false)
      return false;
    window = readInt(payload, 9, self, callback);
    if (window === false)
      return false;
    packetSize = readInt(payload, 13, self, callback);
    if (packetSize === false)
      return false;

    info = {
      recipient: recipient,
      sender: sender,
      window: window,
      packetSize: packetSize
    };

    if (payload.length > 17)
      info.data = payload.slice(17);

    self.emit('CHANNEL_OPEN_CONFIRMATION:' + info.recipient, info);
  } else if (type === MESSAGE.CHANNEL_OPEN_FAILURE) {
    /*
      byte      SSH_MSG_CHANNEL_OPEN_FAILURE
      uint32    recipient channel
      uint32    reason code
      string    description in ISO-10646 UTF-8 encoding
      string    language tag
    */
    recipient = readInt(payload, 1, self, callback);
    if (recipient === false)
      return false;
    var reasonCode = readInt(payload, 5, self, callback);
    if (reasonCode === false)
      return false;
    description = readString(payload, 9, 'utf8', self, callback);
    if (description === false)
      return false;
    lang = readString(payload, payload._pos, 'utf8', self, callback);
    if (lang === false)
      return false;
    payload._pos = 9;
    info = {
      recipient: recipient,
      reasonCode: reasonCode,
      reason: CHANNEL_OPEN_FAILURE[reasonCode],
      description: description,
      lang: lang
    };

    self.emit('CHANNEL_OPEN_FAILURE:' + info.recipient, info);
  } else if (type === MESSAGE.CHANNEL_CLOSE) {
    /*
      byte      SSH_MSG_CHANNEL_CLOSE
      uint32    recipient channel
    */
    chan = readInt(payload, 1, self, callback);
    if (chan === false)
      return false;
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_CLOSE ('
               + chan
               + ')');
    self.emit('CHANNEL_CLOSE:' + chan);
  } else if (type === MESSAGE.IGNORE) {
    /*
      byte      SSH_MSG_IGNORE
      string    data
    */
  } else if (type === MESSAGE.DISCONNECT) {
    /*
      byte      SSH_MSG_DISCONNECT
      uint32    reason code
      string    description in ISO-10646 UTF-8 encoding
      string    language tag
    */
    var reason = readInt(payload, 1, self, callback);
    if (reason === false)
      return false;
    var reasonText = DISCONNECT_REASON[reason];
    description = readString(payload, 5, 'utf8', self, callback);
    if (description === false)
      return false;

    lang = readString(payload, payload._pos, 'ascii', self, callback);

    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: DISCONNECT ('
               + reasonText
               + ')');

    self.emit('DISCONNECT', reasonText, reason, description, lang);
  } else if (type === MESSAGE.DEBUG) {
    /*
      byte      SSH_MSG_DEBUG
      boolean   always_display
      string    message in ISO-10646 UTF-8 encoding
      string    language tag
    */
    message = readString(payload, 2, 'utf8', self, callback);
    if (message === false)
      return false;
    lang = readString(payload, payload._pos, 'ascii', self, callback);
    if (lang === false)
      return false;

    self.emit('DEBUG', message, lang);
  } else if (type === MESSAGE.NEWKEYS) {
    /*
      byte      SSH_MSG_NEW_KEYS
    */
    self.emit('NEWKEYS');
  } else if (type === MESSAGE.SERVICE_REQUEST) {
    /*
      byte      SSH_MSG_SERVICE_REQUEST
      string    service name
    */
    serviceName = readString(payload, 1, 'ascii', self, callback);
    if (serviceName === false)
      return false;

    self.emit('SERVICE_REQUEST', serviceName);
  } else if (type === MESSAGE.SERVICE_ACCEPT) {
    /*
      byte      SSH_MSG_SERVICE_ACCEPT
      string    service name
    */
    serviceName = readString(payload, 1, 'ascii', self, callback);
    if (serviceName === false)
      return false;

    self.emit('SERVICE_ACCEPT', serviceName);
  } else if (type === MESSAGE.USERAUTH_REQUEST) {
    /*
      byte      SSH_MSG_USERAUTH_REQUEST
      string    user name in ISO-10646 UTF-8 encoding [RFC3629]
      string    service name in US-ASCII
      string    method name in US-ASCII
      ....      method specific fields
    */
    var username = readString(payload, 1, 'utf8', self, callback);
    if (username === false)
      return false;
    var svcName = readString(payload, payload._pos, 'ascii', self, callback);
    if (svcName === false)
      return false;
    var method = readString(payload, payload._pos, 'ascii', self, callback);
    if (method === false)
      return false;
    var methodData;

    if (method === 'password') {
      methodData = readString(payload,
                              payload._pos + 1,
                              'utf8',
                              self,
                              callback);
      if (methodData === false)
        return false;
    } else if (method === 'publickey' || method === 'hostbased') {
      var pkSigned;
      var keyAlgo;
      var key;
      var signature;
      var blob;
      var hostname;
      var userlocal;
      if (method === 'publickey') {
        pkSigned = payload[payload._pos++];
        if (pkSigned === undefined)
          return false;
        pkSigned = (pkSigned !== 0);
      }
      keyAlgo = readString(payload, payload._pos, 'ascii', self, callback);
      if (keyAlgo === false)
        return false;
      key = readString(payload, payload._pos, self, callback);
      if (key === false)
        return false;

      if (pkSigned || method === 'hostbased') {
        if (method === 'hostbased') {
          hostname = readString(payload, payload._pos, 'ascii', self, callback);
          if (hostname === false)
            return false;
          userlocal = readString(payload, payload._pos, 'utf8', self, callback);
          if (userlocal === false)
            return false;
        }

        var blobEnd = payload._pos;
        signature = readString(payload, blobEnd, self, callback);
        if (signature === false)
          return false;

        if (signature.length > (4 + keyAlgo.length + 4)
            && signature.toString('ascii', 4, 4 + keyAlgo.length) === keyAlgo) {
          // Skip algoLen + algo + sigLen
          signature = signature.slice(4 + keyAlgo.length + 4);
        }

        if (keyAlgo === 'ssh-dss') {
          signature = DSASigBareToBER(signature);
        } else if (keyAlgo !== 'ssh-rsa' && keyAlgo !== 'ssh-dss') {
          // ECDSA
          signature = ECDSASigSSHToASN1(signature, self, callback);
          if (signature === false)
            return false;
        }

        blob = new Buffer(4 + outstate.sessionId.length + blobEnd);
        blob.writeUInt32BE(outstate.sessionId.length, 0, true);
        outstate.sessionId.copy(blob, 4);
        payload.copy(blob, 4 + outstate.sessionId.length, 0, blobEnd);
      }

      methodData = {
        keyAlgo: keyAlgo,
        key: key,
        signature: signature,
        blob: blob,
        localHostname: hostname,
        localUsername: userlocal
      };
    } else if (method === 'keyboard-interactive') {
      // Skip language, it's deprecated
      var skipLen = readInt(payload, payload._pos, self, callback);
      if (skipLen === false)
        return false;
      methodData = readString(payload,
                              payload._pos + 4 + skipLen,
                              'utf8',
                              self,
                              callback);
      if (methodData === false)
        return false;
    } else if (method !== 'none')
      methodData = payload.slice(payload._pos);

    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: USERAUTH_REQUEST ('
               + method
               + ')');

    self._state.authsQueue.push(method);
    self.emit('USERAUTH_REQUEST', username, svcName, method, methodData);
  } else if (type === MESSAGE.USERAUTH_SUCCESS) {
    /*
      byte      SSH_MSG_USERAUTH_SUCCESS
    */
    if (outstate.compress.type === 'zlib@openssh.com')
      outstate.compress.instance = zlib.createDeflate(ZLIB_OPTS);
    if (instate.decompress.type === 'zlib@openssh.com')
      instate.decompress.instance = zlib.createInflate(ZLIB_OPTS);
    self._state.authsQueue.shift();
    self.emit('USERAUTH_SUCCESS');
  } else if (type === MESSAGE.USERAUTH_FAILURE) {
    /*
      byte      SSH_MSG_USERAUTH_FAILURE
      name-list    authentications that can continue
      boolean      partial success
    */
    var auths = readString(payload, 1, 'ascii', self, callback);
    if (auths === false)
      return false;
    var partSuccess = payload[payload._pos];
    if (partSuccess === undefined)
      return false;

    partSuccess = (partSuccess !== 0);
    auths = auths.split(',');

    self._state.authsQueue.shift();
    self.emit('USERAUTH_FAILURE', auths, partSuccess);
  } else if (type === MESSAGE.USERAUTH_BANNER) {
    /*
      byte      SSH_MSG_USERAUTH_BANNER
      string    message in ISO-10646 UTF-8 encoding
      string    language tag
    */
    message = readString(payload, 1, 'utf8', self, callback);
    if (message === false)
      return false;
    lang = readString(payload, payload._pos, 'utf8', self, callback);
    if (lang === false)
      return false;

    self.emit('USERAUTH_BANNER', message, lang);
  } else if (type === MESSAGE.GLOBAL_REQUEST) {
    /*
      byte      SSH_MSG_GLOBAL_REQUEST
      string    request name in US-ASCII only
      boolean   want reply
      ....      request-specific data follows
    */
    var request = readString(payload, 1, 'ascii', self, callback);
    if (request === false)
      return false;
    var wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    var reqData;

    wantReply = (wantReply !== 0);

    if (request === 'tcpip-forward' || request === 'cancel-tcpip-forward') {
      var bindAddr = readString(payload, payload._pos, 'ascii', self, callback);
      if (bindAddr === false)
        return false;
      var bindPort = readInt(payload, payload._pos, self, callback);
      if (bindPort === false)
        return false;
      reqData = {
        bindAddr: bindAddr,
        bindPort: bindPort
      };
    } else if (request === 'streamlocal-forward@openssh.com'
               || request === 'cancel-streamlocal-forward@openssh.com') {
      socketPath = readString(payload, payload._pos, 'utf8', self, callback);
      if (socketPath === false)
        return false;
      reqData = {
        socketPath: socketPath
      };
    } else if (request === 'no-more-sessions@openssh.com') {
      // No data
    } else
      reqData = payload.slice(payload._pos);

    self.emit('GLOBAL_REQUEST', request, wantReply, reqData);
  } else if (type === MESSAGE.REQUEST_SUCCESS) {
    /*
      byte      SSH_MSG_REQUEST_SUCCESS
      ....      response specific data
    */
    if (payload.length > 1)
      self.emit('REQUEST_SUCCESS', payload.slice(1));
    else
      self.emit('REQUEST_SUCCESS');
  } else if (type === MESSAGE.REQUEST_FAILURE) {
    /*
      byte      SSH_MSG_REQUEST_FAILURE
    */
    self.emit('REQUEST_FAILURE');
  } else if (type === MESSAGE.UNIMPLEMENTED) {
    /*
      byte      SSH_MSG_UNIMPLEMENTED
      uint32    packet sequence number of rejected message
    */
    // TODO
  } else if (type === MESSAGE.KEXINIT)
    return parse_KEXINIT(self, callback);
  else if (type === MESSAGE.CHANNEL_REQUEST)
    return parse_CHANNEL_REQUEST(self, callback);
  else if (type >= 30 && type <= 49) // Key exchange method-specific messages
    return parse_KEX(self, type, callback);
  else if (type >= 60 && type <= 70) // User auth context-specific messages
    return parse_USERAUTH(self, type, callback);
  else {
    // Unknown packet type
    var unimpl = new Buffer(1 + 4);
    unimpl[0] = MESSAGE.UNIMPLEMENTED;
    unimpl.writeUInt32BE(seqno, 1, true);
    send(self, unimpl);
  }
}

function parse_KEXINIT(self, callback) {
  var instate = self._state.incoming;
  var payload = instate.payload;

  /*
    byte         SSH_MSG_KEXINIT
    byte[16]     cookie (random bytes)
    name-list    kex_algorithms
    name-list    server_host_key_algorithms
    name-list    encryption_algorithms_client_to_server
    name-list    encryption_algorithms_server_to_client
    name-list    mac_algorithms_client_to_server
    name-list    mac_algorithms_server_to_client
    name-list    compression_algorithms_client_to_server
    name-list    compression_algorithms_server_to_client
    name-list    languages_client_to_server
    name-list    languages_server_to_client
    boolean      first_kex_packet_follows
    uint32       0 (reserved for future extension)
  */
  var init = {
    algorithms: {
      kex: undefined,
      srvHostKey: undefined,
      cs: {
        encrypt: undefined,
        mac: undefined,
        compress: undefined
      },
      sc: {
        encrypt: undefined,
        mac: undefined,
        compress: undefined
      }
    },
    languages: {
      cs: undefined,
      sc: undefined
    }
  };
  var val;

  val = readList(payload, 17, self, callback);
  if (val === false)
    return false;
  init.algorithms.kex = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.srvHostKey = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.cs.encrypt = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.sc.encrypt = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.cs.mac = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.sc.mac = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.cs.compress = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.algorithms.sc.compress = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.languages.cs = val;
  val = readList(payload, payload._pos, self, callback);
  if (val === false)
    return false;
  init.languages.sc = val;

  var firstFollows = (payload._pos < payload.length
                      && payload[payload._pos] === 1);

  instate.kexinit = payload;

  self.emit('KEXINIT', init, firstFollows);
}

function parse_KEX(self, type, callback) {
  var state = self._state;
  var instate = state.incoming;
  var payload = instate.payload;
  var pktType = (RE_GEX.test(state.kexdh)
                 ? DYNAMIC_KEXDH_MESSAGE[type]
                 : KEXDH_MESSAGE[type]);

  if (state.outgoing.status === OUT_READY
      || instate.expectedPacket !== pktType) {
    self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, expected: '
               + instate.expectedPacket
               + ' but got: '
               + pktType);
    self.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
    var err = new Error('Received unexpected packet');
    err.level = 'protocol';
    self.emit('error', err);
    return false;
  }

  if (RE_GEX.test(state.kexdh)) {
    // Dynamic group exchange-related

    if (self.server) {
      // TODO: Support group exchange server-side
      self.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
      var err = new Error('DH group exchange not supported by server');
      err.level = 'handshake';
      self.emit('error', err);
      return false;
    } else {
      if (type === MESSAGE.KEXDH_GEX_GROUP) {
        /*
          byte    SSH_MSG_KEX_DH_GEX_GROUP
          mpint   p, safe prime
          mpint   g, generator for subgroup in GF(p)
        */
        var prime = readString(payload, 1, self, callback);
        if (prime === false)
          return false;
        var gen = readString(payload, payload._pos, self, callback);
        if (gen === false)
          return false;
        self.emit('KEXDH_GEX_GROUP', prime, gen);
      } else if (type === MESSAGE.KEXDH_GEX_REPLY)
        return parse_KEXDH_REPLY(self, callback);
    }
  } else {
    // Static group or ECDH-related

    if (type === MESSAGE.KEXDH_INIT) {
      /*
        byte      SSH_MSG_KEXDH_INIT
        mpint     e
      */
      var e = readString(payload, 1, self, callback);
      if (e === false)
        return false;

      self.emit('KEXDH_INIT', e);
    } else if (type === MESSAGE.KEXDH_REPLY)
      return parse_KEXDH_REPLY(self, callback);
  }
}

function parse_KEXDH_REPLY(self, callback) {
  var payload = self._state.incoming.payload;
  /*
    byte      SSH_MSG_KEXDH_REPLY
                / SSH_MSG_KEX_DH_GEX_REPLY
                / SSH_MSG_KEX_ECDH_REPLY
    string    server public host key and certificates (K_S)
    mpint     f
    string    signature of H
  */
  var hostkey = readString(payload, 1, self, callback);
  if (hostkey === false)
    return false;
  var pubkey = readString(payload, payload._pos, self, callback);
  if (pubkey === false)
    return false;
  var sig = readString(payload, payload._pos, self, callback);
  if (sig === false)
    return false;
  var info = {
    hostkey: hostkey,
    hostkey_format: undefined,
    pubkey: pubkey,
    sig: sig,
    sig_format: undefined
  };
  var hostkey_format = readString(hostkey, 0, 'ascii', self, callback);
  if (hostkey_format === false)
    return false;
  info.hostkey_format = hostkey_format;
  var sig_format = readString(sig, 0, 'ascii', self, callback);
  if (sig_format === false)
    return false;
  info.sig_format = sig_format;
  self.emit('KEXDH_REPLY', info);
}

function parse_USERAUTH(self, type, callback) {
  var state = self._state;
  var authMethod = state.authsQueue[0];
  var payload = state.incoming.payload;
  var message;
  var lang;
  var text;

  if (authMethod === 'password') {
    if (type === MESSAGE.USERAUTH_PASSWD_CHANGEREQ) {
      /*
        byte      SSH_MSG_USERAUTH_PASSWD_CHANGEREQ
        string    prompt in ISO-10646 UTF-8 encoding
        string    language tag
      */
      message = readString(payload, 1, 'utf8', self, callback);
      if (message === false)
        return false;
      lang = readString(payload, payload._pos, 'utf8', self, callback);
      if (lang === false)
        return false;
      self.emit('USERAUTH_PASSWD_CHANGEREQ', message, lang);
    }
  } else if (authMethod === 'keyboard-interactive') {
    if (type === MESSAGE.USERAUTH_INFO_REQUEST) {
      /*
        byte      SSH_MSG_USERAUTH_INFO_REQUEST
        string    name (ISO-10646 UTF-8)
        string    instruction (ISO-10646 UTF-8)
        string    language tag -- MAY be empty
        int       num-prompts
        string    prompt[1] (ISO-10646 UTF-8)
        boolean   echo[1]
        ...
        string    prompt[num-prompts] (ISO-10646 UTF-8)
        boolean   echo[num-prompts]
      */
      var name;
      var instr;
      var nprompts;

      name = readString(payload, 1, 'utf8', self, callback);
      if (name === false)
        return false;
      instr = readString(payload, payload._pos, 'utf8', self, callback);
      if (instr === false)
        return false;
      lang = readString(payload, payload._pos, 'utf8', self, callback);
      if (lang === false)
        return false;
      nprompts = readInt(payload, payload._pos, self, callback);
      if (nprompts === false)
        return false;

      payload._pos += 4;

      var prompts = [];
      for (var prompt = 0; prompt < nprompts; ++prompt) {
        text = readString(payload, payload._pos, 'utf8', self, callback);
        if (text === false)
          return false;
        var echo = payload[payload._pos++];
        if (echo === undefined)
          return false;
        echo = (echo !== 0);
        prompts.push({
          prompt: text,
          echo: echo
        });
      }
      self.emit('USERAUTH_INFO_REQUEST', name, instr, lang, prompts);
    } else if (type === MESSAGE.USERAUTH_INFO_RESPONSE) {
      /*
        byte      SSH_MSG_USERAUTH_INFO_RESPONSE
        int       num-responses
        string    response[1] (ISO-10646 UTF-8)
        ...
        string    response[num-responses] (ISO-10646 UTF-8)
      */
      var nresponses = readInt(payload, 1, self, callback);
      if (nresponses === false)
        return false;

      payload._pos = 5;

      var responses = [];
      for (var response = 0; response < nresponses; ++response) {
        text = readString(payload, payload._pos, 'utf8', self, callback);
        if (text === false)
          return false;
        responses.push(text);
      }
      self.emit('USERAUTH_INFO_RESPONSE', responses);
    }
  } else if (authMethod === 'publickey') {
    if (type === MESSAGE.USERAUTH_PK_OK) {
      /*
        byte      SSH_MSG_USERAUTH_PK_OK
        string    public key algorithm name from the request
        string    public key blob from the request
      */
      var authsQueue = self._state.authsQueue;
      if (!authsQueue.length || authsQueue[0] !== 'publickey')
        return;
      authsQueue.shift();
      self.emit('USERAUTH_PK_OK');
      // XXX: Parse public key info? client currently can ignore it because
      // there is only one outstanding auth request at any given time, so it
      // knows which key was OK'd
    }
  } else if (authMethod !== undefined) {
    // Invalid packet for this auth type
    self.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR);
    var err = new Error('Invalid authentication method: ' + authMethod);
    err.level = 'protocol';
    self.emit('error', err);
  }
}

function parse_CHANNEL_REQUEST(self, callback) {
  var payload = self._state.incoming.payload;
  var info;
  var cols;
  var rows;
  var width;
  var height;
  var wantReply;
  var signal;

  var recipient = readInt(payload, 1, self, callback);
  if (recipient === false)
    return false;
  var request = readString(payload, 5, 'ascii', self, callback);
  if (request === false)
    return false;

  if (request === 'exit-status') { // Server->Client
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "exit-status"
      boolean   FALSE
      uint32    exit_status
    */
    var code = readInt(payload, ++payload._pos, self, callback);
    if (code === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: false,
      code: code
    };
  } else if (request === 'exit-signal') { // Server->Client
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "exit-signal"
      boolean   FALSE
      string    signal name (without the "SIG" prefix)
      boolean   core dumped
      string    error message in ISO-10646 UTF-8 encoding
      string    language tag
    */
    var coredump;
    if (!(self.remoteBugs & BUGS.OLD_EXIT)) {
      signal = readString(payload, ++payload._pos, 'ascii', self, callback);
      if (signal === false)
        return false;
      coredump = payload[payload._pos++];
      if (coredump === undefined)
        return false;
      coredump = (coredump !== 0);
    } else {
      /*
        Instead of `signal name` and `core dumped`, we have just:

        uint32  signal number
      */
      signal = readInt(payload, ++payload._pos, self, callback);
      if (signal === false)
        return false;
      switch (signal) {
        case 1:
          signal = 'HUP';
          break;
        case 2:
          signal = 'INT';
          break;
        case 3:
          signal = 'QUIT';
          break;
        case 6:
          signal = 'ABRT';
          break;
        case 9:
          signal = 'KILL';
          break;
        case 14:
          signal = 'ALRM';
          break;
        case 15:
          signal = 'TERM';
          break;
        default:
          // Unknown or OS-specific
          signal = 'UNKNOWN (' + signal + ')';
      }
      coredump = false;
    }
    var description = readString(payload, payload._pos, 'utf8', self,
                                 callback);
    if (description === false)
      return false;
    var lang = readString(payload, payload._pos, 'utf8', self, callback);
    if (lang === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: false,
      signal: signal,
      coredump: coredump,
      description: description,
      lang: lang
    };
  } else if (request === 'pty-req') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "pty-req"
      boolean   want_reply
      string    TERM environment variable value (e.g., vt100)
      uint32    terminal width, characters (e.g., 80)
      uint32    terminal height, rows (e.g., 24)
      uint32    terminal width, pixels (e.g., 640)
      uint32    terminal height, pixels (e.g., 480)
      string    encoded terminal modes
    */
    wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    var term = readString(payload, payload._pos, 'ascii', self, callback);
    if (term === false)
      return false;
    cols = readInt(payload, payload._pos, self, callback);
    if (cols === false)
      return false;
    rows = readInt(payload, payload._pos += 4, self, callback);
    if (rows === false)
      return false;
    width = readInt(payload, payload._pos += 4, self, callback);
    if (width === false)
      return false;
    height = readInt(payload, payload._pos += 4, self, callback);
    if (height === false)
      return false;
    var modes = readString(payload, payload._pos += 4, self, callback);
    if (modes === false)
      return false;
    modes = bytesToModes(modes);
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply,
      term: term,
      cols: cols,
      rows: rows,
      width: width,
      height: height,
      modes: modes
    };
  } else if (request === 'window-change') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "window-change"
      boolean   FALSE
      uint32    terminal width, columns
      uint32    terminal height, rows
      uint32    terminal width, pixels
      uint32    terminal height, pixels
    */
    cols = readInt(payload, ++payload._pos, self, callback);
    if (cols === false)
      return false;
    rows = readInt(payload, payload._pos += 4, self, callback);
    if (rows === false)
      return false;
    width = readInt(payload, payload._pos += 4, self, callback);
    if (width === false)
      return false;
    height = readInt(payload, payload._pos += 4, self, callback);
    if (height === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: false,
      cols: cols,
      rows: rows,
      width: width,
      height: height
    };
  } else if (request === 'x11-req') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "x11-req"
      boolean   want reply
      boolean   single connection
      string    x11 authentication protocol
      string    x11 authentication cookie
      uint32    x11 screen number
    */
    wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    var single = payload[payload._pos++];
    if (single === undefined)
      return false;
    single = (single !== 0);
    var protocol = readString(payload, payload._pos, 'ascii', self, callback);
    if (protocol === false)
      return false;
    var cookie = readString(payload, payload._pos, 'hex', self, callback);
    if (cookie === false)
      return false;
    var screen = readInt(payload, payload._pos, self, callback);
    if (screen === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply,
      single: single,
      protocol: protocol,
      cookie: cookie,
      screen: screen
    };
  } else if (request === 'env') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "env"
      boolean   want reply
      string    variable name
      string    variable value
    */
    wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    var key = readString(payload, payload._pos, 'utf8', self, callback);
    if (key === false)
      return false;
    var val = readString(payload, payload._pos, 'utf8', self, callback);
    if (val === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply,
      key: key,
      val: val
    };
  } else if (request === 'shell') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "shell"
      boolean   want reply
    */
    wantReply = payload[payload._pos];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply
    };
  } else if (request === 'exec') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "exec"
      boolean   want reply
      string    command
    */
    wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    var command = readString(payload, payload._pos, 'utf8', self, callback);
    if (command === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply,
      command: command
    };
  } else if (request === 'subsystem') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "subsystem"
      boolean   want reply
      string    subsystem name
    */
    wantReply = payload[payload._pos++];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    var subsystem = readString(payload, payload._pos, 'utf8', self, callback);
    if (subsystem === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply,
      subsystem: subsystem
    };
  } else if (request === 'signal') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "signal"
      boolean   FALSE
      string    signal name (without the "SIG" prefix)
    */
    signal = readString(payload, ++payload._pos, 'ascii', self, callback);
    if (signal === false)
      return false;
    info = {
      recipient: recipient,
      request: request,
      wantReply: false,
      signal: 'SIG' + signal
    };
  } else if (request === 'xon-xoff') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "xon-xoff"
      boolean   FALSE
      boolean   client can do
    */
    var clientControl = payload[++payload._pos];
    if (clientControl === undefined)
      return false;
    clientControl = (clientControl !== 0);
    info = {
      recipient: recipient,
      request: request,
      wantReply: false,
      clientControl: clientControl
    };
  } else if (request === 'auth-agent-req@openssh.com') { // Client->Server
    /*
      byte      SSH_MSG_CHANNEL_REQUEST
      uint32    recipient channel
      string    "auth-agent-req@openssh.com"
      boolean   want reply
    */
    wantReply = payload[payload._pos];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply
    };
  } else {
    // Unknown request type
    wantReply = payload[payload._pos];
    if (wantReply === undefined)
      return false;
    wantReply = (wantReply !== 0);
    info = {
      recipient: recipient,
      request: request,
      wantReply: wantReply
    };
  }
  self.debug('DEBUG: Parser: IN_PACKETDATAAFTER, packet: CHANNEL_REQUEST ('
             + recipient
             + ', '
             + request
             + ')');
  self.emit('CHANNEL_REQUEST:' + recipient, info);
}

function hmacVerify(self, data) {
  var instate = self._state.incoming;
  var hmac = instate.hmac;

  self.debug('DEBUG: Parser: Verifying MAC');

  if (instate.decrypt.isGCM) {
    var decrypt = instate.decrypt;
    var instance = decrypt.instance;

    instance.setAuthTag(data);

    var payload = instance.update(instate.packet);
    instate.payload = payload.slice(1, instate.packet.length + 4 - payload[0]);
    //instance.final();
    iv_inc(decrypt.iv);

    decrypt.instance = crypto.createDecipheriv(
                         SSH_TO_OPENSSL[decrypt.type],
                         decrypt.key,
                         decrypt.iv
                       );
    decrypt.instance.setAutoPadding(false);
    return true;
  } else {
    var calcHmac = crypto.createHmac(SSH_TO_OPENSSL[hmac.type], hmac.key);

    hmac.bufCompute.writeUInt32BE(instate.seqno, 0, true);
    hmac.bufCompute.writeUInt32BE(instate.pktLen, 4, true);
    hmac.bufCompute[8] = instate.padLen;

    calcHmac.update(hmac.bufCompute);
    calcHmac.update(instate.packet);

    var mac = calcHmac.digest('binary');
    if (mac.length > instate.hmac.size)
      mac = mac.slice(0, instate.hmac.size);
    return (mac === data.toString('binary'));
  }
}

function decryptData(self, data) {
  var instance = self._state.incoming.decrypt.instance;
  self.debug('DEBUG: Parser: Decrypting');
  return instance.update(data);
}

function expectData(self, type, amount, bufferKey) {
  var expect = self._state.incoming.expect;
  expect.amount = amount;
  expect.type = type;
  expect.ptr = 0;
  if (bufferKey && self[bufferKey])
    expect.buf = self[bufferKey];
  else if (amount)
    expect.buf = new Buffer(amount);
}

function readList(buffer, start, stream, callback) {
  var list = readString(buffer, start, 'ascii', stream, callback);
  return (list !== false ? (list.length ? list.split(',') : []) : false);
}

function bytesToModes(buffer) {
  var modes = {};

  for (var i = 0, len = buffer.length, opcode; i < len; i += 5) {
    opcode = buffer[i];
    if (opcode === TERMINAL_MODE.TTY_OP_END
        || TERMINAL_MODE[opcode] === undefined
        || i + 5 > len)
      break;
    modes[TERMINAL_MODE[opcode]] = buffer.readUInt32BE(i + 1, true);
  }

  return modes;
}

function modesToBytes(modes) {
  var RE_IS_NUM = /^\d+$/;
  var keys = Object.keys(modes);
  var b = 0;
  var bytes = [];

  for (var i = 0, len = keys.length, key, opcode, val; i < len; ++i) {
    key = keys[i];
    opcode = TERMINAL_MODE[key];
    if (opcode
        && !RE_IS_NUM.test(key)
        && typeof modes[key] === 'number'
        && key !== 'TTY_OP_END') {
      val = modes[key];
      bytes[b++] = opcode;
      bytes[b++] = (val >>> 24) & 0xFF;
      bytes[b++] = (val >>> 16) & 0xFF;
      bytes[b++] = (val >>> 8) & 0xFF;
      bytes[b++] = val & 0xFF;
    }
  }

  bytes[b] = TERMINAL_MODE.TTY_OP_END;

  return bytes;
}

// Shared outgoing functions
function KEXINIT(self, cb) { // Client/Server
  randBytes(16, function(myCookie) {
    /*
      byte         SSH_MSG_KEXINIT
      byte[16]     cookie (random bytes)
      name-list    kex_algorithms
      name-list    server_host_key_algorithms
      name-list    encryption_algorithms_client_to_server
      name-list    encryption_algorithms_server_to_client
      name-list    mac_algorithms_client_to_server
      name-list    mac_algorithms_server_to_client
      name-list    compression_algorithms_client_to_server
      name-list    compression_algorithms_server_to_client
      name-list    languages_client_to_server
      name-list    languages_server_to_client
      boolean      first_kex_packet_follows
      uint32       0 (reserved for future extension)
    */
    var algos = self.config.algorithms;

    var kexBuf = algos.kexBuf;
    if (self.remoteBugs & BUGS.BAD_DHGEX) {
      var copied = false;
      var kexList = algos.kex;
      for (var j = kexList.length - 1; j >= 0; --j) {
        if (kexList[j].indexOf('group-exchange') !== -1) {
          if (!copied) {
            kexList = kexList.slice();
            copied = true;
          }
          kexList.splice(j, 1);
        }
      }
      if (copied)
        kexBuf = new Buffer(kexList.join(','));
    }

    var hostKeyBuf = algos.serverHostKeyBuf;

    var kexInitSize = 1 + 16
                      + 4 + kexBuf.length
                      + 4 + hostKeyBuf.length
                      + (2 * (4 + algos.cipherBuf.length))
                      + (2 * (4 + algos.hmacBuf.length))
                      + (2 * (4 + algos.compressBuf.length))
                      + (2 * (4 /* languages skipped */))
                      + 1 + 4;
    var buf = new Buffer(kexInitSize);
    var p = 17;

    buf.fill(0);

    buf[0] = MESSAGE.KEXINIT;

    if (myCookie !== false)
      myCookie.copy(buf, 1);

    buf.writeUInt32BE(kexBuf.length, p, true);
    p += 4;
    kexBuf.copy(buf, p);
    p += kexBuf.length;

    buf.writeUInt32BE(hostKeyBuf.length, p, true);
    p += 4;
    hostKeyBuf.copy(buf, p);
    p += hostKeyBuf.length;

    buf.writeUInt32BE(algos.cipherBuf.length, p, true);
    p += 4;
    algos.cipherBuf.copy(buf, p);
    p += algos.cipherBuf.length;

    buf.writeUInt32BE(algos.cipherBuf.length, p, true);
    p += 4;
    algos.cipherBuf.copy(buf, p);
    p += algos.cipherBuf.length;

    buf.writeUInt32BE(algos.hmacBuf.length, p, true);
    p += 4;
    algos.hmacBuf.copy(buf, p);
    p += algos.hmacBuf.length;

    buf.writeUInt32BE(algos.hmacBuf.length, p, true);
    p += 4;
    algos.hmacBuf.copy(buf, p);
    p += algos.hmacBuf.length;

    buf.writeUInt32BE(algos.compressBuf.length, p, true);
    p += 4;
    algos.compressBuf.copy(buf, p);
    p += algos.compressBuf.length;

    buf.writeUInt32BE(algos.compressBuf.length, p, true);
    p += 4;
    algos.compressBuf.copy(buf, p);
    p += algos.compressBuf.length;

    // Skip language lists, first_kex_packet_follows, and reserved bytes

    self.debug('DEBUG: Outgoing: Writing KEXINIT');

    self._state.incoming.expectedPacket = 'KEXINIT';

    var outstate = self._state.outgoing;

    outstate.kexinit = buf;

    if (outstate.status === OUT_READY) {
      // We are the one starting the rekeying process ...
      outstate.status = OUT_REKEYING;
    }

    send(self, buf, cb, true);
  });
  return true;
}

function KEXDH_INIT(self) { // Client
  var state = self._state;
  var outstate = state.outgoing;
  var buf = new Buffer(1 + 4 + outstate.pubkey.length);

  if (RE_GEX.test(state.kexdh)) {
    state.incoming.expectedPacket = 'KEXDH_GEX_REPLY';
    buf[0] = MESSAGE.KEXDH_GEX_INIT;
    self.debug('DEBUG: Outgoing: Writing KEXDH_GEX_INIT');
  } else {
    state.incoming.expectedPacket = 'KEXDH_REPLY';
    buf[0] = MESSAGE.KEXDH_INIT;
    if (state.kexdh !== 'group')
      self.debug('DEBUG: Outgoing: Writing KEXECDH_INIT');
    else
      self.debug('DEBUG: Outgoing: Writing KEXDH_INIT');
  }

  buf.writeUInt32BE(outstate.pubkey.length, 1, true);
  outstate.pubkey.copy(buf, 5);

  return send(self, buf, undefined, true);
}

function KEXDH_REPLY(self, e) { // Server
  var state = self._state;
  var outstate = state.outgoing;
  var instate = state.incoming;
  var curHostKey = self.config.hostKeys[state.hostkeyFormat];
  var hostkey = curHostKey.publicKey.public;
  var hostkeyAlgo = curHostKey.publicKey.fulltype;
  var privateKey = curHostKey.privateKey.privateOrig;

  // e === client DH public key

  var slicepos = -1;
  for (var i = 0, len = e.length; i < len; ++i) {
    if (e[i] === 0)
      ++slicepos;
    else
      break;
  }
  if (slicepos > -1)
    e = e.slice(slicepos + 1);

  var secret = tryComputeSecret(state.kex, e);
  if (secret instanceof Error) {
    secret.message = 'Error while computing DH secret ('
                     + state.kexdh + '): '
                     + secret.message;
    secret.level = 'handshake';
    self.emit('error', secret);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  var hashAlgo;
  if (state.kexdh === 'group')
    hashAlgo = 'sha1';
  else
    hashAlgo = RE_KEX_HASH.exec(state.kexdh)[1];

  var hash = crypto.createHash(hashAlgo);

  var len_ident = Buffer.byteLength(instate.identRaw);
  var len_sident = Buffer.byteLength(self.config.ident);
  var len_init = instate.kexinit.length;
  var len_sinit = outstate.kexinit.length;
  var len_hostkey = hostkey.length;
  var len_pubkey = e.length;
  var len_spubkey = outstate.pubkey.length;
  var len_secret = secret.length;

  var idx_spubkey = 0;
  var idx_secret = 0;

  while (outstate.pubkey[idx_spubkey] === 0x00) {
    ++idx_spubkey;
    --len_spubkey;
  }
  while (secret[idx_secret] === 0x00) {
    ++idx_secret;
    --len_secret;
  }
  if (e[0] & 0x80)
    ++len_pubkey;
  if (outstate.pubkey[idx_spubkey] & 0x80)
    ++len_spubkey;
  if (secret[idx_secret] & 0x80)
    ++len_secret;

  var exchangeBufLen = len_ident
                       + len_sident
                       + len_init
                       + len_sinit
                       + len_hostkey
                       + len_pubkey
                       + len_spubkey
                       + len_secret
                       + (4 * 8); // Length fields for above values

  // Group exchange-related
  var isGEX = RE_GEX.test(state.kexdh);
  var len_gex_prime = 0;
  var len_gex_gen = 0;
  var idx_gex_prime = 0;
  var idx_gex_gen = 0;
  var gex_prime;
  var gex_gen;
  if (isGEX) {
    gex_prime = state.kex.getPrime();
    gex_gen = state.kex.getGenerator();
    len_gex_prime = gex_prime.length;
    len_gex_gen = gex_gen.length;
    while (gex_prime[idx_gex_prime] === 0x00) {
      ++idx_gex_prime;
      --len_gex_prime;
    }
    while (gex_gen[idx_gex_gen] === 0x00) {
      ++idx_gex_gen;
      --len_gex_gen;
    }
    if (gex_prime[idx_gex_prime] & 0x80)
      ++len_gex_prime;
    if (gex_gen[idx_gex_gen] & 0x80)
      ++len_gex_gen;
    exchangeBufLen += (4 * 3); // min, n, max values
    exchangeBufLen += (4 * 2); // prime, generator length fields
    exchangeBufLen += len_gex_prime;
    exchangeBufLen += len_gex_gen;
  }

  var bp = 0;
  var exchangeBuf = new Buffer(exchangeBufLen);

  exchangeBuf.writeUInt32BE(len_ident, bp, true);
  bp += 4;
  exchangeBuf.write(instate.identRaw, bp, 'utf8'); // V_C
  bp += len_ident;

  exchangeBuf.writeUInt32BE(len_sident, bp, true);
  bp += 4;
  exchangeBuf.write(self.config.ident, bp, 'utf8'); // V_S
  bp += len_sident;

  exchangeBuf.writeUInt32BE(len_init, bp, true);
  bp += 4;
  instate.kexinit.copy(exchangeBuf, bp); // I_C
  bp += len_init;
  instate.kexinit = undefined;

  exchangeBuf.writeUInt32BE(len_sinit, bp, true);
  bp += 4;
  outstate.kexinit.copy(exchangeBuf, bp); // I_S
  bp += len_sinit;
  outstate.kexinit = undefined;

  exchangeBuf.writeUInt32BE(len_hostkey, bp, true);
  bp += 4;
  hostkey.copy(exchangeBuf, bp); // K_S
  bp += len_hostkey;

  if (isGEX) {
    KEXDH_GEX_REQ_PACKET.slice(1).copy(exchangeBuf, bp); // min, n, max
    bp += (4 * 3); // Skip over bytes just copied

    exchangeBuf.writeUInt32BE(len_gex_prime, bp, true);
    bp += 4;
    if (gex_prime[idx_gex_prime] & 0x80)
      exchangeBuf[bp++] = 0;
    gex_prime.copy(exchangeBuf, bp, idx_gex_prime); // p
    bp += len_gex_prime - (gex_prime[idx_gex_prime] & 0x80 ? 1 : 0);

    exchangeBuf.writeUInt32BE(len_gex_gen, bp, true);
    bp += 4;
    if (gex_gen[idx_gex_gen] & 0x80)
      exchangeBuf[bp++] = 0;
    gex_gen.copy(exchangeBuf, bp, idx_gex_gen); // g
    bp += len_gex_gen - (gex_gen[idx_gex_gen] & 0x80 ? 1 : 0);
  }

  exchangeBuf.writeUInt32BE(len_pubkey, bp, true);
  bp += 4;
  if (e[0] & 0x80)
    exchangeBuf[bp++] = 0;
  e.copy(exchangeBuf, bp); // e
  bp += len_pubkey - (e[0] & 0x80 ? 1 : 0);

  exchangeBuf.writeUInt32BE(len_spubkey, bp, true);
  bp += 4;
  if (outstate.pubkey[idx_spubkey] & 0x80)
    exchangeBuf[bp++] = 0;
  outstate.pubkey.copy(exchangeBuf, bp, idx_spubkey); // f
  bp += len_spubkey - (outstate.pubkey[idx_spubkey] & 0x80 ? 1 : 0);

  exchangeBuf.writeUInt32BE(len_secret, bp, true);
  bp += 4;
  if (secret[idx_secret] & 0x80)
    exchangeBuf[bp++] = 0;
  secret.copy(exchangeBuf, bp, idx_secret); // K

  outstate.exchangeHash = hash.update(exchangeBuf).digest(); // H

  if (outstate.sessionId === undefined)
    outstate.sessionId = outstate.exchangeHash;
  outstate.kexsecret = secret;

  var signAlgo;
  switch (hostkeyAlgo) {
    case 'ssh-rsa':
      signAlgo = 'RSA-SHA1';
      break;
    case 'ssh-dss':
      signAlgo = 'DSA-SHA1';
      break;
    case 'ecdsa-sha2-nistp256':
      signAlgo = 'sha256';
      break;
    case 'ecdsa-sha2-nistp384':
      signAlgo = 'sha384';
      break;
    case 'ecdsa-sha2-nistp521':
      signAlgo = 'sha512';
      break;
  }
  var signer = crypto.createSign(signAlgo);
  var signature;
  signer.update(outstate.exchangeHash);
  signature = trySign(signer, privateKey);
  if (signature instanceof Error) {
    signature.message = 'Error while signing data with host key ('
                        + hostkeyAlgo + '): '
                        + signature.message;
    signature.level = 'handshake';
    self.emit('error', signature);
    self.disconnect(DISCONNECT_REASON.KEY_EXCHANGE_FAILED);
    return false;
  }

  if (signAlgo === 'DSA-SHA1') {
    signature = DSASigBERToBare(signature);
  } else if (signAlgo !== 'RSA-SHA1') {
    // ECDSA
    signature = ECDSASigASN1ToSSH(signature);
  }

  /*
    byte      SSH_MSG_KEXDH_REPLY
    string    server public host key and certificates (K_S)
    mpint     f
    string    signature of H
  */

  var siglen = 4 + hostkeyAlgo.length + 4 + signature.length;
  var buf = new Buffer(1
                       + 4 + len_hostkey
                       + 4 + len_spubkey
                       + 4 + siglen);

  bp = 0;
  buf[bp] = (!isGEX ? MESSAGE.KEXDH_REPLY : MESSAGE.KEXDH_GEX_REPLY);
  ++bp;

  buf.writeUInt32BE(len_hostkey, bp, true);
  bp += 4;
  hostkey.copy(buf, bp); // K_S
  bp += len_hostkey;

  buf.writeUInt32BE(len_spubkey, bp, true);
  bp += 4;
  if (outstate.pubkey[idx_spubkey] & 0x80)
    buf[bp++] = 0;
  outstate.pubkey.copy(buf, bp, idx_spubkey); // f
  bp += len_spubkey - (outstate.pubkey[idx_spubkey] & 0x80 ? 1 : 0);

  buf.writeUInt32BE(siglen, bp, true);
  bp += 4;
  buf.writeUInt32BE(hostkeyAlgo.length, bp, true);
  bp += 4;
  buf.write(hostkeyAlgo, bp, hostkeyAlgo.length, 'ascii');
  bp += hostkeyAlgo.length;
  buf.writeUInt32BE(signature.length, bp, true);
  bp += 4;
  signature.copy(buf, bp);

  state.incoming.expectedPacket = 'NEWKEYS';

  if (isGEX)
    self.debug('DEBUG: Outgoing: Writing KEXDH_GEX_REPLY');
  else if (state.kexdh !== 'group')
    self.debug('DEBUG: Outgoing: Writing KEXECDH_REPLY');
  else
    self.debug('DEBUG: Outgoing: Writing KEXDH_REPLY');
  send(self, buf, undefined, true);

  outstate.sentNEWKEYS = true;
  self.debug('DEBUG: Outgoing: Writing NEWKEYS');
  return send(self, NEWKEYS_PACKET, undefined, true);
}

function KEXDH_GEX_REQ(self) { // Client
  self._state.incoming.expectedPacket = 'KEXDH_GEX_GROUP';

  self.debug('DEBUG: Outgoing: Writing KEXDH_GEX_REQUEST');
  return send(self, KEXDH_GEX_REQ_PACKET, undefined, true);
}

function send(self, payload, cb, bypass) {
  var state = self._state;

  if (!state)
    return false;

  var outstate = state.outgoing;
  if (outstate.status === OUT_REKEYING && !bypass) {
    if (typeof cb === 'function')
      outstate.rekeyQueue.push([payload, cb]);
    else
      outstate.rekeyQueue.push(payload);
    return false;
  } else if (self._readableState.ended || self._writableState.ended)
    return false;

  var compress = outstate.compress.instance;
  if (compress) {
    compress.write(payload);
    compress.flush(Z_PARTIAL_FLUSH, function() {
      if (self._readableState.ended || self._writableState.ended)
        return;
      send_(self, compress.read(), cb);
    });
    return true;
  } else
    return send_(self, payload, cb);
}

function send_(self, payload, cb) {
  // TODO: Implement length checks

  var state = self._state;
  var outstate = state.outgoing;
  var encrypt = outstate.encrypt;
  var hmac = outstate.hmac;
  var pktLen;
  var padLen;
  var buf;
  var mac;
  var ret;

  pktLen = payload.length + 9;

  if (encrypt.instance !== false && encrypt.isGCM) {
    var ptlen = 1 + payload.length + 4 /* Must have at least 4 bytes padding*/;
    while ((ptlen % encrypt.size) !== 0)
      ++ptlen;
    padLen = ptlen - 1 - payload.length;
    pktLen = 4 + ptlen;
  } else {
    pktLen += ((encrypt.size - 1) * pktLen) % encrypt.size;
    padLen = pktLen - payload.length - 5;
  }

  buf = new Buffer(pktLen);

  buf.writeUInt32BE(pktLen - 4, 0, true);
  buf[4] = padLen;
  payload.copy(buf, 5);

  var padBytes = crypto.randomBytes(padLen);
  padBytes.copy(buf, 5 + payload.length);

  if (hmac.type !== false && hmac.key) {
    mac = crypto.createHmac(SSH_TO_OPENSSL[hmac.type], hmac.key);
    outstate.bufSeqno.writeUInt32BE(outstate.seqno, 0, true);
    mac.update(outstate.bufSeqno);
    mac.update(buf);
    mac = mac.digest();
    if (mac.length > outstate.hmac.size)
      mac = mac.slice(0, outstate.hmac.size);
  }

  var nb = 0;
  var encData;

  if (encrypt.instance !== false) {
    if (encrypt.isGCM) {
      var encrypter = crypto.createCipheriv(SSH_TO_OPENSSL[encrypt.type],
                                            encrypt.key,
                                            encrypt.iv);
      encrypter.setAutoPadding(false);

      var lenbuf = buf.slice(0, 4);

      encrypter.setAAD(lenbuf);
      self.push(lenbuf);
      nb += lenbuf;

      encData = encrypter.update(buf.slice(4));
      self.push(encData);
      nb += encData.length;

      var final = encrypter.final();
      if (final.length) {
        self.push(final);
        nb += final.length;
      }

      var authTag = encrypter.getAuthTag();
      ret = self.push(authTag);
      nb += authTag.length;

      iv_inc(encrypt.iv);
    } else {
      encData = encrypt.instance.update(buf);
      self.push(encData);
      nb += encData.length;

      ret = self.push(mac);
      nb += mac.length;
    }
  } else {
    ret = self.push(buf);
    nb = buf.length;
  }

  self.bytesSent += nb;

  if (++outstate.seqno > MAX_SEQNO)
    outstate.seqno = 0;

  cb && cb();

  return ret;
}

function randBytes(n, cb) {
  crypto.randomBytes(n, function retry(err, buf) {
    if (err)
      return crypto.randomBytes(n, retry);
    cb && cb(buf);
  });
}

function trySign(sig, key) {
  try {
    return sig.sign(key);
  } catch (err) {
    return err;
  }
}

function tryComputeSecret(dh, e) {
  try {
    return dh.computeSecret(e);
  } catch (err) {
    return err;
  }
}

module.exports = SSH2Stream;
module.exports._send = send;
