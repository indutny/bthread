var utils = exports;

function Logger() {
  if (!(this instanceof Logger))
    return new Logger();

  this.paused = 0;
  this.queue = [];
}
utils.logger = Logger;

Logger.prototype.pause = function pause() {
  this.paused++;
};

Logger.prototype.unpause = function unpause() {
  if (--this.paused !== 0)
    return;

  var queue = this.queue;
  this.queue = [];

  for (var i = 0; i < queue.length; i++)
    this.log.apply(this, queue[i]);
};

Logger.prototype.out = function out() {
  if (this.paused > 0) {
    this.queue.push(arguments);
    return;
  }

  console.log.apply(console, arguments);
};

Logger.prototype._err = function _err(kind, args) {
  if (this.paused > 0) {
    this.queue.push(arguments);
    return;
  }

  console.error.apply(console, args);
};

Logger.prototype.info = function info() {
  return this._err('info', arguments);
};

Logger.prototype.err = function err() {
  return this._err('err', arguments);
};
