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

Logger.prototype.log = function log() {
  if (this.paused > 0) {
    this.queue.push(arguments);
    return;
  }

  console.log.apply(console, arguments);
};
