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

function failOnMessage (msg) {
  throw new Error(`received unexpected message: ${ msg.toString() }`);
}

function failOnEnd (code) {
  throw new Error(`connection unexpectedly ended: ${ code }`);
}

describe('Watershed Basic Tests', () => {
  it('setup server', (done) => {
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
    return done();
  });

  it('setup client', (done) => {
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
      expect(CLIENT.getProtocol()).toStrictEqual(null);
      expect(SERVER.getProtocol()).toStrictEqual(null);
      CLIENT.on('text', failOnMessage);
      CLIENT.on('binary', failOnMessage);
      CLIENT.on('end', failOnEnd);
      return done();
    });
  });

  it('server pings client', (done) => {
    let pingRecvd = false;

    CLIENT.once('ping', () => {
      pingRecvd = true;
    });

    SERVER.once('pong', () => {
      expect(pingRecvd).toBeTruthy();
      return done();
    });

    SERVER._ws_writePing(Buffer.alloc(0));
  });

  it('client pings server', (done) => {
    let pingRecvd = false;

    SERVER.once('ping', () => {
      pingRecvd = true;
    });

    CLIENT.once('pong', () => {
      expect(pingRecvd).toBeTruthy();
      return done();
    });

    CLIENT._ws_writePing(Buffer.alloc(0));
  });

  it('client sends TEXT', (done) => {
    SERVER.removeListener('text', failOnMessage);
    SERVER.once('text', (txt) => {
      SERVER.on('text', failOnMessage);
      expect(txt).toEqual('hello');
      return done();
    });

    CLIENT.send('hello');
  });

  it('server sends TEXT', (done) => {
    CLIENT.removeListener('text', failOnMessage);
    CLIENT.once('text', (txt) => {
      CLIENT.on('text', failOnMessage);
      expect(txt).toEqual('hello');
      return done();
    });

    SERVER.send('hello');
  });

  it('client sends BINARY', (done) => {
    SERVER.removeListener('binary', failOnMessage);
    SERVER.once('binary', (binary) => {
      SERVER.on('binary', failOnMessage);
      expect(binary instanceof Buffer).toBeTruthy();
      expect(binary.toString('utf-8')).toEqual('hello');
      return done();
    });

    CLIENT.send(Buffer.from('hello'));
  });

  it('server sends BINARY', (done) => {
    CLIENT.removeListener('binary', failOnMessage);
    CLIENT.once('binary', (binary) => {
      CLIENT.on('binary', failOnMessage);
      expect(binary instanceof Buffer).toBeTruthy();
      expect(binary.toString('utf-8')).toEqual('hello');
      return done();
    });

    SERVER.send(Buffer.from('hello'));
  });

  it('teardown connection', (done) => {
    CLIENT.removeListener('end', failOnEnd);
    SERVER.removeListener('end', failOnEnd);

    CLIENT.on('end', (code, reason) => {
      expect(code).toEqual('NORMAL');
      expect(reason).toEqual('test ended');
      return done();
    });

    SERVER.end('test ended');

    CLIENT = null;
    SERVER = null;
  });

  it('negotiate supported subprotocol', (done) => {
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
      expect(client.getProtocol()).toStrictEqual('test1');
      expect(SERVER.getProtocol()).toStrictEqual('test1');

      SERVER.removeListener('end', failOnEnd);
      SERVER.once('end', () => done());
      client.end('done');
    });
  });

  it('negotiation failure', (done) => {
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

    req.on('upgrade', () => {
      throw new Error('Upgrade attempt');
    });

    req.on('response', (res) => {
      expect(res.statusCode).toEqual(400);
      return done();
    });
  });

  it('teardown server', (done) => {
    HTTP.close();
    return done();
  });
});
