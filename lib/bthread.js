var assert = require('assert');
var bcoin = require('bcoin');
var util = require('util');
var levelup = require('levelup');
var bn = require('bn.js');
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
  this.lastTX = null;
  this.dust = 5460;
  this.fee = 10000;
  this.postCost = new bn(Math.max(options.postCost || 0, this.dust));
  this.balance = new bn(0);
  this.resolveTxt = options.resolveTxt;
  this.pool = new bcoin.pool({
    createConnection: options.createConnection,
    storage: this.db
  });
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
    startTs: new Date / 1000 - 1 * 24 * 3600,
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
  this.lastTX = new Date(match[2]);
  this.wallet.owner = new bcoin.wallet({
    pub: pub,
    storage: this.db
  });

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

        return self.emit('search-end');
      }
      setTimeout(run, self.search.delay);
    });
  }
};

BThread.prototype._msgScripts = function _msgScripts(msg) {
  var chunks = [];
  // Split message in 128-byte chunks
  for (var i = 0; i < msg.length; i += 128) {
    chunks.push(msg.slice(i, i + 128));
  }

  var owner = this.wallet.owner.getPublicKey();
  var size = 0;
  var scripts = chunks.map(function(chunk) {
    var subchunks = [];
    // Split chunk in 64-byte subchunks
    for (var i = 0; i < msg.length; i += 64) {
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
      size += key.length;

      return key;
    });

    size += 3 + owner.length;
    return [ [ 1 ] ].concat(
      keys,
      [ owner, [ keys.length + 1 ], 'checkmultisig' ]
    );
  });

  return {
    byteSize: size,
    list: scripts
  };
};

BThread.prototype.post = function post(data, cb) {
  if (!this.search.complete) {
    return this.once('search-end', function() {
      this.post(data, cb);
    });
  }

  var tx = bcoin.tx();
  var scripts = this._msgScripts(data + '');

  // Estimate fee
  var byteSize = scripts.byteSize;
  var fee = Math.ceil(scripts.byteSize / 1024);
  var postCost = this.postCost.add(
    new bn((scripts.list.length - 1) * this.dust));
  var totalCost = postCost.add(new bn(fee * this.fee));
  var isOwner = this.wallet.self === this.wallet.owner;

  // Transfer `postCost` funds maximum, or all if is the owner of thread
  this.wallet.self.unspent().every(function(unspent) {
    // Approximate input size
    byteSize += 75;

    // And update fee accordingly
    var newFee = Math.ceil(scripts.byteSize) / 1024;
    if (newFee > fee) {
      totalCost.iadd((newFee - fee) * this.fee);
      fee = newFee;
    }

    // Add new inputs until TX will have enough funds to cover both
    // minimum post cost and fee
    tx.input(unspent);
    return isOwner || tx.funds.cmp(totalCost) < 0;
  }, this);

  // Failed to get enough funds, notify caller
  if (tx.funds.cmp(totalCost) < 0) {
    var err = new Error('Not enough funds');
    err.minBalance = totalCost;
    return cb(err);
  }

  var out = tx.funds.sub(new bn(fee * this.fee));
  var left;
  if (isOwner) {
    // Transfer all funds if owner
    left = new bn(0);
  } else {
    // Transfer only `postCost` funds when commenting
    left = out.sub(postCost);
    out = postCost;

    // Not enough money, transfer everything to owner
    if (left.cmpn(this.dust) < 0) {
      out = out.iadd(left);
      left = new bn(0);
    }
  }

  scripts.list.forEach(function(script, i) {
    tx.out({
      value: i === 0 ? this.postCost : this.dust,
      script: script
    });
  }, this);

  if (left.cmpn(0) !== 0)
    tx.out(this.wallet.self, left);

  this.wallet.self.sign(tx);
  console.log(tx);
};
