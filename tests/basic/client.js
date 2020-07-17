#!/usr/bin/env node
/*
 * Copyright 2016 Joyent, Inc.
 */

const http = require('http');
const Watershed = require('../../lib/watershed').Watershed;

const shed = new Watershed();
const wskey = shed.generateKey();
const options = {
  port: 9554,
  hostname: '127.0.0.1',
  headers: {
    'connection': 'upgrade',
    'upgrade': 'websocket',
    'Sec-WebSocket-Key': wskey,
  },
};
const req = http.request(options);
req.end();
req.on('upgrade', (res, socket, head) => {
  socket.setNoDelay(true);
  const wsc = shed.connect(res, socket, head, wskey);
  wsc.on('text', (text) => {
    console.log('received text: %s', text);
    wsc.end('thank you and good night');
  });
  wsc.on('end', (code, reason) => {
    console.log('end! (%s: %s)', code, reason ? reason : '<null>');
  });
  wsc.send('Hi there!');
});
