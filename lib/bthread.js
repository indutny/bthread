var assert = require('assert');
var bcoin = require('bcoin');
var inherits = require('inherits');
var levelup = require('levelup');
var bn = require('bn.js');
var pako = require('pako');
var EventEmitter = require('events').EventEmitter;

function BThread(options) {
  if (!(this instanceof BThread))
    return new BThread(options);
  EventEmitter.call(this);

  if (!options)
    options = {};

  this.db = options.db || levelup(options.dbPath, {
    db: options.dbEngine,
    valueEncoding: 'json'
  });
  this.host = options.host;
  this.addr = null;
  this.dust = 5460;
  this.fee = 10000;
  this.balance = new bn(0);
  this.resolveTxt = options.resolveTxt;
  this.pool = options.pool || new bcoin.pool({
    size: options.size,
    createConnection: options.createConnection,
    storage: this.db
  });
  this.loadWaiting = 2;

  this.dbReused = !!options.db;
  this.poolReused = !!options.pool;

  // Owner wallet
  this.loadTs = 0;
  this.wallet = null;

  // Listeners to remove on .destroy();
  this._poolOnTX = null;
  this._poolOnReject = null;
  this._poolOnceFull = null;
  this._poolOnChainProgress = null;
  this.closed = false;

  this._init();
}
inherits(BThread, EventEmitter);
module.exports = BThread;

BThread.prototype._init = function init() {
  var self = this;

  this.resolveTxt(this.host, function(err, records) {
    var some = !err && records.some(function(record) {
      return self._parseTXT(record);
    });
    if (!some) {
      self.emit('log', 'The domain does not have a BT record.');

      self.emit('create-dns', function(pass, cb) {
        self.wallet = new bcoin.wallet({
          storage: self.db,
          scope: self.host,
          passphrase: pass
        });
        self.loadTs = +new Date() / 1000;
        cb('bt=v1 ' + self.wallet.getPublicKey('base58') + ' ' +
                      new Date().toJSON());

        // Start loading
        self.emit('wallet', self.wallet.getAddress());
      });
      return;
    }

    self.emit('wallet', self.wallet.getAddress());
  });

  this.once('wallet', function() {
    // Emit new posts
    self.wallet.on('update', function(tx) {
      var post = self._tx2post(tx);
      if (post)
        self.emit('update', post);
    });

    self.wallet.once('load' ,function(ts) {
      self.emit('log', 'Owner wallet loaded');
    });

    // Load wallet
    self.pool.addWallet(self.wallet, self.loadTs)
             .on('progress', function(c, t) {
                self.emit('search', c, t);
              })
              .once('end', function() {
                if (--self.loadWaiting === 0)
                  self.emit('load');
              });
  });

  this._poolOnTX = function _poolOnTX(tx) {
    self._addTX(tx);
  }
  this.pool.on('tx', this._poolOnTX);

  this._poolOnReject = function _poolOnReject(msg) {
    self.emit('log', 'Transaction rejected %j', msg);
  }
  this.pool.on('reject', this._poolOnReject);

  this._poolOnceFull = function _poolOnceFull() {
    self._poolOnceFull = null;
    if (self._poolOnChainProgress)
      self.pool.removeListener('chain-progress', self._poolOnChainProgress);
    self._poolOnChainProgress = null;

    self.emit('log', 'Blockchain is full and up-to-date');
    if (--self.loadWaiting === 0)
      self.emit('load');
  }
  if (this.pool.isFull()) {
    this._poolOnceFull();
  } else {
    this.pool.once('full', this._poolOnceFull);
    this._poolOnChainProgress = function(percent) {
      self.emit('chain-progress', percent);
    };
    this.pool.on('chain-progress', this._poolOnChainProgress);
  }
};

BThread.prototype._error = function error(msg) {
  if (typeof msg === 'string')
    msg = new Error(msg);
  this.emit('error', msg);
};

BThread.prototype._parseTXT = function _parseTXT(record) {
  // Node.js v0.11 support
  if (Array.isArray(record))
    record = record.join('');

  var self = this;
  var match = record.match(/^bt\s*=\s*v1\s+([\w\d]+)\s+([\w\d\-:\.]+)$/);
  if (match === null)
    return false;

  // Parse public key
  var pub = bcoin.utils.fromBase58(match[1]);
  if (!(pub[0] === 4 && pub.length === 65) &&
      !((pub[0] === 3 || pub[0] === 2) && pub.length === 33)) {
    return false;
  }
  this.loadTs = +new Date(match[2]) / 1000;
  this.wallet = new bcoin.wallet({
    pub: pub,
    storage: this.db
  });

  return true;
};

BThread.prototype._addTX = function _addTX(tx) {
  if (this.wallet)
    this.wallet.addTX(tx);
};

BThread.prototype.isOwner = function isOwner(w) {
  return w.getAddress() === this.wallet.getAddress();
};

BThread.prototype._msgScripts = function _msgScripts(msg) {
  var chunks = [];

  // Conver Uint8Array to Array
  msg = bcoin.utils.toArray(msg);
  var size = new Array(4);
  bcoin.utils.writeU32(size, msg.length, 0);
  msg = size.concat(msg);

  // Split message in 128-byte chunks
  for (var i = 0; i < msg.length; i += 128)
    chunks.push(msg.slice(i, i + 128));

  var owner = this.wallet.getPublicKey();
  var scripts = chunks.map(function(chunk) {
    var subchunks = [];
    // Split chunk in 64-byte subchunks
    for (var i = 0; i < chunk.length; i += 64) {
      subchunks.push(chunk.slice(i, i + 64));
    }

    var keys = subchunks.map(function(subchunk) {
      var key = bcoin.utils.toArray(subchunk);
      var len = key.length < 32 ? 32 : 64;

      // Pad with zeroes
      for (var i = key.length; i < len; i++)
        key.push(0);

      // Add size prefix
      key.unshift(len === 32 ? 0x02 : 0x04);

      return key;
    });

    // 8 for TXOut value, 4 for: varint len, num, num, checkmultisig
    return [ [ 1 ] ].concat(
      keys,
      [ owner, [ keys.length + 1 ], 'checkmultisig' ]
    );
  });

  return scripts;
};

BThread.prototype.post = function post(w, postCost, data, confirm, cb) {
  if (postCost.cmpn(0) !== 0 && postCost.cmpn(this.dust) < 0) {
    return cb(new Error('Post cost should be at least ' + this.dust + ' or ' +
                        'zero'));
  }

  // Reverse replyTo
  var replyTo = data.replyTo;

  // Verify that `replyTo` field is present and that it refers to real TX
  if (!this.isOwner(w)) {
    if (!data.replyTo)
      return cb(new Error('You are not owner, please use replyTo to post'));
  }

  if (data.replyTo) {
    var hasTX = this.wallet.all().some(function(tx) {
      // Partial match
      var m = bcoin.utils.revHex(tx.hash('hex')).indexOf(replyTo) === 0;
      if (!m)
        return false;

      // Reverse hash from user input to normal representation
      data.replyTo = tx.hash('hex');
      return true;
    });
    if (!hasTX)
      return cb(new Error('TX ' + replyTo + ' is unknown'));
  }

  // Compress all data
  data = pako.deflate(JSON.stringify(data), {
    level: 9
  });

  var tx = bcoin.tx();
  var scripts = this._msgScripts(data);

  // Add outputs for each script
  scripts.forEach(function(script, i) {
    tx.out({
      value: new bn(this.dust),
      script: script
    });
  }, this);

  // Additional money to author
  if (postCost.cmpn(0) !== 0)
    tx.out(this.wallet, postCost);

  var self = this;

  // Add enough inputs to cover both outputs and fee
  w.fill(tx, function(e) {
    if (e)
      return cb(e);

    var totalIn = tx.funds('in');
    var totalOut = tx.funds('out');
    var fee = totalIn.sub(totalOut);

    confirm(postCost.add(new bn(self.dust * scripts.length)), fee, onConfirm);
  });

  function onConfirm(yes) {
    var hash = bcoin.utils.revHex(tx.hash('hex'));
    if (!yes)
      return cb(null, false, hash);

    self._addTX(tx);

    self.emit('log', 'Sending TX with id %s', hash);
    self.pool.sendTX(tx).once('ack', function() {
      cb(null, true, hash);
    }).on('ack', function() {
      self.emit('log', 'Got ACK for TX %s', hash);
    });
  }
};

BThread.prototype._tx2post = function _tx2post(tx) {
  var key = this.wallet.getPublicKey();
  var multi = tx.outputs.filter(function(out) {
    return bcoin.script.isMultisig(out.script, key);
  });

  if (multi.length === 0)
    return false;

  // Concat all scripts
  var data = [];
  multi.forEach(function(out) {
    for (var i = 1; i < out.script.length - 3; i++)
      data = data.concat(out.script[i].slice(1));
  });

  // Get length
  var len = bcoin.utils.readU32(data, 0);
  var body = data.slice(4, 4 + len);
  if (body.length === 0 || body.length !== len)
    return false;

  // Inflate body
  try {
    body = JSON.parse(pako.inflate(body, { to: 'string' }));
  } catch (e) {
    return false;
  }
  if (!body.content || typeof body.content !== 'string')
    return false;

  var title = body.content.match(/^(?:# )?\s*(.*)$/m);

  var author;
  if (this.wallet.ownInput(tx)) {
    author = 'owner';
  } else {
    // TODO(indutny): load wallets for TXs with multisig inputs
    var addrs = tx.inputAddrs();
    if (addrs.length === 0)
      author = null;

    // Edge case when the tx pool is incomplete
    else if (addrs[0] === this.wallet.getAddress())
      author = 'owner';
    else
      author = addrs[0];
  }

  return {
    tx: tx,
    author: author,
    hash: bcoin.utils.revHex(tx.hash('hex')),
    ts: tx.ts || +new Date / 1000,
    title: title && title[1],
    content: body.content,
    replyTo: body.replyTo ? bcoin.utils.revHex(body.replyTo) : null,
    replies: []
  };
};

BThread.prototype.list = function list(hash) {
  var all = this.wallet.all().map(function(tx) {
    if (hash && bcoin.utils.revHex(tx.hash('hex')).indexOf(hash) !== 0)
      return false;

    var body = this._tx2post(tx);
    if (!body)
      return false;

    return body;
  }, this).filter(function(post) {
    return post;
  });

  // Exact match required
  if (hash)
    return all[0];

  // Construct reply tree
  var threads = [];
  var map = {};
  var orphans = {};
  all.forEach(function(post) {
    if (post.replyTo) {
      if (map[post.replyTo])
        map[post.replyTo].replies.push(post);
      else if (orphans[post.replyTo])
        orphans[post.replyTo].push(post);
      else
        orphans[post.replyTo] = [ post ];
    } else {
      threads.push(post);
    }

    map[post.hash] = post;

    // Fullfill orphans
    var o = orphans[post.hash];
    if (!o)
      return;
    delete orphans[post.hash];

    o.forEach(function(orphan) {
      post.replies.push(orphan);
    });
  }, this);

  // Sort all replies
  all.forEach(function(post) {
    post.replies.sort(function(a, b) {
      return a.ts - b.ts;
    });
  });

  threads.sort(function(a, b) {
    return b.ts - a.ts;
  });

  return threads;
};

BThread.prototype.close = function close() {
  if (this.closed)
    return;
  this.closed = true;

  if (!this.poolReused)
    this.pool.destroy();
  if (!this.dbReused)
    this.db.close();

  if (this.wallet)
    this.pool.removeWallet(this.wallet);

  // Listeners to remove on .destroy();
  this.pool.removeListener('tx', this._poolOnTX);
  this.pool.removeListener('reject', this._poolOnReject);
  if (this._poolOnceFull)
    this.pool.removeListener('full', this._poolOnceFull);
  if (this._poolOnChainProgress)
    this.pool.removeListener('chain-progress', this._poolOnChainProgress);
  this._poolOnChainProgress = null;
};
