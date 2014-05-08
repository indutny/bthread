var assert = require('assert');
var bcoin = require('bcoin');
var util = require('util');
var dns = require('dns');
var levelup = require('levelup');
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
  this.pool = new bcoin.pool({
    createConnection: options.createConnection,
    storage: this.db
  });
  this.wallet = {
    owner: null,
    ownerComplete: false,
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
    delta: options.searchDelta || 30 * 3600 * 24,
    delay: options.searchDelay || 1000
  };

  this._init();
}
util.inherits(BThread, EventEmitter);
module.exports = BThread;

BThread.prototype._init = function init() {
  var self = this;

  dns.resolveTxt(this.host, function(err, records) {
    var some = !err && records.some(function(record) {
      return self._parseTXT(record);
    });
    if (!some) {
      self.emit('log', 'The domain does not have a BT record.\n' +
                       'Please enter a passphrase to generate a new one')

      self.firstTX = new Date();
      self.wallet.owner = self.wallet.self;
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
    self.emit('balance', b);
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
  this.wallet.owner = new bcoin.wallet({ pub: pub });

  this.pool.watch(this.wallet.owner.getHash());
  this.pool.watch(this.wallet.owner.getPublicKey());
  this._search();

  return true;
};

BThread.prototype._search = function _search() {
  var range = {
    start: (+this.lastTX / 1000),
    end: (+this.lastTX / 1000) + this.search.delta
  };

  this.emit('log', 'Searching for all transactions since: ' + this.lastTX);

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
        self.wallet.ownerComplete = true;
        self.emit('log', 'Search completed');
        return self.emit('search-end');
      }
      setTimeout(run, self.search.delay);
    });
  }
};

BThread.prototype.post = function post(data, cb) {
  if (!this.wallet.ownerComplete) {
    return this.once('search-end', function() {
      this.post(data, cb);
    });
  }

};
