
// builtin
var net = require('net');
var dgram = require('dgram');
var events = require('events');
var fs = require('fs');
var util = require('util');

// 3rd party
var uuid = require('node-uuid');
var Chain = require('chain');

// common
var Messenger = require('bitfloor/messenger');
var Journal = require('bitfloor/journal');
var logger = require('bitfloor/logger');
var config = require('bitfloor/config');

// local
var OrderBook = require('./lib/order_book').OrderBook;
var Order = require('./lib/order');

var matcher_state_dir = config.env.logdir;
var matcher_state_prefix = matcher_state_dir + "/matcher_state";

function Matcher(product_id, config) {
    this.server;
    this.config = config;
    this.state_num = 0;
    this.output_seq = 0;
    this.product_id = product_id;
    this.order_book = new OrderBook();
}

// matcher emits the 'process' event for testing
// see req_processor.js in lib
Matcher.prototype = new events.EventEmitter();

Matcher.prototype.recover = function(send_feed_msg, cb) {
    var self = this;
    var state_file_prefix = "matcher_state." + self.product_id;
    var journal_filename = config.env.logdir + "/matcher." + self.product_id + ".log";

    Chain.exec(
        function() {
            // get all files in the matcher's state directory
            fs.readdir(matcher_state_dir, Chain.next())
        },
        function(err, files) {
            if (err) {
                logger.error('could not read matcher state dir', err);
                if (cb)
                    cb(err);
            }

            var state_files = [];

            // get the files that match the prefix
            files.forEach(function(file) {
                if(file.indexOf(state_file_prefix) === 0) {
                    var num = file.match(/\.(\d+)\.json/)[1] - 0;
                    state_files.push({file: file, num: num});
                }
            });

            if (!state_files.length) {
                logger.warn('No state files found! Either this is the first time starting the matcher for this product or there is a serious error');
                return cb();
            }

            // get the one with the latest state_num
            state_files.sort(function(a, b) { return b.num - a.num; });
            var state_file = state_files[0].file;

            fs.readFile(matcher_state_dir + "/" + state_file, 'utf8', Chain.next());
        },
        function(err, data) {
            if (err) {
                logger.error('could not read matcher state file', err);
                if (cb)
                    cb(err);
            }

            var state = JSON.parse(data);

            // fill up the order book
            state.bids.forEach(function(order_data) {
                order_data.side = 0;
                var order = Order.parse(order_data);
                logger.trace('adding back ' + util.inspect(order));
                self.order_book.add(order);
            });
            state.asks.forEach(function(order_data) {
                order_data.side = 1;
                var order = Order.parse(order_data);
                logger.trace('adding back ' + util.inspect(order));
                self.order_book.add(order);
            });

            // set the other stateful fields
            self.state_num = state.state_num;
            self.output_seq = state.output_seq;

            // open up the journal file
            fs.readFile(journal_filename, 'utf8', Chain.next());
        },
        function(err, data) {
            if (err) {
                logger.error('could not read matcher journal', err);
                if (cb)
                    cb(err);
            }

            // TODO: slow, do this line-by-line
            var lines = data.split('\n');

            // the state num in the journal (1 smaller than the saved one)
            var journal_state_num = self.state_num - 1;

            var playback = false;
            lines.forEach(function(line) {
                if (line.length) {
                    var data = JSON.parse(line);
                    if (data.type === "state" && data.payload === journal_state_num) {
                        playback = true;
                        return;
                    }

                    if (playback) {
                        logger.trace('playing back ' + util.inspect(data));
                        var handler = self._get_handler(data, send_feed_msg);
                        if (!handler) {
                            logger.warn('no handler for message type ' + data.type);
                            return;
                        }
                        handler(data.payload);
                    }
                }
            });

            // serious error, we have the wrong journal or it's corrupt
            if (!playback) {
                logger.error('Could not find state num in journal ' + journal_state_num);

            }

            if (cb)
                cb();
        }
    );
};


/// returns a handler that affects the matcher's state
/// send_feed_msg is a function that will send a msg out
/// ev is an optional event emitter, events will not be emitted if omitted
Matcher.prototype._get_handler = function(msg, send_feed_msg, ev) {
    var self = this;
    // handlers for messages which will affect the matcher state
    var msg_handlers = {
        'order': function(payload) {
            var order = Order.parse(payload);

            // received order into the matcher
            // this order status is sent to indicate that the order was received
            var payload = {
                status: 'received',
                side: order.side,
                order_id: order.id,
                sender: order.sender,
                price: order.price,
                size: order.size,
                exchange_time: Date.now()
            };
            send_feed_msg('order_status', payload);

            // add the order to the order book
            // if the order can be matched immediately, it will be
            // this should happen after the sends because it may cause fills to be sent
            self.order_book.add(order);

            // for testing only
            self.emit('process');
        },
        'cancel': function(payload) {
            var oid = payload.order_id;
            var sender = payload.sender_id;

            var result = self.order_book.remove(oid, sender);

            // if there was an error, inform the user
            if (result && ev) {
                ev.emit('reply', {
                    type: 'cancel_reject',
                    timestamp: Date.now(),
                    target_id: sender,
                    payload: {
                        order_id: oid,
                        reject_reason: result.message
                    }
                });
            }

            // for testing only
            self.emit('process');
        },
    };

    return msg_handlers[msg.type];
};

/// start the matcher, callback when started
Matcher.prototype.start = function(cb) {
    var self = this;
    logger.trace('starting matcher');

    var client = self.config.client;
    var feed = self.config.feed;

    var order_book = self.order_book;

    // inbound message journal
    var journal = this.journal = new Journal('matcher.' + self.product_id, false);

    // output journal for the matcher
    var journal_out = new Journal('matcher_out.' + self.product_id, false);

    // the multicast feed channel socket
    var feed_socket = this.feed_socket = dgram.createSocket('udp4');

    var ev = new events.EventEmitter();

    // journal & send a message out on the multicast socket
    // updaters and other interested sources listen for this data
    function send_feed_msg(type, payload) {
        // avoid referencing into the feed config object for every message send
        var feed_ip = feed.ip;
        var feed_port = feed.port;

        // construct the message
        var msg = {
            type: type,
            timestamp: Date.now(),
            seq: self.output_seq,
            payload: payload
        };

        // journal the message before sending it
        // it's not necessary to wait for this to finish, since
        // this is just for nightly reconciliation
        // state is persisted by the input journal & state files
        journal_out.log(msg);

        // have to send buffers
        var buff = new Buffer(JSON.stringify(msg));

        // beam me up scotty!
        feed_socket.send(buff, 0, buff.length, feed_port, feed_ip, function(err) {
            if (err)
                logger.warn(err.message);
        });

        ++self.output_seq;
    }

    // writes the state to the state file
    // cb(state) when done
    function write_state(cb) {
        var state_num = self.state_num;
        var filename = matcher_state_prefix + "." + self.product_id + "." + state_num + ".json";
        journal.log({type: 'state', payload: state_num}, function(){
            var state = self.state();

            // save what the state num should be when recovering state via file
            state.state_num = state_num + 1; // TODO: jenky?

            fs.writeFile(filename, JSON.stringify(state));

            cb(state);
        });
        ++self.state_num;
    }

    /// order book event handlers
    order_book
    .on('add_order', function(order) {
        // client has already been notofied that the order is open at the exchange
        // we can't do it here because the order may never be added to the book if it is
        // executed immediately, thus no call to event dist
        // the 'open' order status means that the order is now open on the order book
        var payload = {
            status: 'open',
            side: order.side,
            order_id: order.id,
            sender: order.sender,
            price: order.price,
            size: order.size,
            exchange_time: Date.now()
        };

        send_feed_msg('order_status', payload);
    })
    // taker is the liq. taker, provider is the liq. provider
    .on('match', function(size, taker, provider) {
        var payload = {
            id: uuid('binary').toString('hex'),
            taker_id: taker.id,
            provider_id: provider.id,
            taker_user_id: taker.sender,
            provider_user_id: provider.sender,
            size: size,
            price: provider.price,
            taker_side: taker.side,
            taker_original_limit: taker.price,
            taker_done: taker.done == true, // .done may be undefined
            provider_done: provider.done == true
        };

        send_feed_msg('match', payload);
    })
    .on('remove_order', function(order) {
        var payload = {
            order_id: order.id,
            status: 'done',
            size: order.size, // need for fast cancel (hold amount calc)
            price: order.price, // need for fast cancel (hold amount calc)
            side: order.side, // need for fast cancel (hold amount calc)
            user_id: order.sender, // need for fast cancel (hold amount update)
            reason: (order.done) ? 'filled' : 'cancelled'
        };
        send_feed_msg('order_status', payload);
    });

    /// matcher server setup and connection handling
    var server = this.server = net.createServer();

    function start_server() {
        // write state to file to make recovery cases easier
        write_state(function() {
            server.listen(client.port, client.ip, function() {
                logger.trace('matcher started');
                if (cb)
                    cb();
            });
        });
    }

    if (self.config.no_recover) {
        start_server();
    } else {
        // recover the state before accepting requests
        self.recover(send_feed_msg, start_server);
    }

    server.on('connection', function(socket) {
        var addr = socket.remoteAddress + ":" + socket.remotePort;
        logger.trace('accepted connection from: ' + addr);

        // the outgoing messenger for the client
        var ms = new Messenger(socket);

        function send_reply(obj) {
            ms.send(obj);
        }

        ev.on('reply', send_reply);

        socket.on('close', function() {
            logger.trace('removing send_reply handler for ' + addr);
            ev.removeListener('reply', send_reply);
        });

        ms.addListener('msg', function(msg) {
            logger.trace('got msg: ' + msg.type);

            var handler = self._get_handler(msg, send_feed_msg, ev);

            if (!handler) {
                // state requests don't happen often so only try to handle them
                // if we don't already have a handler for the message type
                // these are special messages not intended for the matcher
                if (msg.type === 'state') {
                    write_state(function(state) {
                        ms.send(state);
                    });
                    return;
                }

                // if we didn't have a handler and it wasn't a sub request
                return logger.warn('no handler for message type: ' + msg.type, msg);
            }

            // wait for journal write before processing request
            // these journaled messages affect the state of the matcher
            journal.log(msg, function() {
                if (!msg.payload)
                    return logger.warn('no payload in message', msg);
                return handler(msg.payload);
            });
        });
    });
};

Matcher.prototype.stop = function(cb) {
    logger.trace('stopping matcher');
    this.order_book.removeAllListeners();
    this.server.close();
    this.server.on('close', function() {
        logger.trace('matcher stopped');
        if (cb)
            cb();
    });

    this.feed_socket.close();
};

Matcher.prototype.state = function() {
    var state = this.order_book.state();
    state.state_num = this.state_num;
    state.output_seq = this.output_seq;
    return state;
};

// resets matcher's state
Matcher.prototype.reset = function() {
    this.output_seq = 0;
    this.state_num = 0;
    this.order_book = new OrderBook();
};

module.exports = Matcher;