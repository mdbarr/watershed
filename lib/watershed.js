'use strict';
/*
 * Watershed:
 *   An implementation of RFC6455 (The WebSocket Protocol)
 *
 * Copyright (c) 2017, Joyent, Inc.
 */

const assert = require('assert');
const crypto = require('crypto');
const EventEmitter = require('events');

// Symbolic Constants from RFC-6455
const MAGIC_WEBSOCKET_UUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const NONCE_LENGTH = 16;

const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA,
};

const CLOSECODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNACCEPTABLE: 1003,
  MALFORMED: 1007,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
  MISSING_EXTENSION: 1010,
  UNEXPECTED_ERROR: 1011,
};

// Utilities
function _sha1 (str) {
  const hash = crypto.createHash('sha1');
  hash.update(str);

  return hash.digest('base64');
}

function _generateResponse (wskey, proto) {
  const wsaccept = _sha1(wskey + MAGIC_WEBSOCKET_UUID);
  const lines = [
    'HTTP/1.1 101 The Watershed Moment',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${ wsaccept }`,
  ];
  if (proto !== undefined) {
    lines.push(`Sec-WebSocket-Protocol: ${ proto }`);
  }
  return `${ lines.join('\r\n') }\r\n\r\n`;
}

function _findCloseCode (code) {
  const keys = Object.keys(CLOSECODE);
  for (let i = 0;	i < keys.length; i++) {
    const key = keys[i];
    if (CLOSECODE[key] === code) {
      return key;
    }
  }
  return null;
}

// Watershed Connection
class WatershedConnection extends EventEmitter {
  constructor (options, socket) {
    super();

    this._data = Buffer.alloc(0);
    this._stats = {
      receivedFrames: 0,
      sentFrames: 0,
    };

    // We only want to write at most _one_ CLOSE frame, or 'end' event.
    this._close_written = false;
    this._close_received = false;
    this._end_emitted = false;

    this._close_code = null;
    this._close_reason = null;

    this._options = options;
    this._socket = socket;
    this._remote = options.remote;
    this._local = options.local;

    this._proto = null;
    if (options.protocol) {
      this._proto = options.protocol;
    }

    this._check_for_http_header = true;

    this._keepalive = 0;
    if (options.keepalive) {
      this._keepalive = setInterval(() => {
        this._ws_writePing();
      }, options.keepaliveInterval);
    }

    /*
     * XXX The New Stream interface appears, in v0.10.10, to deliver any
     * data in the buffer (e.g. a banner from the server, etc)
     * _immediately_ when we add our first 'readable' handler, before we
     * have a chance to return from the constructor.  Work around this
     * for now.
     */

    this._outofconstructor = false;

    process.nextTick(() => {
      this._outofconstructor = true;
      this._ws_readFromSocket();
    });

    this._socket.on('readable', () => {
      if (!this._outofconstructor) {
        return;
      }
      this._ws_readFromSocket();
    });

    this._socket.on('end', () => {
      if (this._keepalive) {
        clearInterval(this._keepalive);
      }

      /*
       * If we did not receive a CLOSE frame, then the connection was
       * terminated prematurely.
       */
      if (!this._close_received) {
        this.emit('connectionReset');
      }

      if (this._end_emitted) {
        return;
      }
      this._end_emitted = true;

      this.emit('end', this._close_code, this._close_reason);
    });

    this._socket.on('error', (err) => {
      if (this._keepalive) {
        clearInterval(this._keepalive);
      }

      if (this._end_emitted) {
        return;
      }
      this._end_emitted = true;

      /*
       * Unfortunately, in the case of a write-after-end error there
       * is no error code set. In this case we check that the error
       * message property is equal to the string 'write after end' as
       * it is specified in the node runtime.
       */
      if (err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.message === 'write after end') {
        /*
         * Treat end-of-stream errors as merely an end
         * of stream.  If we received a CLOSE frame, it
         * was a graceful end.  If we did not, it was not.
         */
        if (!this._close_received) {
          this.emit('connectionReset');
        }

        this.emit('end', this._close_code, this._close_reason);
        return;
      }

      this.emit('error', err);
      this.emit('end');
    });
  }

  /*
   * Public: WatershedConnection.getProtocol()
   *
   * Returns the negotiated sub-protocol chosen during accept().
   */
  getProtocol () {
    return this._proto;
  }

  /*
   * Public: WatershedConnection.end(reason)
   *
   * Send a close frame to the remote end of the connection, with an optional
   * reason string.
   */
  end (reason) {
    if (this._close_written) {
      return;
    }
    this._close_written = true;

    this._ws_writeClose(CLOSECODE.NORMAL, reason);
  }

  /*
   * Public: WatershedConnection.destroy()
   *
   * Immediately destroy the underlying socket, without sending a CLOSE
   * frame.
   */
  destroy () {
    if (this._socket !== null) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    if (!this._end_emitted) {
      this.emit('end', this._close_code, this._close_reason);
      this._end_emitted = true;
    }
  }

  /*
   * Public: WatershedConnection.send(string)
   *           ^-- send a TEXT frame with this UTF-8 string
   *         WatershedConnction.send(Buffer)
   *           ^-- send a BINARY frame with this Buffer
   */
  send (data) {
    assert(typeof data === 'string' || Buffer.isBuffer(data));

    if (Buffer.isBuffer(data)) {
      this._ws_writeBinary(data);
    } else {
      this._ws_writeText(data);
    }
  }

  _ws_readFromSocket () {
    // Read and process all frames we have fully received:
    while (!this._end_emitted) {
      if (this._ws_readFrame()) {
        this._stats.receivedFrames++;
      } else {
        break;
      }
    }
  }

  /*
   * Ensure that at least 'len' bytes are contiguous in the data buffer.
   *
   * Return false if there is insufficient data in the chain, otherwise return
   * true.
   */
  _ws_pullup (len) {
    // We already have sufficient data, so do nothing.
    if (this._data.length >= len) {
      return true;
    }

    // Try and read data from the socket:
    const buf = this._socket.read(len !== null ? len - this._data.length : null);
    if (buf === null) {
      return false;
    }

    this._data = Buffer.concat([ this._data, buf ], this._data.length + buf.length);

    return true;
  }

  _ws_writeBinary (buffer) {
    assert(Buffer.isBuffer(buffer));
    this._ws_writeFrameCommon(OPCODE.BINARY, buffer);
  }

  _ws_writeText (text) {
    assert(typeof text === 'string');
    this._ws_writeFrameCommon(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  _ws_writeClose (code, reason) {
    let buf;
    assert(code >= 1000);

    if (reason) {
      assert(typeof reason === 'string');
      buf = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
      buf.write(reason, 2);
    } else {
      buf = Buffer.alloc(2);
    }

    buf.writeUInt16BE(code, 0);
    this._ws_writeFrameCommon(OPCODE.CLOSE, buf);
  }

  _ws_writePing (nonce) {
    this._ws_writeFrameCommon(OPCODE.PING, nonce);
  }

  _ws_writePong (nonce) {
    this._ws_writeFrameCommon(OPCODE.PONG, nonce);
  }

  _ws_writeFrameCommon (opcode, data) {
    let maskbuf = null;
    let hdr;
    const obj = {
      fin: true,
      opcode,
    };

    assert(Buffer.isBuffer(data));

    // According to the RFC, the client MUST mask their outgoing frames.
    if (this._options.localShouldMask) {
      maskbuf = crypto.randomBytes(4);
      for (let j = 0; j < data.length; j++) {
        data[j] = data[j] ^ maskbuf[j % maskbuf.length];
      }
    }

    // Construct the type of payload length we need:
    if (data.length <= 125) {
      hdr = Buffer.alloc(2);
      obj.len0 = data.length;
    } else if (data.length <= 0xffff) {
      hdr = Buffer.alloc(2 + 2);
      obj.len0 = 126;
      hdr.writeUInt16BE(data.length, 2);
    } else if (data.length <= 0xffffffff) {
      hdr = Buffer.alloc(2 + 8);
      obj.len0 = 127;
      hdr.writeUInt32BE(0, 2);
      hdr.writeUInt32BE(data.length, 6);
    } else {
      throw new Error('Frame payload must have length less ' +
        'than 32-bits');
    }

    // Construct the common (first) two bytes of the header:
    let w0 = obj.fin ? 1 << 15 : 0;
    w0 |= obj.opcode << 8 & 0x0f00;
    w0 |= obj.len0 & 0x007f;
    w0 |= maskbuf !== null ? 1 << 7 : 0;
    hdr.writeUInt16BE(w0, 0);

    // Write the data:
    this._socket.write(hdr);

    if (maskbuf !== null) {
      this._socket.write(maskbuf);
    }

    this._socket.write(data);
    this._stats.sentFrames++;
  }

  _ws_readFrame () {
    let pos = 0;

    // Read the common (first) two bytes of the header:
    if (!this._ws_pullup(pos + 2)) {
      return false;
    }

    const w0 = this._data.readUInt16BE(pos);
    pos += 2;

    if (this._check_for_http_header) {
      /*
       * XXX There have been some horrible Streams/HTTP bugs that
       * mean we get to see the HTTP headers on the front of the
       * stream, or at a random point within the stream, even
       * though it _should_ have been eaten by the HTTP parser.
       *
       * This check attempts to detect such malfeasance.
       */
      if (this._data.toString('utf8', 0, 2) === 'HT') {
        throw new Error('POSSIBLE NODE/STREAMS BUG');
      }
    }

    // Break the header bytes out into fields:
    const obj = {
      fin: Boolean(w0 & 1 << 15),
      opcode: (w0 & 0x0f00) >> 8,
      mask: Boolean(w0 & 1 << 7),
      len0: w0 & 0x007f,
      maskbytes: [],
    };

    if (this._options.remoteMustMask && !obj.mask) {
      /*
       * According to the RFC, the client MUST currently mask their
       * frames.
       */
      this._end_emitted = true;
      this.emit('error', new Error('Client did not Mask according to the RFC.'));
      this.emit('end');
      this._socket.end();

      return false;
    }

    // XXX We should handle multi-part messages:
    if (!obj.fin) {
      this.end();
      return false;
    }

    // Determine the payload length; this may be in the common bytes, or in an additional field.
    assert(obj.len0 >= 0 && obj.len0 <= 127);
    if (obj.len0 <= 125) {
      obj.len = obj.len0;
    } else if (obj.len0 === 126) {
      if (!this._ws_pullup(pos + 2)) {
        return false;
      }

      obj.len = this._data.readUInt16BE(pos);
      pos += 2;
    } else { /* obj.len === 127 */
      if (!this._ws_pullup(pos + 4)) {
        return false;
      }

      obj.len = this._data.readUInt32BE(pos);
      pos += 4;

      // XXX We cannot usefully use a 64-bit value, so make sure the upper 32 bits are zero for now.
      if (obj.len !== 0) {
        this._end_emitted = true;
        this.emit('error', new Error('Client tried to send too long a frame.'));
        this.emit('end');
        this._socket.end();

        return false;
      }

      if (!this._ws_pullup(pos + 4)) {
        return false;
      }

      obj.len = this._data.readUInt32BE(pos);
      pos += 4;
    }

    // Read the remote connection's mask key:
    if (obj.mask) {
      if (!this._ws_pullup(pos + 4)) {
        return false;
      }

      for (let i = 0; i < 4; i++) {
        obj.maskbytes.push(this._data.readUInt8(pos));
        pos++;
      }
    }

    // Load the payload:
    if (!this._ws_pullup(pos + obj.len)) {
      return false;
    }
    obj.payload = this._data.slice(pos, pos + obj.len);
    pos += obj.len;

    // If the remote connection masked their payload, unmask it:
    if (obj.mask) {
      for (let k = 0; k < obj.payload.length; k++) {
        obj.payload[k] = obj.payload[k] ^ obj.maskbytes[k % 4];
      }
    }

    if (obj.opcode === OPCODE.CLOSE) {
      this._close_received = true;
    }

    // Emit events for the frame:
    if (obj.opcode === OPCODE.TEXT) {
      const stringOut = obj.payload.toString('utf8');
      this.emit('text', stringOut);
    } else if (obj.opcode === OPCODE.BINARY) {
      this.emit('binary', obj.payload);
    } else if (obj.opcode === OPCODE.PING) {
      this.emit('ping', obj.payload);
      // XXX We should probably let the user do this for themselves:
      this._ws_writePong(obj.payload);
    } else if (obj.opcode === OPCODE.PONG) {
      this.emit('pong', obj.payload);
    } else if (obj.opcode === OPCODE.CLOSE) {
      /*
       * We've received a CLOSE frame, either as a result of a
       * remote-initiated CLOSE, or in response to a CLOSE frame we
       * sent.  In the former case, the RFC dictates that we respond
       * in kind; otherwise close the socket.
       */
      if (obj.payload.length >= 2) {
        this._close_code = _findCloseCode(
          obj.payload.readUInt16BE(0));
        this._close_reason = obj.payload.toString('utf8', 2);
      }
      this.end();
      this._socket.end();
    }

    // Turf this frame out of the front of the chain.
    this._data = this._data.slice(pos);
    return true;
  }
}

// Watershed
class Watershed {
  constructor ({ keepalive = true, keepaliveInterval = 5000 } = {}) {
    this.keepalive = keepalive;
    this.keepaliveInterval = keepaliveInterval;
  }

  /*
   * Public:  Watershed.generateKey()
   *
   * Returns a random, Base64-encoded 16-byte value suitable for use as the
   * Sec-WebSocket-Key header on an Upgrade request.
   */
  generateKey () {
    return crypto.randomBytes(NONCE_LENGTH).toString('base64');
  }

  /*
   * Public:  Watershed.accept(http.ServerRequest, net.Socket, Buffer)
   *
   * Responds to a client's request to Upgrade to WebSockets and returns a
   * WatershedConnection/EventEmitter.  The EventEmitter emits the following
   * events:
   *
   *    'error':  there was an error while handling the connection.
   *    'end':    the WebSocket connection has ended.
   *
   *    'text':   a TEXT frame arrived; (parameter will be a String.)
   *    'binary': a BINARY frame arrived; (parameter will be a Buffer.)
   *    'ping':   a PING frame arrived; (parameter will be a nonce Buffer.)
   *    'pong':   a PONG frame arrived; (parameter will be a nonce Buffer.)
   */
  accept (req, socket, head, detached, protocols) {
    const remote = `${ socket.remoteAddress }:${ socket.remotePort }`;
    const local = `${ socket.localAddress }:${ socket.localPort }`;
    /*
     * Return any potential parse overrun back to the
     * front of the stream:
     */
    if (head && head.length > 0) {
      socket.unshift(head);
    }

    /*
     * Check for the requisite headers in the Upgrade request:
     */
    const upgrade = req.headers.upgrade;
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      throw new Error('Missing Upgrade Header');
    }
    const wskey = req.headers['sec-websocket-key'];
    if (!wskey) {
      throw new Error('Missing Sec-WebSocket-Key Header');
    }
    const wsver = req.headers['sec-websocket-version'];
    if (wsver && wsver !== '13') {
      throw new Error('Unsupported Sec-WebSocket-Version');
    }

    let proto;
    const supported = {};
    const protoHead = req.headers['sec-websocket-protocol'];
    if (protoHead && protocols) {
      protocols.forEach((pr) => {
        supported[pr] = true;
      });

      const protosWanted = protoHead.split(/, */g);

      for (let i = 0; i < protosWanted.length; ++i) {
        if (supported[protosWanted[i]]) {
          proto = protosWanted[i];
          break;
        }
      }

      if (proto === undefined) {
        throw new Error('Client and server have no matching sub-protocols');
      }
    } else if (protoHead) {
      throw new Error('Client requested a sub-protocol but no supported sub-protocols ' +
        'were provided to accept()');
    }

    /*
     * Write the response that lets the client know we've accepted the
     * Upgrade to WebSockets:
     */
    socket.write(_generateResponse(wskey, proto));

    if (detached === true) {
      /*
       * The user just wants the Socket.
       */
      return socket;
    }

    const options = {
      remoteMustMask: true,
      localShouldMask: false,
      type: 'accept',
      remote,
      local,
      protocol: proto,
    };

    return new WatershedConnection(options, socket);
  }

  /*
   * Public:  Watershed.connect(http.ClientResponse, net.Socket, Buffer, String)
   *
   * Attaches a new client-side WatershedConnection to this presently Upgraded
   * socket.  Emits the same events as the object returned by accept().
   */
  connect (res, socket, head, wskey, detached) {
    const remote = `${ socket.remoteAddress }:${ socket.remotePort }`;
    const local = `${ socket.localAddress }:${ socket.localPort }`;

    // Return any potential parse overrun back to the front of the stream:
    if (head && head.length > 0) {
      socket.unshift(head);
    }

    // Check for the requisite headers in the Upgrade response:
    if (res.statusCode !== 101) {
      throw new Error('Invalid Upgrade status code');
    }

    const connection = res.headers.connection;
    if (!connection || connection.toLowerCase() !== 'upgrade') {
      throw new Error('Missing Connection Header');
    }

    const upgrade = res.headers.upgrade;
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      throw new Error('Missing Upgrade Header');
    }

    const wsaccept = res.headers['sec-websocket-accept'];
    if (!wsaccept || wsaccept !== _sha1(wskey + MAGIC_WEBSOCKET_UUID)) {
      throw new Error('Missing Sec-WebSocket-Accept Header');
    }

    const wsver = res.headers['sec-websocket-version'];
    if (wsver && wsver !== '13') {
      throw new Error('Unsupported Sec-WebSocket-Version');
    }
    const proto = res.headers['sec-websocket-protocol'];

    if (detached === true) {
      // The user just wants the Socket.
      return socket;
    }

    const options = {
      keepalive: this.keepalive,
      keepaliveInterval: this.keepaliveInterval,
      local,
      localShouldMask: true,
      protocol: proto,
      remote,
      remoteMustMask: false,
      type: 'connect',
    };

    return new WatershedConnection(options, socket);
  }
}

module.exports = Watershed;
