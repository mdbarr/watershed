'use strict';
/*
 * Copyright (c) 2017, Joyent, Inc.
 */

const http = require('http');

const Watershed = require('../lib/watershed');
const shed = new Watershed();
const wskey = shed.generateKey();

let CLIENT;
let HTTP;
let SERVER;
let SERVER_ERR;

function failOnMessage (msg) {
  throw new Error(`received unexpected message: ${ msg.toString() }`);
}

function failOnEnd (code, reason) {
  throw new Error(`connection unexpectedly ended: ${ code }`);
}

// --- Tests

test('setup server', (t) => {
  HTTP = http.createServer();
  HTTP.listen(9554);
  HTTP.on('upgrade', (req, socket, head) => {
    try {
      SERVER = shed.accept(req, socket, head, false,
			    [ 'test1', 'test2' ]);
    } catch (err) {
      socket.end('HTTP/1.1 400 Bad Request\r\n' +
			    'Connection: close\r\n\r\n');
      return;
    }
    SERVER.on('text', failOnMessage);
    SERVER.on('binary', failOnMessage);
    SERVER.on('end', failOnEnd);
  });
  t.end();
});

test('setup client', (t) => {
  const options = {
    port: 9554,
    hostname: '127.0.0.1',
    headers: {
      'connection': 'upgrade',
      'upgrade': 'websocket',
      'Sec-WebSocket-Key': wskey,
      'Sec-WebSocket-Version': 13,
    },
  };
  const req = http.request(options);
  req.end();
  req.on('upgrade', (res, socket, head) => {
    socket.setNoDelay(true);
    CLIENT = shed.connect(res, socket, head, wskey);
    t.strictEqual(CLIENT.getProtocol(), null);
    t.strictEqual(SERVER.getProtocol(), null);
    CLIENT.on('text', failOnMessage);
    CLIENT.on('binary', failOnMessage);
    CLIENT.on('end', failOnEnd);
    t.end();
  });
});

test('server pings client', (t) => {
  let pingRecvd = false;

  CLIENT.once('ping', () => {
    pingRecvd = true;
  });

  SERVER.once('pong', () => {
    t.ok(pingRecvd, 'received ping');
    t.end();
  });

  SERVER._ws_writePing(new Buffer(0));
});

test('client pings server', (t) => {
  let pingRecvd = false;

  SERVER.once('ping', () => {
    pingRecvd = true;
  });

  CLIENT.once('pong', () => {
    t.ok(pingRecvd, 'received ping');
    t.end();
  });

  CLIENT._ws_writePing(new Buffer(0));
});

test('client sends TEXT', (t) => {
  SERVER.removeListener('text', failOnMessage);
  SERVER.once('text', (txt) => {
    SERVER.on('text', failOnMessage);
    t.equal(txt, 'hello', 'correct message');
    t.end();
  });

  CLIENT.send('hello');
});

test('server sends TEXT', (t) => {
  CLIENT.removeListener('text', failOnMessage);
  CLIENT.once('text', (txt) => {
    CLIENT.on('text', failOnMessage);
    t.equal(txt, 'hello', 'correct message');
    t.end();
  });

  SERVER.send('hello');
});

test('client sends BINARY', (t) => {
  SERVER.removeListener('binary', failOnMessage);
  SERVER.once('binary', (binary) => {
    SERVER.on('binary', failOnMessage);
    t.ok(binary instanceof Buffer, 'Buffer returned');
    t.equal(binary.toString('utf-8'), 'hello', 'correct message');
    t.end();
  });

  CLIENT.send(new Buffer('hello'));
});

test('server sends BINARY', (t) => {
  CLIENT.removeListener('binary', failOnMessage);
  CLIENT.once('binary', (binary) => {
    CLIENT.on('binary', failOnMessage);
    t.ok(binary instanceof Buffer, 'Buffer returned');
    t.equal(binary.toString('utf-8'), 'hello', 'correct message');
    t.end();
  });

  SERVER.send(new Buffer('hello'));
});

test('teardown connection', (t) => {
  CLIENT.removeListener('end', failOnEnd);
  SERVER.removeListener('end', failOnEnd);

  CLIENT.on('end', (code, reason) => {
    t.equal(code, 'NORMAL', 'normal close');
    t.equal(reason, 'test ended', 'server sent reason');
    t.end();
  });

  SERVER.end('test ended');

  CLIENT = null;
  SERVER = null;
});

test('negotiate supported subprotocol', (t) => {
  const options = {
    port: 9554,
    hostname: '127.0.0.1',
    headers: {
      'connection': 'upgrade',
      'upgrade': 'websocket',
      'Sec-WebSocket-Key': wskey,
      'Sec-WebSocket-Version': 13,
      'Sec-WebSocket-Protocol': 'foobar, test1, test2',
    },
  };
  const req = http.request(options);
  req.end();
  req.on('upgrade', (res, socket, head) => {
    socket.setNoDelay(true);
    const client = shed.connect(res, socket, head, wskey);
    t.strictEqual(client.getProtocol(), 'test1');
    t.strictEqual(SERVER.getProtocol(), 'test1');

    SERVER.removeListener('end', failOnEnd);
    SERVER.once('end', () => {
      t.end();
    });
    client.end('done');
  });
});

test('negotiation failure', (t) => {
  const options = {
    port: 9554,
    hostname: '127.0.0.1',
    headers: {
      'connection': 'upgrade',
      'upgrade': 'websocket',
      'Sec-WebSocket-Key': wskey,
      'Sec-WebSocket-Version': 13,
      'Sec-WebSocket-Protocol': 'foobar, aaaa',
    },
  };
  const req = http.request(options);
  req.end();
  req.on('upgrade', (res, socket, head) => {
    t.fail();
  });
  req.on('response', (res) => {
    t.equal(res.statusCode, 400);
    t.end();
  });
});

test('teardown server', (t) => {
  HTTP.close();
  t.end();
});
