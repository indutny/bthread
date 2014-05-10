var assert = require('assert');
var bcoin = require('bcoin');
var util = require('util');
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

  this.db = levelup(options.dbPath, {
    db: options.db,
    valueEncoding: 'json'
  });
  this.host = options.host;
  this.addr = null;
  this.dust = 5460;
  this.fee = 10000;
  this.balance = new bn(0);
  this.resolveTxt = options.resolveTxt;
  this.pool = new bcoin.pool({
    createConnection: options.createConnection,
    storage: this.db
  });
  this.isOwner = false;
  this.wallet = {
    owner: null,
    self: new bcoin.wallet({
      scope: this.host,
      passphrase: options.passphrase,
      storage: this.db
    })
  };
  this.pool.watch(this.wallet.self.getHash());
  this.pool.watch(this.wallet.self.getPublicKey());

  // 3 days delta
  this.search = {
    waiting: 2,
    complete: false,
    fallbackTs: 0,
    startTs: Infinity,
    delta: options.searchDelta || 30 * 3600 * 24,
    delay: options.searchDelay || 1000
  };

  this._init();
}
util.inherits(BThread, EventEmitter);
module.exports = BThread;

BThread.prototype._init = function init() {
  var self = this;

  this.resolveTxt(this.host, function(err, records) {
    var some = !err && records.some(function(record) {
      return self._parseTXT(record);
    });
    if (!some) {
      self.emit('log', 'The domain does not have a BT record.\n' +
                       'Please enter a passphrase to generate a new one')

      self.firstTX = new Date();
      self.wallet.owner = self.wallet.self;
      self.search.fallbackTs = +new Date / 1000;
      self.isOwner = true;
      self._onWalletLoad(0, 'owner');
      self.emit('dns-record',
                'bt=v1 ' + self.wallet.owner.getPublicKey('base58') + ' ' +
                    self.firstTX.toJSON());
    }
    self.emit('wallet', self.wallet.owner.getAddress(), 'owner');
  });

  this.pool.on('tx', function(tx) {
    self.wallet.self.addTX(tx);
    self.wallet.owner.addTX(tx);
  });

  setTimeout(function() {
    self.emit('wallet', self.wallet.self.getAddress(), 'self');
  }, 0);

  this.wallet.self.on('balance', function(b) {
    self.balance = b;
    self.emit('balance');
  });

  this.wallet.self.once('load', function(ts) {
    self.emit('log', 'Your wallet loaded');
    self._onWalletLoad(ts, 'self');
  });

  this.pool.on('reject', function(msg) {
    self.emit('log', 'Transaction rejected %j', msg);
  });

  this.pool.once('full', function() {
    self.emit('log', 'Blockchain is full and up-to-date');
    self.emit('full');
  });
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
  this.search.fallbackTs = +new Date(match[2]) / 1000;
  this.wallet.owner = new bcoin.wallet({
    pub: pub,
    storage: this.db
  });
  self.isOwner = this.wallet.owner.getAddress() ===
      this.wallet.self.getAddress();

  this.wallet.owner.once('load' ,function(ts) {
    self.emit('log', 'Owner wallet loaded');
    self._onWalletLoad(ts, 'owner');
  });

  this.pool.watch(this.wallet.owner.getHash());
  this.pool.watch(this.wallet.owner.getPublicKey());

  return true;
};

BThread.prototype._onWalletLoad = function _onWalletLoad(ts, kind) {
  if (ts !== 0)
    this.search.startTs = Math.min(this.search.startTs, ts);
  if (--this.search.waiting !== 0)
    return;

  this._search();
};

BThread.prototype._search = function _search() {
  var ts = this.search.startTs;
  if (ts === Infinity)
    ts = this.search.fallbackTs;
  var range = {
    start: ts,
    end: ts + this.search.delta
  };

  this.emit('log',
            'Searching for all transactions since: %s',
            new Date(ts * 1000));

  var self = this;
  run();
  function run() {
    var s = self.pool.search(range);
    s.on('progress', function(a, b) {
      self.emit('search', range, a, b);
    });
    s.on('end', function() {
      range.start = range.end;
      range.end += self.search.delta;
      if (range.end >= +new Date / 1000) {
        self.search.complete = true;
        self.emit('log', 'Search completed');

        // Relay pending TXs
        // NOTE: It is important to do it after search, because search could
        // add TS to pending TXs, thus making them confirmed
        self.wallet.self.pending().forEach(function(tx) {
          var hash = bcoin.utils.revHex(tx.hash('hex'));
          self.emit('log', 'Sending pending TX: %s', hash);
          self.pool.sendTX(tx).on('ack', function() {
            self.emit('log', 'Got ACK for TX %s', hash);
          });
        });

        return self.emit('search-end');
      }
      setTimeout(run, self.search.delay);
    });
  }
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

  var owner = this.wallet.owner.getPublicKey();
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

BThread.prototype.post = function post(postCost, data, confirm, cb) {
  if (!this.search.complete) {
    return this.once('search-end', function() {
      this.post(data, cb);
    });
  }

  if (postCost.cmpn(0) !== 0 && postCost.cmpn(this.dust) < 0) {
    return cb(new Error('Post cost should be at least ' + this.dust + ' or ' +
                        'zero'));
  }

  // Verify that `replyTo` field is present and that it refers to real TX
  if (!this.isOwner) {
    if (!data.replyTo)
      return cb(new Error('You are not owner, please use replyTo to post'));

    if (!/^[a-f0-9]{64}$/.test(data.replyTo)) {
      return cb(new Error('replyTo invalid, ' +
                          'should be a 32 byte hex-encoded lowercase hash'));
    }

    // Reverse user input
    var replyTo = data.replyTo;
    data.replyTo = bcoin.utils.revHex(data.replyTo);
    var hasTX = this.wallet.owner.all().some(function(tx) {
      return tx.hash('hex') === data.replyTo;
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

  // Dust needs to be transferred for each additional output
  var cost = postCost.add(new bn(scripts.length * this.dust));

  // Use initial fee for starters
  var fee = 1;

  // total = cost + fee
  var total = cost.add(new bn(this.fee));

  var lastAdded = -1;
  function addInput(unspent, i) {
    // Add new inputs until TX will have enough funds to cover both
    // minimum post cost and fee
    tx.input(unspent);
    lastAdded = i;
    return tx.funds.cmp(total) < 0;
  }

  // Transfer `total` funds maximum
  var unspent = this.wallet.self.unspent();
  unspent.every(addInput, this);

  // Add outputs

  // Add outputs for each script
  scripts.forEach(function(script, i) {
    tx.out({
      value: new bn(this.dust),
      script: script
    });
  }, this);

  // Additional money to author
  if (postCost.cmpn(0) !== 0)
    tx.out(this.wallet.owner, postCost);

  // Add dummy output (for `left`) to calculate maximum TX size
  tx.out(this.wallet.self, new bn(0));

  // Change fee value if it is more than 1024 bytes
  // (10000 satoshi for every 1024 bytes)
  do {
    // Calculate maximum possible size after signing
    var byteSize = tx.maxSize();

    var addFee = Math.ceil(byteSize / 1024) - fee;
    total.iadd(new bn(addFee * this.fee));
    fee += addFee;

    // Failed to get enough funds, add more inputs
    if (tx.funds.cmp(total) < 0)
      unspent.slice(lastAdded + 1).every(addInput, this);

    // Still failing to get enough funds, notify caller
    if (tx.funds.cmp(total) < 0) {
      var err = new Error('Not enough funds');
      err.minBalance = total;
      return cb(err);
    }
  } while (tx.funds.cmp(total) < 0);

  // How much money is left after sending outputs
  var left = tx.funds.sub(total);

  // Not enough money, transfer everything to owner
  if (left.cmpn(this.dust) < 0) {
    // NOTE: that this output is either `postCost` or one of the `dust` values
    tx.outputs[tx.outputs.length - 2].value.iadd(left);
    left = new bn(0);
  }

  // Change or remove last output if there is some money left
  if (left.cmpn(0) === 0)
    tx.outputs.pop();
  else
    tx.outputs[tx.outputs.length - 1].value = left;

  var self = this;
  this.wallet.self.sign(tx);

  fee = new bn(fee * this.fee);
  confirm(total.sub(fee), fee, function(yes) {
    if (!yes)
      return cb(null, false, tx);

    self.wallet.self.addTX(tx);
    self.wallet.owner.addTX(tx);

    var hash = bcoin.utils.revHex(tx.hash('hex'));
    self.emit('log', 'Sending TX with id %s', hash);
    self.pool.sendTX(tx).once('ack', function() {
      cb(null, true, hash);
    }).on('ack', function() {
      self.emit('log', 'Got ACK for TX %s', hash);
    });
  });
};

BThread.prototype._tx2post = function _tx2post(tx) {
  var key = this.wallet.owner.getPublicKey();
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

  var title = body.content.match(/^# (.*)$/m);

  var author;
  if (this.wallet.owner.ownInput(tx)) {
    author = 'owner';
  } else {
    // TODO(indutny): load wallets for TXs with multisig inputs
    var addrs = tx.inputAddrs();
    if (addrs.length === 0)
      author = 'unknown';
    else
      author = addrs[0];
  }

  return {
    tx: tx,
    author: author,
    hash: bcoin.utils.revHex(tx.hash('hex')),
    ts: tx.ts || +new Date / 1000,
    title: title && title[1] || 'Untitled',
    content: body.content,
    replyTo: body.replyTo ? bcoin.utils.revHex(body.replyTo) : null,
    replies: []
  };
};

BThread.prototype.list = function list(hash) {
  var rhash = bcoin.utils.revHex(hash)
  var all = this.wallet.owner.all().map(function(tx) {
    if (hash && tx.hash('hex').indexOf(rhash) !== 0)
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
  this.pool.destroy();
  this.db.close();
};
