#!/usr/bin/env node
'use strict';

const http = require('http');
const Watershed = require('../../lib/watershed').Watershed;

const shed = new Watershed();

const srv = http.createServer();
srv.listen(9554);
srv.on('upgrade', (req, socket, head) => {
  let wsc;
  try {
    wsc = shed.accept(req, socket, head);
  } catch (ex) {
    console.error(`error: ${ ex.message }`);
    socket.end();
    return;
  }
  wsc.on('text', (text) => {
    console.log(`received text: ${ text }`);
  });
  wsc.on('end', (code, reason) => {
    console.log('end! (%s: %s)', code, reason);
  });
  wsc.send('hi from the server');
});
