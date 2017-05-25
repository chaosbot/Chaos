// TODO:
//    * handle multi-line header values (OpenSSH)?
//    * more thorough validation?

var utils;
var Ber = require('asn1').Ber;
var semver = require('semver');

var RE_PPK = /^PuTTY-User-Key-File-2: ssh-(rsa|dss)\r?\nEncryption: (aes256-cbc|none)\r?\nComment: ([^\r\n]*)\r?\nPublic-Lines: \d+\r?\n([\s\S]+?)\r?\nPrivate-Lines: \d+\r?\n([\s\S]+?)\r?\nPrivate-MAC: ([^\r\n]+)/;
var RE_HEADER_OPENSSH_PRIV = /^-----BEGIN (RSA|DSA|EC) PRIVATE KEY-----$/i;
var RE_FOOTER_OPENSSH_PRIV = /^-----END (?:RSA|DSA|EC) PRIVATE KEY-----$/i;
var RE_HEADER_OPENSSH_PUB = /^((?:(?:ssh-(rsa|dss))|ecdsa-sha2-nistp(256|384|521))(?:-cert-v0[01]@openssh.com)?) ([A-Z0-9a-z\/+=]+)(?:$|\s+([\S].*)?)$/i;
var RE_HEADER_RFC4716_PUB = /^---- BEGIN SSH2 PUBLIC KEY ----$/i;
var RE_FOOTER_RFC4716_PUB = /^---- END SSH2 PUBLIC KEY ----$/i;
var RE_HEADER_OPENSSH = /^([^:]+):\s*([\S].*)?$/i;
var RE_HEADER_RFC4716 = /^([^:]+): (.*)?$/i;

module.exports = function(data) {
  if (Buffer.isBuffer(data))
    data = data.toString('utf8');
  else if (typeof data !== 'string')
    return new Error('Key data must be a Buffer or string');

  var ret = {
    fulltype: undefined,
    type: undefined,
    curve: undefined,
    extra: undefined,
    comment: undefined,
    encryption: undefined,
    private: undefined,
    privateOrig: undefined,
    public: undefined,
    publicOrig: undefined
  };
  var m;
  var i;
  var len;

  data = data.trim().split(/\r\n|\n/);

  while (!data[0].length)
    data.shift();
  while (!data.slice(-1)[0].length)
    data.pop();

  var orig = data.join('\n');

  if ((m = RE_HEADER_OPENSSH_PRIV.exec(data[0]))
      && RE_FOOTER_OPENSSH_PRIV.test(data.slice(-1))) {
    // OpenSSH private key
    var keyType = m[1].toLowerCase();
    if (keyType === 'dsa')
      keyType = 'dss';

    if (keyType === 'ec' && semver.lt(process.version, '5.2.0')) {
      return new Error(
        'EC private keys are not supported in this version of node'
      );
    }

    if (!RE_HEADER_OPENSSH.test(data[1])) {
      // unencrypted, no headers
      var privData = new Buffer(data.slice(1, -1).join(''), 'base64');
      if (keyType !== 'ec') {
        ret.fulltype = 'ssh-' + keyType;
      } else {
        // ECDSA
        var asnReader = new Ber.Reader(privData);
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
              ret.fulltype = 'ecdsa-sha2-nistp256';
              break;
            case '1.3.132.0.34':
              // secp384r1
              ret.fulltype = 'ecdsa-sha2-nistp384';
              break;
            case '1.3.132.0.35':
              // secp521r1
              ret.fulltype = 'ecdsa-sha2-nistp521';
              break;
          }
        }
        if (ret.fulltype === undefined)
          return new Error('Unsupported EC private key type');
      }
      ret.private = privData;
    } else {
      // possibly encrypted, headers
      for (i = 1, len = data.length; i < len; ++i) {
        m = RE_HEADER_OPENSSH.exec(data[i]);
        if (m) {
          m[1] = m[1].toLowerCase();
          if (m[1] === 'dek-info') {
            m[2] = m[2].split(',');
            ret.encryption = m[2][0].toLowerCase();
            if (m[2].length > 1)
              ret.extra = m[2].slice(1);
          }
        } else if (data[i].length)
          break;
      }
      ret.private = new Buffer(data.slice(i, -1).join(''), 'base64');
    }
    ret.type = keyType;
    ret.privateOrig = new Buffer(orig);
  } else if (m = RE_HEADER_OPENSSH_PUB.exec(data[0])) {
    // OpenSSH public key
    ret.fulltype = m[1];
    ret.type = (m[2] || 'ec').toLowerCase();
    ret.public = new Buffer(m[4], 'base64');
    ret.publicOrig = new Buffer(orig);
    ret.comment = m[5];
    if (m[3]) // ECDSA only
      ret.curve = 'nistp' + m[3];
  } else if (RE_HEADER_RFC4716_PUB.test(data[0])
             && RE_FOOTER_RFC4716_PUB.test(data.slice(-1))) {
    if (data[1].indexOf(': ') === -1) {
      // no headers
      ret.public = new Buffer(data.slice(1, -1).join(''), 'base64');
    } else {
      // headers
      for (i = 1, len = data.length; i < len; ++i) {
        if (data[i].indexOf(': ') === -1) {
          if (data[i].length)
            break; // start of key data
          else
            continue; // empty line
        }
        while (data[i].substr(-1) === '\\') {
          if (i + 1 < len) {
            data[i] = data[i].slice(0, -1) + data[i + 1];
            data.splice(i + 1, 1);
            --len;
          } else
            return new Error('RFC4716 public key missing header continuation line');
        }
        m = RE_HEADER_RFC4716.exec(data[i]);
        if (m) {
          m[1] = m[1].toLowerCase();
          if (m[1] === 'comment') {
            ret.comment = m[2] || '';
            if (ret.comment[0] === '"' && ret.comment.substr(-1) === '"')
              ret.comment = ret.comment.slice(1, -1);
          }
        } else
          return new Error('RFC4716 public key invalid header line');
      }
      ret.public = new Buffer(data.slice(i, -1).join(''), 'base64');
    }
    len = ret.public.readUInt32BE(0, true);
    var fulltype = ret.public.toString('ascii', 4, 4 + len);
    ret.fulltype = fulltype;
    if (fulltype === 'ssh-dss')
      ret.type = 'dss';
    else if (fulltype === 'ssh-rsa')
      ret.type = 'rsa';
    else
      return new Error('Unsupported RFC4716 public key type: ' + fulltype);
    ret.public = ret.public.slice(11);
    ret.publicOrig = new Buffer(orig);
  } else if (m = RE_PPK.exec(orig)) {
    // m[1] = short type
    // m[2] = encryption type
    // m[3] = comment
    // m[4] = base64-encoded public key data:
    //         for "ssh-rsa":
    //          string "ssh-rsa"
    //          mpint  e    (public exponent)
    //          mpint  n    (modulus)
    //         for "ssh-dss":
    //          string "ssh-dss"
    //          mpint p     (modulus)
    //          mpint q     (prime)
    //          mpint g     (base number)
    //          mpint y     (public key parameter: g^x mod p)
    // m[5] = base64-encoded private key data:
    //         for "ssh-rsa":
    //          mpint  d    (private exponent)
    //          mpint  p    (prime 1)
    //          mpint  q    (prime 2)
    //          mpint  iqmp ([inverse of q] mod p)
    //         for "ssh-dss":
    //          mpint x     (private key parameter)
    // m[6] = SHA1 HMAC over:
    //          string  name of algorithm ("ssh-dss", "ssh-rsa")
    //          string  encryption type
    //          string  comment
    //          string  public key data
    //          string  private-plaintext (including the final padding)

    // avoid cyclic require by requiring on first use
    if (!utils)
      utils = require('./utils');

    ret.ppk = true;
    ret.type = m[1];
    ret.fulltype = 'ssh-' + m[1];
    if (m[2] !== 'none')
      ret.encryption = m[2];
    ret.comment = m[3];

    ret.public = new Buffer(m[4].replace(/\r?\n/g, ''), 'base64');
    var privateKey = new Buffer(m[5].replace(/\r?\n/g, ''), 'base64');

    ret.privateMAC = m[6].replace(/\r?\n/g, '');

    // automatically verify private key MAC if we don't need to wait for
    // decryption
    if (!ret.encryption) {
      var valid = utils.verifyPPKMAC(ret, undefined, privateKey);
      if (!valid)
        throw new Error('PPK MAC mismatch');
    }

    // generate a PEM encoded version of the public key
    var pubkey = utils.genPublicKey(ret);
    ret.public = pubkey.public;
    ret.publicOrig = pubkey.publicOrig;

    ret.private = privateKey;

    // automatically convert private key data to OpenSSL format (including PEM)
    // if we don't need to wait for decryption
    if (!ret.encryption)
      utils.convertPPKPrivate(ret);
  } else
    return new Error('Unsupported key format');

  return ret;
};
