var crypto = require('crypto');

var Ber = require('asn1').Ber;
var BigInteger = require('./jsbn'); // only for converting PPK -> OpenSSL format

var SSH_TO_OPENSSL = require('./constants').SSH_TO_OPENSSL;

var RE_STREAM = /^arcfour/i;
var RE_KEY_LEN = /(.{64})/g;
// XXX the value of 2400 from dropbear is only for certain strings, not all
// strings. for example the list strings used during handshakes
var MAX_STRING_LEN = Infinity;//2400; // taken from dropbear
var PPK_IV = new Buffer([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

module.exports = {
  iv_inc: iv_inc,
  isStreamCipher: isStreamCipher,
  readInt: readInt,
  readString: readString,
  parseKey: require('./keyParser'),
  genPublicKey: genPublicKey,
  convertPPKPrivate: convertPPKPrivate,
  verifyPPKMAC: verifyPPKMAC,
  decryptKey: decryptKey,
  DSASigBERToBare: DSASigBERToBare,
  DSASigBareToBER: DSASigBareToBER,
  ECDSASigASN1ToSSH: ECDSASigASN1ToSSH,
  ECDSASigSSHToASN1: ECDSASigSSHToASN1,
  RSAKeySSHToASN1: RSAKeySSHToASN1,
  DSAKeySSHToASN1: DSAKeySSHToASN1,
  ECDSAKeySSHToASN1: ECDSAKeySSHToASN1
};

function iv_inc(iv) {
  var n = 12;
  var c = 0;
  do {
    --n;
    c = iv[n];
    if (c === 255)
      iv[n] = 0;
    else {
      iv[n] = ++c;
      return;
    }
  } while (n > 4);
}

function isStreamCipher(name) {
  return RE_STREAM.test(name);
}

function readInt(buffer, start, stream, cb) {
  var bufferLen = buffer.length;
  if (start < 0 || start >= bufferLen || (bufferLen - start) < 4) {
    stream && stream._cleanup(cb);
    return false;
  }

  return buffer.readUInt32BE(start, true);
}

function DSASigBERToBare(signature) {
  if (signature.length <= 40)
    return signature;
  // This is a quick and dirty way to get from BER encoded r and s that
  // OpenSSL gives us, to just the bare values back to back (40 bytes
  // total) like OpenSSH (and possibly others) are expecting
  var asnReader = new Ber.Reader(signature);
  asnReader.readSequence();
  var r = asnReader.readString(Ber.Integer, true);
  var s = asnReader.readString(Ber.Integer, true);
  var rOffset = 0;
  var sOffset = 0;
  if (r.length < 20) {
    var rNew = new Buffer(20);
    r.copy(rNew, 1);
    r = rNew;
    r[0] = 0;
  }
  if (s.length < 20) {
    var sNew = new Buffer(20);
    s.copy(sNew, 1);
    s = sNew;
    s[0] = 0;
  }
  if (r.length > 20 && r[0] === 0x00)
    rOffset = 1;
  if (s.length > 20 && s[0] === 0x00)
    sOffset = 1;
  var newSig = new Buffer((r.length - rOffset) + (s.length - sOffset));
  r.copy(newSig, 0, rOffset);
  s.copy(newSig, r.length - rOffset, sOffset);
  return newSig;
}

function DSASigBareToBER(signature) {
  if (signature.length > 40)
    return signature;
  // Change bare signature r and s values to ASN.1 BER values for OpenSSL
  var asnWriter = new Ber.Writer();
  asnWriter.startSequence();
  var r = signature.slice(0, 20);
  var s = signature.slice(20);
  if (r[0] & 0x80) {
    var rNew = new Buffer(21);
    rNew[0] = 0x00;
    r.copy(rNew, 1);
    r = rNew;
  } else if (r[0] === 0x00 && !(r[1] & 0x80)) {
    r = r.slice(1);
  }
  if (s[0] & 0x80) {
    var sNew = new Buffer(21);
    sNew[0] = 0x00;
    s.copy(sNew, 1);
    s = sNew;
  } else if (s[0] === 0x00 && !(s[1] & 0x80)) {
    s = s.slice(1);
  }
  asnWriter.writeBuffer(r, Ber.Integer);
  asnWriter.writeBuffer(s, Ber.Integer);
  asnWriter.endSequence();
  return asnWriter.buffer;
}

function ECDSASigASN1ToSSH(signature) {
  if (signature[0] === 0x00)
    return signature;
  // Convert SSH signature parameters to ASN.1 BER values for OpenSSL
  var asnReader = new Ber.Reader(signature);
  asnReader.readSequence();
  var r = asnReader.readString(Ber.Integer, true);
  var s = asnReader.readString(Ber.Integer, true);
  if (r === null || s === null)
    throw new Error('Invalid signature');
  var newSig = new Buffer(4 + r.length + 4 + s.length);
  newSig.writeUInt32BE(r.length, 0, true);
  r.copy(newSig, 4);
  newSig.writeUInt32BE(s.length, 4 + r.length, true);
  s.copy(newSig, 4 + 4 + r.length);
  return newSig;
}

function ECDSASigSSHToASN1(signature, self, callback) {
  // Convert SSH signature parameters to ASN.1 BER values for OpenSSL
  var r = readString(signature, 0, self, callback);
  if (r === false)
    return false;
  var s = readString(signature, signature._pos, self, callback);
  if (s === false)
    return false;

  var asnWriter = new Ber.Writer();
  asnWriter.startSequence();
  asnWriter.writeBuffer(r, Ber.Integer);
  asnWriter.writeBuffer(s, Ber.Integer);
  asnWriter.endSequence();
  return asnWriter.buffer;
}

function RSAKeySSHToASN1(key, self, callback) {
  // Convert SSH key parameters to ASN.1 BER values for OpenSSL
  var e = readString(key, key._pos, self, callback);
  if (e === false)
    return false;
  var n = readString(key, key._pos, self, callback);
  if (n === false)
    return false;

  var asnWriter = new Ber.Writer();
  asnWriter.startSequence();
    // algorithm
    asnWriter.startSequence();
      asnWriter.writeOID('1.2.840.113549.1.1.1'); // rsaEncryption
      // algorithm parameters (RSA has none)
      asnWriter.writeNull();
    asnWriter.endSequence();

    // subjectPublicKey
    asnWriter.startSequence(Ber.BitString);
      asnWriter.writeByte(0x00);
      asnWriter.startSequence();
        asnWriter.writeBuffer(n, Ber.Integer);
        asnWriter.writeBuffer(e, Ber.Integer);
      asnWriter.endSequence();
    asnWriter.endSequence();
  asnWriter.endSequence();
  return asnWriter.buffer;
}

function DSAKeySSHToASN1(key, self, callback) {
  // Convert SSH key parameters to ASN.1 BER values for OpenSSL
  var p = readString(key, key._pos, self, callback);
  if (p === false)
    return false;
  var q = readString(key, key._pos, self, callback);
  if (q === false)
    return false;
  var g = readString(key, key._pos, self, callback);
  if (g === false)
    return false;
  var y = readString(key, key._pos, self, callback);
  if (y === false)
    return false;

  var asnWriter = new Ber.Writer();
  asnWriter.startSequence();
    // algorithm
    asnWriter.startSequence();
      asnWriter.writeOID('1.2.840.10040.4.1'); // id-dsa
      // algorithm parameters
      asnWriter.startSequence();
        asnWriter.writeBuffer(p, Ber.Integer);
        asnWriter.writeBuffer(q, Ber.Integer);
        asnWriter.writeBuffer(g, Ber.Integer);
      asnWriter.endSequence();
    asnWriter.endSequence();

    // subjectPublicKey
    asnWriter.startSequence(Ber.BitString);
      asnWriter.writeByte(0x00);
      asnWriter.writeBuffer(y, Ber.Integer);
    asnWriter.endSequence();
  asnWriter.endSequence();
  return asnWriter.buffer;
}

function ECDSAKeySSHToASN1(key, self, callback) {
  // Convert SSH key parameters to ASN.1 BER values for OpenSSL
  var curve = readString(key, key._pos, self, callback);
  if (curve === false)
    return false;
  var Q = readString(key, key._pos, self, callback);
  if (Q === false)
    return false;

  var ecCurveOID;
  switch (curve.toString('ascii')) {
    case 'nistp256':
      // prime256v1/secp256r1
      ecCurveOID = '1.2.840.10045.3.1.7';
      break;
    case 'nistp384':
      // secp384r1
      ecCurveOID = '1.3.132.0.34';
      break;
    case 'nistp521':
      // secp521r1
      ecCurveOID = '1.3.132.0.35';
      break;
    default:
      return false;
  }
  var asnWriter = new Ber.Writer();
  asnWriter.startSequence();
    // algorithm
    asnWriter.startSequence();
      asnWriter.writeOID('1.2.840.10045.2.1'); // id-ecPublicKey
      // algorithm parameters (namedCurve)
      asnWriter.writeOID(ecCurveOID);
    asnWriter.endSequence();

    // subjectPublicKey
    asnWriter.startSequence(Ber.BitString);
      asnWriter.writeByte(0x00);
      // XXX: hack to write a raw buffer without a tag -- yuck
      asnWriter._ensure(Q.length);
      Q.copy(asnWriter._buf, asnWriter._offset, 0, Q.length);
      asnWriter._offset += Q.length;
      // end hack
    asnWriter.endSequence();
  asnWriter.endSequence();
  return asnWriter.buffer;
}

function decryptKey(keyInfo, passphrase) {
  if (keyInfo._decrypted || !keyInfo.encryption)
    return;

  var keylen = 0;
  var key;
  var iv;
  var dc;

  keyInfo.encryption = (SSH_TO_OPENSSL[keyInfo.encryption]
                        || keyInfo.encryption);
  switch (keyInfo.encryption) {
    case 'aes-256-cbc':
    case 'aes-256-ctr':
      keylen = 32;
      break;
    case 'des-ede3-cbc':
    case 'des-ede3':
    case 'aes-192-cbc':
    case 'aes-192-ctr':
      keylen = 24;
      break;
    case 'aes-128-cbc':
    case 'aes-128-ctr':
    case 'cast-cbc':
    case 'bf-cbc':
      keylen = 16;
      break;
    default:
      throw new Error('Unsupported cipher for encrypted key: '
                      + keyInfo.encryption);
  }

  if (keyInfo.ppk) {
    iv = PPK_IV;

    key = Buffer.concat([
      crypto.createHash('sha1')
            .update('\x00\x00\x00\x00' + passphrase, 'utf8')
            .digest(),
      crypto.createHash('sha1')
            .update('\x00\x00\x00\x01' + passphrase, 'utf8')
            .digest()
    ]);
    key = key.slice(0, keylen);
  } else {
    iv = new Buffer(keyInfo.extra[0], 'hex');

    key = crypto.createHash('md5')
                .update(passphrase, 'utf8')
                .update(iv.slice(0, 8))
                .digest();

    while (keylen > key.length) {
      key = Buffer.concat([
        key,
        (crypto.createHash('md5')
               .update(key)
               .update(passphrase, 'utf8')
               .update(iv)
               .digest()).slice(0, 8)
      ]);
    }
    if (key.length > keylen)
      key = key.slice(0, keylen);
  }

  dc = crypto.createDecipheriv(keyInfo.encryption, key, iv);
  dc.setAutoPadding(false);
  keyInfo.private = Buffer.concat([ dc.update(keyInfo.private), dc.final() ]);

  keyInfo._decrypted = true;

  if (keyInfo.privateOrig) {
    // Update our original base64-encoded version of the private key
    var orig = keyInfo.privateOrig.toString('utf8');
    var newOrig = /^(.+(?:\r\n|\n))/.exec(orig)[1];
    var b64key = keyInfo.private.toString('base64');

    newOrig += b64key.match(/.{1,70}/g).join('\n');
    newOrig += /((?:\r\n|\n).+)$/.exec(orig)[1];

    keyInfo.privateOrig = newOrig;
  } else if (keyInfo.ppk) {
    var valid = verifyPPKMAC(keyInfo, passphrase, keyInfo.private);
    if (!valid)
      throw new Error('PPK MAC mismatch');
    // Automatically convert private key data to OpenSSL format
    // (including PEM)
    convertPPKPrivate(keyInfo);
  }

  // Fill in full key type
  // TODO: make DRY, we do this also in keyParser
  if (keyInfo.type !== 'ec') {
    keyInfo.fulltype = 'ssh-' + keyInfo.type;
  } else {
    // ECDSA
    var asnReader = new Ber.Reader(keyInfo.private);
    asnReader.readSequence();
    asnReader.readInt();
    asnReader.readString(Ber.OctetString, true);
    asnReader.readByte(); // Skip "complex" context type byte
    var offset = asnReader.readLength(); // Skip context length
    if (offset !== null) {
      asnReader._offset = offset;
      switch (asnReader.readOID()) {
        case '1.2.840.10045.3.1.7':
          // prime256v1/secp256r1
          keyInfo.fulltype = 'ecdsa-sha2-nistp256';
          break;
        case '1.3.132.0.34':
          // secp384r1
          keyInfo.fulltype = 'ecdsa-sha2-nistp384';
          break;
        case '1.3.132.0.35':
          // secp521r1
          keyInfo.fulltype = 'ecdsa-sha2-nistp521';
          break;
      }
    }
    if (keyInfo.fulltype === undefined)
      return new Error('Unsupported EC private key type');
  }
}

function genPublicKey(keyInfo) {
  var publicKey;
  var i;

  // RSA
  var n;
  var e;

  // DSA
  var p;
  var q;
  var g;
  var y;

  // ECDSA
  var d;
  var Q;
  var ecCurveOID;
  var ecCurveName;

  if (keyInfo.private) {
    // parsing private key in ASN.1 format in order to generate a public key
    var privKey = keyInfo.private;
    var asnReader = new Ber.Reader(privKey);
    var errMsg;

    if (asnReader.readSequence() === null) {
      errMsg = 'Malformed private key (expected sequence)';
      if (keyInfo._decrypted)
        errMsg += '. Bad passphrase?';
      throw new Error(errMsg);
    }

    // version (ignored)
    if (asnReader.readInt() === null) {
      errMsg = 'Malformed private key (expected version)';
      if (keyInfo._decrypted)
        errMsg += '. Bad passphrase?';
      throw new Error(errMsg);
    }

    if (keyInfo.type === 'rsa') {
      // modulus (n) -- integer
      n = asnReader.readString(Ber.Integer, true);
      if (n === null) {
        errMsg = 'Malformed private key (expected RSA n value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      // public exponent (e) -- integer
      e = asnReader.readString(Ber.Integer, true);
      if (e === null) {
        errMsg = 'Malformed private key (expected RSA e value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      publicKey = new Buffer(4 + 7 // ssh-rsa
                             + 4 + n.length
                             + 4 + e.length);

      publicKey.writeUInt32BE(7, 0, true);
      publicKey.write('ssh-rsa', 4, 7, 'ascii');

      i = 4 + 7;
      publicKey.writeUInt32BE(e.length, i, true);
      e.copy(publicKey, i += 4);

      publicKey.writeUInt32BE(n.length, i += e.length, true);
      n.copy(publicKey, i += 4);
    } else if (keyInfo.type === 'dss') { // DSA
      // prime (p) -- integer
      p = asnReader.readString(Ber.Integer, true);
      if (p === null) {
        errMsg = 'Malformed private key (expected DSA p value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      // group order (q) -- integer
      q = asnReader.readString(Ber.Integer, true);
      if (q === null) {
        errMsg = 'Malformed private key (expected DSA q value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      // group generator (g) -- integer
      g = asnReader.readString(Ber.Integer, true);
      if (g === null) {
        errMsg = 'Malformed private key (expected DSA g value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      // public key value (y) -- integer
      y = asnReader.readString(Ber.Integer, true);
      if (y === null) {
        errMsg = 'Malformed private key (expected DSA y value)';
        if (keyInfo._decrypted)
          errMsg += '. Bad passphrase?';
        throw new Error(errMsg);
      }

      publicKey = new Buffer(4 + 7 // ssh-dss
                             + 4 + p.length
                             + 4 + q.length
                             + 4 + g.length
                             + 4 + y.length);

      publicKey.writeUInt32BE(7, 0, true);
      publicKey.write('ssh-dss', 4, 7, 'ascii');

      i = 4 + 7;
      publicKey.writeUInt32BE(p.length, i, true);
      p.copy(publicKey, i += 4);

      publicKey.writeUInt32BE(q.length, i += p.length, true);
      q.copy(publicKey, i += 4);

      publicKey.writeUInt32BE(g.length, i += q.length, true);
      g.copy(publicKey, i += 4);

      publicKey.writeUInt32BE(y.length, i += g.length, true);
      y.copy(publicKey, i += 4);
    } else { // ECDSA
      d = asnReader.readString(Ber.OctetString, true);
      if (d === null)
        throw new Error('Malformed private key (expected ECDSA private key)');
      asnReader.readByte(); // Skip "complex" context type byte
      var offset = asnReader.readLength(); // Skip context length
      if (offset === null)
        throw new Error('Malformed private key (expected ECDSA context value)');
      asnReader._offset = offset;
      ecCurveOID = asnReader.readOID();
      if (ecCurveOID === null)
        throw new Error('Malformed private key (expected ECDSA curve)');
      var tempECDH;
      switch (ecCurveOID) {
        case '1.2.840.10045.3.1.7':
          // prime256v1/secp256r1
          keyInfo.curve = ecCurveName = 'nistp256';
          tempECDH = crypto.createECDH('prime256v1');
          break;
        case '1.3.132.0.34':
          // secp384r1
          keyInfo.curve = ecCurveName = 'nistp384';
          tempECDH = crypto.createECDH('secp384r1');
          break;
        case '1.3.132.0.35':
          // secp521r1
          keyInfo.curve = ecCurveName = 'nistp521';
          tempECDH = crypto.createECDH('secp521r1');
          break;
        default:
          throw new Error('Malformed private key (unsupported EC curve)');
      }
      tempECDH.setPrivateKey(d);
      Q = tempECDH.getPublicKey();

      publicKey = new Buffer(4 + 19 // ecdsa-sha2-<curve name>
                             + 4 + 8 // <curve name>
                             + 4 + Q.length);

      publicKey.writeUInt32BE(19, 0, true);
      publicKey.write('ecdsa-sha2-' + ecCurveName, 4, 19, 'ascii');

      publicKey.writeUInt32BE(8, 23, true);
      publicKey.write(ecCurveName, 27, 8, 'ascii');

      publicKey.writeUInt32BE(Q.length, 35, true);
      Q.copy(publicKey, 39);
    }
  } else if (keyInfo.public) {
    publicKey = keyInfo.public;
    if (keyInfo.type === 'ec') {
      // TODO: support adding ecdsa-* prefix
      ecCurveName = keyInfo.curve;
    } else if (publicKey[0] !== 0
      // check for missing ssh-{dsa,rsa} prefix
               || publicKey[1] !== 0
               || publicKey[2] !== 0
               || publicKey[3] !== 7
               || publicKey[4] !== 115
               || publicKey[5] !== 115
               || publicKey[6] !== 104
               || publicKey[7] !== 45
               || ((publicKey[8] !== 114
                    || publicKey[9] !== 115
                    || publicKey[10] !== 97)
                   &&
                   ((publicKey[8] !== 100
                     || publicKey[9] !== 115
                     || publicKey[10] !== 115)))) {
      var newPK = new Buffer(4 + 7 + publicKey.length);
      publicKey.copy(newPK, 11);
      newPK.writeUInt32BE(7, 0, true);
      if (keyInfo.type === 'rsa')
        newPK.write('ssh-rsa', 4, 7, 'ascii');
      else
        newPK.write('ssh-dss', 4, 7, 'ascii');
      publicKey = newPK;
    }
  } else
    throw new Error('Missing data generated by parseKey()');

  // generate a public key format for use with OpenSSL

  i = 4 + 7;

  var fulltype;
  var asn1KeyBuf;
  if (keyInfo.type === 'rsa') {
    fulltype = 'ssh-rsa';
    asn1KeyBuf = RSAKeySSHToASN1(publicKey.slice(4 + 7));
  } else if (keyInfo.type === 'dss') {
    fulltype = 'ssh-dss';
    asn1KeyBuf = DSAKeySSHToASN1(publicKey.slice(4 + 7));
  } else { // ECDSA
    fulltype = 'ecdsa-sha2-' + ecCurveName;
    asn1KeyBuf = ECDSAKeySSHToASN1(publicKey.slice(4 + 19));
  }

  if (!asn1KeyBuf)
    throw new Error('Invalid SSH-formatted public key');

  var b64key = asn1KeyBuf.toString('base64').replace(RE_KEY_LEN, '$1\n');
  var fullkey = '-----BEGIN PUBLIC KEY-----\n'
                + b64key
                + (b64key[b64key.length - 1] === '\n' ? '' : '\n')
                + '-----END PUBLIC KEY-----';

  return {
    type: keyInfo.type,
    fulltype: fulltype,
    curve: ecCurveName,
    public: publicKey,
    publicOrig: new Buffer(fullkey)
  };
}

function verifyPPKMAC(keyInfo, passphrase, privateKey) {
  if (keyInfo._macresult !== undefined)
    return keyInfo._macresult;
  else if (!keyInfo.ppk)
    throw new Error("Key isn't a PPK");
  else if (!keyInfo.privateMAC)
    throw new Error('Missing MAC');
  else if (!privateKey)
    throw new Error('Missing raw private key data');
  else if (keyInfo.encryption && typeof passphrase !== 'string')
    throw new Error('Missing passphrase for encrypted PPK');
  else if (keyInfo.encryption && !keyInfo._decrypted)
    throw new Error('PPK must be decrypted before verifying MAC');

  var mac = keyInfo.privateMAC;
  var typelen = keyInfo.fulltype.length;
  // encryption algorithm is converted at this point for use with OpenSSL,
  // so we need to use the original value so that the MAC is calculated
  // correctly
  var enc = (keyInfo.encryption ? 'aes256-cbc' : 'none');
  var enclen = enc.length;
  var commlen = Buffer.byteLength(keyInfo.comment);
  var pub = keyInfo.public;
  var publen = pub.length;
  var privlen = privateKey.length;
  var macdata = new Buffer(4 + typelen
                           + 4 + enclen
                           + 4 + commlen
                           + 4 + publen
                           + 4 + privlen);
  var p = 0;

  macdata.writeUInt32BE(typelen, p, true);
  macdata.write(keyInfo.fulltype, p += 4, typelen, 'ascii');
  macdata.writeUInt32BE(enclen, p += typelen, true);
  macdata.write(enc, p += 4, enclen, 'ascii');
  macdata.writeUInt32BE(commlen, p += enclen, true);
  macdata.write(keyInfo.comment, p += 4, commlen, 'utf8');
  macdata.writeUInt32BE(publen, p += commlen, true);
  pub.copy(macdata, p += 4);
  macdata.writeUInt32BE(privlen, p += publen, true);
  privateKey.copy(macdata, p += 4);

  if (typeof passphrase !== 'string')
    passphrase = '';

  var mackey = crypto.createHash('sha1')
                     .update('putty-private-key-file-mac-key', 'ascii')
                     .update(passphrase, 'utf8')
                     .digest();

  var calcMAC = crypto.createHmac('sha1', mackey)
                      .update(macdata)
                      .digest('hex');

  return (keyInfo._macresult = (calcMAC === mac));
}

function convertPPKPrivate(keyInfo) {
  if (!keyInfo.ppk || !keyInfo.public || !keyInfo.private)
    throw new Error("Key isn't a PPK");
  else if (keyInfo._converted)
    return false;

  var pub = keyInfo.public;
  var priv = keyInfo.private;
  var asnWriter = new Ber.Writer();
  var p;
  var q;

  if (keyInfo.type === 'rsa') {
    var e = readString(pub, 4 + 7);
    var n = readString(pub, pub._pos);
    var d = readString(priv, 0);
    p = readString(priv, priv._pos);
    q = readString(priv, priv._pos);
    var iqmp = readString(priv, priv._pos);
    var p1 = new BigInteger(p, 256);
    var q1 = new BigInteger(q, 256);
    var dmp1 = new BigInteger(d, 256);
    var dmq1 = new BigInteger(d, 256);

    dmp1 = new Buffer(dmp1.mod(p1.subtract(BigInteger.ONE)).toByteArray());
    dmq1 = new Buffer(dmq1.mod(q1.subtract(BigInteger.ONE)).toByteArray());

    asnWriter.startSequence();
      asnWriter.writeInt(0x00, Ber.Integer);
      asnWriter.writeBuffer(n, Ber.Integer);
      asnWriter.writeBuffer(e, Ber.Integer);
      asnWriter.writeBuffer(d, Ber.Integer);
      asnWriter.writeBuffer(p, Ber.Integer);
      asnWriter.writeBuffer(q, Ber.Integer);
      asnWriter.writeBuffer(dmp1, Ber.Integer);
      asnWriter.writeBuffer(dmq1, Ber.Integer);
      asnWriter.writeBuffer(iqmp, Ber.Integer);
    asnWriter.endSequence();
  } else {
    p = readString(pub, 4 + 7);
    q = readString(pub, pub._pos);
    var g = readString(pub, pub._pos);
    var y = readString(pub, pub._pos);
    var x = readString(priv, 0);

    asnWriter.startSequence();
      asnWriter.writeInt(0x00, Ber.Integer);
      asnWriter.writeBuffer(p, Ber.Integer);
      asnWriter.writeBuffer(q, Ber.Integer);
      asnWriter.writeBuffer(g, Ber.Integer);
      asnWriter.writeBuffer(y, Ber.Integer);
      asnWriter.writeBuffer(x, Ber.Integer);
    asnWriter.endSequence();
  }

  var b64key = asnWriter.buffer.toString('base64').replace(RE_KEY_LEN, '$1\n');
  var fullkey = '-----BEGIN '
                + (keyInfo.type === 'rsa' ? 'RSA' : 'DSA')
                + ' PRIVATE KEY-----\n'
                + b64key
                + (b64key[b64key.length - 1] === '\n' ? '' : '\n')
                + '-----END '
                + (keyInfo.type === 'rsa' ? 'RSA' : 'DSA')
                + ' PRIVATE KEY-----';

  keyInfo.private = asnWriter.buffer;
  keyInfo.privateOrig = new Buffer(fullkey);
  keyInfo._converted = true;
  return true;
}

function readString(buffer, start, encoding, stream, cb, maxLen) {
  if (encoding && !Buffer.isBuffer(encoding) && typeof encoding !== 'string') {
    if (typeof cb === 'number')
      maxLen = cb;
    cb = stream;
    stream = encoding;
    encoding = undefined;
  }

  start || (start = 0);
  var bufferLen = buffer.length;
  var left = (bufferLen - start);
  var len;
  var end;
  if (start < 0 || start >= bufferLen || left < 4) {
    stream && stream._cleanup(cb);
    return false;
  }

  len = buffer.readUInt32BE(start, true);
  if (len > (maxLen || MAX_STRING_LEN) || left < (4 + len)) {
    stream && stream._cleanup(cb);
    return false;
  }

  start += 4;
  end = start + len;
  buffer._pos = end;

  if (encoding) {
    if (Buffer.isBuffer(encoding)) {
      buffer.copy(encoding, 0, start, end);
      return encoding;
    } else
      return buffer.toString(encoding, start, end);
  } else
    return buffer.slice(start, end);
}

