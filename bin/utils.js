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

  for (var i = 0; i < queue.length; i += 2)
    this[queue[i]].apply(this, queue[i + 1]);
};

Logger.prototype.out = function out() {
  var args = Array.prototype.slice.call(arguments);
  if (this.paused > 0) {
    this.queue.push('out', args);
    return;
  }

  console.log.apply(console, args);
};

Logger.prototype._err = function _err(kind, args) {
  args = Array.prototype.slice.call(args);
  if (this.paused > 0) {
    this.queue.push(kind, args);
    return;
  }

  args[0] = '\x1b[' + (kind === 'err' ? 31 : 34) + ';m' + args[0] +
            '\x1b[0;m';
  console.error.apply(console, args);
};

Logger.prototype.info = function info() {
  return this._err('info', arguments);
};

Logger.prototype.err = function err() {
  return this._err('err', arguments);
};
