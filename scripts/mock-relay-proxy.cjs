const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SUPPORTED_HANG_MODES = new Set(['none', 'handshake', 'responses']);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function readInteger(value, name, fallback, { minimum = 0, maximum = 65_535 } = {}) {
  const selectedValue = firstDefined(value, fallback);
  const parsedValue = Number(selectedValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  return parsedValue;
}

function readBoolean(value, name, fallback = false) {
  const selectedValue = firstDefined(value, fallback);
  if (typeof selectedValue === 'boolean') {
    return selectedValue;
  }

  const normalizedValue = String(selectedValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

function readHangMode(value) {
  const hangMode = String(firstDefined(value, 'none')).trim().toLowerCase();
  if (!SUPPORTED_HANG_MODES.has(hangMode)) {
    throw new Error('MOCK_RELAY_HANG_MODE must be one of: none, handshake, responses.');
  }

  return hangMode;
}

function readTargetUrl(value) {
  const targetUrl = new URL(String(firstDefined(value, 'ws://127.0.0.1:7000')));
  if (!['ws:', 'wss:'].includes(targetUrl.protocol)) {
    throw new Error('MOCK_RELAY_TARGET_URL must use ws:// or wss://.');
  }

  return targetUrl.toString();
}

function resolveMockRelayConfig(overrides = {}, environment = process.env) {
  const sharedDelayMs = readInteger(
    firstDefined(overrides.delayMs, environment.MOCK_RELAY_DELAY_MS),
    'MOCK_RELAY_DELAY_MS',
    0,
    { maximum: 3_600_000 }
  );
  const readDelay = (overrideValue, environmentName) =>
    readInteger(
      firstDefined(overrideValue, environment[environmentName]),
      environmentName,
      sharedDelayMs,
      { maximum: 3_600_000 }
    );

  return {
    listenHost: String(
      firstDefined(overrides.listenHost, environment.MOCK_RELAY_LISTEN_HOST, '127.0.0.1')
    ).trim(),
    listenPort: readInteger(
      firstDefined(overrides.listenPort, environment.MOCK_RELAY_PORT),
      'MOCK_RELAY_PORT',
      7002,
      { minimum: 1 }
    ),
    targetUrl: readTargetUrl(
      firstDefined(overrides.targetUrl, environment.MOCK_RELAY_TARGET_URL)
    ),
    handshakeDelayMs: readDelay(
      overrides.handshakeDelayMs,
      'MOCK_RELAY_HANDSHAKE_DELAY_MS'
    ),
    requestDelayMs: readDelay(overrides.requestDelayMs, 'MOCK_RELAY_REQUEST_DELAY_MS'),
    ackDelayMs: readDelay(overrides.ackDelayMs, 'MOCK_RELAY_ACK_DELAY_MS'),
    eventDelayMs: readDelay(overrides.eventDelayMs, 'MOCK_RELAY_EVENT_DELAY_MS'),
    eoseDelayMs: readDelay(overrides.eoseDelayMs, 'MOCK_RELAY_EOSE_DELAY_MS'),
    otherDelayMs: readDelay(overrides.otherDelayMs, 'MOCK_RELAY_OTHER_DELAY_MS'),
    jitterMs: readInteger(
      firstDefined(overrides.jitterMs, environment.MOCK_RELAY_JITTER_MS),
      'MOCK_RELAY_JITTER_MS',
      0,
      { maximum: 3_600_000 }
    ),
    dropAcks: readBoolean(
      firstDefined(overrides.dropAcks, environment.MOCK_RELAY_DROP_ACKS),
      'MOCK_RELAY_DROP_ACKS'
    ),
    dropEvents: readBoolean(
      firstDefined(overrides.dropEvents, environment.MOCK_RELAY_DROP_EVENTS),
      'MOCK_RELAY_DROP_EVENTS'
    ),
    dropEose: readBoolean(
      firstDefined(overrides.dropEose, environment.MOCK_RELAY_DROP_EOSE),
      'MOCK_RELAY_DROP_EOSE'
    ),
    hangMode: readHangMode(firstDefined(overrides.hangMode, environment.MOCK_RELAY_HANG_MODE)),
    verbose: readBoolean(
      firstDefined(overrides.verbose, environment.MOCK_RELAY_VERBOSE),
      'MOCK_RELAY_VERBOSE'
    ),
  };
}

function classifyRelayMessage(message) {
  if (typeof message !== 'string') {
    return 'other';
  }

  try {
    const parsedMessage = JSON.parse(message);
    if (!Array.isArray(parsedMessage)) {
      return 'other';
    }

    switch (parsedMessage[0]) {
      case 'OK':
        return 'ack';
      case 'EVENT':
        return 'event';
      case 'EOSE':
        return 'eose';
      default:
        return 'other';
    }
  } catch {
    return 'other';
  }
}

function calculateDelayMs(baseDelayMs, jitterMs, random = Math.random) {
  if (jitterMs <= 0) {
    return baseDelayMs;
  }

  return baseDelayMs + Math.floor(Math.max(0, Math.min(0.999_999_999, random())) * (jitterMs + 1));
}

function resolveRelayResponseBehavior(message, config, random = Math.random) {
  const messageType = classifyRelayMessage(message);
  const shouldDrop =
    config.hangMode === 'responses' ||
    (messageType === 'ack' && config.dropAcks) ||
    (messageType === 'event' && config.dropEvents) ||
    (messageType === 'eose' && config.dropEose);
  const delayByMessageType = {
    ack: config.ackDelayMs,
    event: config.eventDelayMs,
    eose: config.eoseDelayMs,
    other: config.otherDelayMs,
  };

  return {
    delayMs: calculateDelayMs(delayByMessageType[messageType], config.jitterMs, random),
    messageType,
    shouldDrop,
  };
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (payloadBuffer.length <= 125) {
    header = Buffer.from([0x80 | opcode, payloadBuffer.length]);
  } else if (payloadBuffer.length <= 65_535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

function normalizeWebSocketCloseCode(code) {
  if (
    code >= 1000 &&
    code <= 4999 &&
    ![1004, 1005, 1006, 1015].includes(code)
  ) {
    return code;
  }

  return 1011;
}

function createClientFrameDecoder(handlers) {
  let bufferedData = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragmentedPayloads = [];
  let fragmentedPayloadBytes = 0;

  const failProtocol = (message) => {
    handlers.onProtocolError(message);
    bufferedData = Buffer.alloc(0);
  };

  const emitDataFrame = (opcode, payload) => {
    if (opcode === 0x1) {
      handlers.onText(payload.toString('utf8'));
      return;
    }
    if (opcode === 0x2) {
      handlers.onBinary(payload);
    }
  };

  return function decodeClientFrames(chunk) {
    bufferedData = Buffer.concat([bufferedData, chunk]);

    while (bufferedData.length >= 2) {
      const firstByte = bufferedData[0];
      const secondByte = bufferedData[1];
      const isFinal = (firstByte & 0x80) !== 0;
      const reservedBits = firstByte & 0x70;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let headerLength = 2;

      if (reservedBits !== 0) {
        failProtocol('Unsupported WebSocket extension bits.');
        return;
      }
      if (!isMasked) {
        failProtocol('Client WebSocket frames must be masked.');
        return;
      }

      if (payloadLength === 126) {
        if (bufferedData.length < 4) {
          return;
        }
        payloadLength = bufferedData.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (bufferedData.length < 10) {
          return;
        }
        const longPayloadLength = bufferedData.readBigUInt64BE(2);
        if (longPayloadLength > BigInt(DEFAULT_MAX_FRAME_BYTES)) {
          failProtocol('WebSocket frame is too large.');
          return;
        }
        payloadLength = Number(longPayloadLength);
        headerLength = 10;
      }

      if (payloadLength > DEFAULT_MAX_FRAME_BYTES) {
        failProtocol('WebSocket frame is too large.');
        return;
      }

      const isControlFrame = opcode >= 0x8;
      if (isControlFrame && (!isFinal || payloadLength > 125)) {
        failProtocol('Invalid fragmented WebSocket control frame.');
        return;
      }

      const frameLength = headerLength + 4 + payloadLength;
      if (bufferedData.length < frameLength) {
        return;
      }

      const maskingKey = bufferedData.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(
        bufferedData.subarray(headerLength + 4, headerLength + 4 + payloadLength)
      );
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskingKey[index % 4];
      }
      bufferedData = bufferedData.subarray(frameLength);

      if (opcode === 0x8) {
        handlers.onClose(payload);
        continue;
      }
      if (opcode === 0x9) {
        handlers.onPing(payload);
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }
      if (![0x0, 0x1, 0x2].includes(opcode)) {
        failProtocol(`Unsupported WebSocket opcode ${opcode}.`);
        return;
      }

      if (opcode === 0x0) {
        if (fragmentedOpcode === null) {
          failProtocol('Unexpected WebSocket continuation frame.');
          return;
        }
        fragmentedPayloads.push(payload);
        fragmentedPayloadBytes += payload.length;
        if (fragmentedPayloadBytes > DEFAULT_MAX_FRAME_BYTES) {
          failProtocol('Fragmented WebSocket message is too large.');
          return;
        }
        if (isFinal) {
          emitDataFrame(fragmentedOpcode, Buffer.concat(fragmentedPayloads));
          fragmentedOpcode = null;
          fragmentedPayloads = [];
          fragmentedPayloadBytes = 0;
        }
        continue;
      }

      if (fragmentedOpcode !== null) {
        failProtocol('Received a new WebSocket message before continuation completed.');
        return;
      }
      if (isFinal) {
        emitDataFrame(opcode, payload);
        continue;
      }

      fragmentedOpcode = opcode;
      fragmentedPayloads = [payload];
      fragmentedPayloadBytes = payload.length;
    }
  };
}

function toHttpTargetUrl(targetUrl) {
  const httpTargetUrl = new URL(targetUrl);
  httpTargetUrl.protocol = httpTargetUrl.protocol === 'wss:' ? 'https:' : 'http:';
  return httpTargetUrl;
}

function createLogger(logger) {
  return {
    error: logger?.error?.bind(logger) ?? console.error.bind(console),
    info: logger?.info?.bind(logger) ?? console.log.bind(console),
    warn: logger?.warn?.bind(logger) ?? console.warn.bind(console),
  };
}

async function startMockRelayProxy(options = {}) {
  if (typeof WebSocket !== 'function') {
    throw new Error('The mock relay requires Node.js with the built-in WebSocket client.');
  }

  const config = resolveMockRelayConfig(options, options.environment ?? process.env);
  const logger = createLogger(options.logger);
  const targetHttpUrl = toHttpTargetUrl(config.targetUrl);
  const random = options.random ?? Math.random;
  const sessions = new Set();
  const pendingTimeouts = new Set();
  let acceptedConnectionCount = 0;
  let isClosing = false;

  const schedule = (callback, baseDelayMs) => {
    const delayMs = calculateDelayMs(baseDelayMs, config.jitterMs, random);
    if (delayMs === 0) {
      callback();
      return null;
    }

    const timeoutId = setTimeout(() => {
      pendingTimeouts.delete(timeoutId);
      callback();
    }, delayMs);
    pendingTimeouts.add(timeoutId);
    return timeoutId;
  };

  const server = http.createServer((request, response) => {
    if (request.url === '/__mock-relay') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(`${JSON.stringify({ ...config, connectionCount: acceptedConnectionCount }, null, 2)}\n`);
      return;
    }

    const upstreamUrl = new URL(request.url ?? '/', targetHttpUrl);
    const requestClient = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamRequest = requestClient.request(
      upstreamUrl,
      {
        headers: {
          ...request.headers,
          host: upstreamUrl.host,
        },
        method: request.method,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
    upstreamRequest.on('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(`Mock relay upstream request failed: ${error.message}`);
    });
    request.pipe(upstreamRequest);
  });

  server.on('upgrade', (request, clientSocket, initialData) => {
    acceptedConnectionCount += 1;
    clientSocket.pause();
    clientSocket.setNoDelay(true);

    const session = {
      clientSocket,
      isClientClosed: false,
      pendingRequests: [],
      upstream: null,
    };
    sessions.add(session);

    const closeSession = ({ destroyClient = true } = {}) => {
      if (session.isClientClosed) {
        return;
      }
      session.isClientClosed = true;
      sessions.delete(session);
      if (destroyClient) {
        clientSocket.destroy();
      }
      const upstream = session.upstream;
      if (upstream && [WebSocket.CONNECTING, WebSocket.OPEN].includes(upstream.readyState)) {
        upstream.close();
      }
    };

    clientSocket.on('error', () => closeSession());
    clientSocket.on('close', () => closeSession());

    if (config.hangMode === 'handshake') {
      if (config.verbose) {
        logger.info('[mock-relay] holding WebSocket handshake open');
      }
      return;
    }

    schedule(() => {
      if (isClosing || session.isClientClosed) {
        return;
      }

      const websocketKey = request.headers['sec-websocket-key'];
      if (typeof websocketKey !== 'string') {
        closeSession();
        return;
      }

      const acceptValue = crypto
        .createHash('sha1')
        .update(`${websocketKey}${WEBSOCKET_GUID}`)
        .digest('base64');
      clientSocket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptValue}`,
          '\r\n',
        ].join('\r\n')
      );

      const upstream = new WebSocket(config.targetUrl);
      session.upstream = upstream;

      const sendUpstream = (data) => {
        if (session.isClientClosed) {
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
          return;
        }
        if (upstream.readyState === WebSocket.CONNECTING) {
          session.pendingRequests.push(data);
        }
      };

      const forwardClientData = (data) => {
        schedule(() => sendUpstream(data), config.requestDelayMs);
      };

      const decoder = createClientFrameDecoder({
        onBinary: (payload) => forwardClientData(payload),
        onClose: (payload) => {
          if (!clientSocket.destroyed) {
            clientSocket.end(encodeWebSocketFrame(0x8, payload));
          }
          closeSession({ destroyClient: false });
        },
        onPing: (payload) => {
          if (!clientSocket.destroyed) {
            clientSocket.write(encodeWebSocketFrame(0x0a, payload));
          }
        },
        onProtocolError: (message) => {
          logger.warn(`[mock-relay] closing invalid downstream WebSocket: ${message}`);
          if (!clientSocket.destroyed) {
            const reason = Buffer.from(message).subarray(0, 123);
            const closePayload = Buffer.alloc(2 + reason.length);
            closePayload.writeUInt16BE(1002, 0);
            reason.copy(closePayload, 2);
            clientSocket.end(encodeWebSocketFrame(0x8, closePayload));
          }
          closeSession({ destroyClient: false });
        },
        onText: (message) => forwardClientData(message),
      });

      clientSocket.on('data', decoder);
      if (initialData.length > 0) {
        decoder(initialData);
      }
      clientSocket.resume();

      upstream.addEventListener('open', () => {
        const pendingRequests = session.pendingRequests.splice(0);
        pendingRequests.forEach((message) => upstream.send(message));
      });
      upstream.addEventListener('message', (event) => {
        if (session.isClientClosed || clientSocket.destroyed) {
          return;
        }

        const isTextMessage = typeof event.data === 'string';
        const payload = isTextMessage
          ? event.data
          : Buffer.from(
              event.data instanceof ArrayBuffer
                ? event.data
                : ArrayBuffer.isView(event.data)
                  ? event.data.buffer.slice(
                      event.data.byteOffset,
                      event.data.byteOffset + event.data.byteLength
                    )
                  : []
            );
        const behavior = resolveRelayResponseBehavior(
          isTextMessage ? payload : null,
          config,
          random
        );
        if (config.verbose) {
          logger.info(
            `[mock-relay] ${behavior.shouldDrop ? 'dropping' : 'forwarding'} ${behavior.messageType} response after ${behavior.delayMs}ms`
          );
        }
        if (behavior.shouldDrop) {
          return;
        }

        const frame = encodeWebSocketFrame(isTextMessage ? 0x1 : 0x2, payload);
        if (behavior.delayMs === 0) {
          clientSocket.write(frame);
          return;
        }
        const timeoutId = setTimeout(() => {
          pendingTimeouts.delete(timeoutId);
          if (!session.isClientClosed && !clientSocket.destroyed) {
            clientSocket.write(frame);
          }
        }, behavior.delayMs);
        pendingTimeouts.add(timeoutId);
      });
      upstream.addEventListener('error', () => {
        if (!isClosing && config.verbose) {
          logger.warn(`[mock-relay] upstream connection failed: ${config.targetUrl}`);
        }
      });
      upstream.addEventListener('close', (event) => {
        if (!clientSocket.destroyed) {
          const reason = Buffer.from(event.reason ?? '').subarray(0, 123);
          const closePayload = Buffer.alloc(2 + reason.length);
          closePayload.writeUInt16BE(normalizeWebSocketCloseCode(event.code), 0);
          reason.copy(closePayload, 2);
          clientSocket.end(encodeWebSocketFrame(0x8, closePayload));
        }
        closeSession({ destroyClient: false });
      });
    }, config.handshakeDelayMs);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', onError);
      resolve();
    });
  });

  logger.info(
    `[mock-relay] listening on ws://${config.listenHost}:${config.listenPort} -> ${config.targetUrl}`
  );

  return {
    close: async () => {
      if (isClosing) {
        return;
      }
      isClosing = true;
      pendingTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      pendingTimeouts.clear();
      sessions.forEach(({ clientSocket, upstream }) => {
        clientSocket.destroy();
        if (upstream && [WebSocket.CONNECTING, WebSocket.OPEN].includes(upstream.readyState)) {
          upstream.close();
        }
      });
      sessions.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    config,
    connectionCount: () => acceptedConnectionCount,
    relayUrl: `ws://${config.listenHost}:${config.listenPort}`,
  };
}

function parseCommandLineArguments(argumentsList) {
  const valueOptions = new Map([
    ['--listen-host', 'listenHost'],
    ['--listen-port', 'listenPort'],
    ['--target', 'targetUrl'],
    ['--delay-ms', 'delayMs'],
    ['--handshake-delay-ms', 'handshakeDelayMs'],
    ['--request-delay-ms', 'requestDelayMs'],
    ['--ack-delay-ms', 'ackDelayMs'],
    ['--event-delay-ms', 'eventDelayMs'],
    ['--eose-delay-ms', 'eoseDelayMs'],
    ['--other-delay-ms', 'otherDelayMs'],
    ['--jitter-ms', 'jitterMs'],
    ['--hang', 'hangMode'],
  ]);
  const booleanOptions = new Map([
    ['--drop-acks', 'dropAcks'],
    ['--drop-events', 'dropEvents'],
    ['--drop-eose', 'dropEose'],
    ['--verbose', 'verbose'],
  ]);
  const parsedArguments = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help' || argument === '-h') {
      parsedArguments.help = true;
      continue;
    }
    if (booleanOptions.has(argument)) {
      parsedArguments[booleanOptions.get(argument)] = true;
      continue;
    }
    const optionName = valueOptions.get(argument);
    if (!optionName) {
      throw new Error(`Unknown mock relay option: ${argument}`);
    }
    const optionValue = argumentsList[index + 1];
    if (!optionValue || optionValue.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`);
    }
    parsedArguments[optionName] = optionValue;
    index += 1;
  }

  return parsedArguments;
}

function printHelp() {
  console.log(`Usage: node scripts/mock-relay-proxy.cjs [options]

Options:
  --listen-host <host>          Listen host (default: 127.0.0.1)
  --listen-port <port>          Listen port (default: 7002)
  --target <ws-url>             Upstream relay (default: ws://127.0.0.1:7000)
  --delay-ms <ms>               Default delay for every relay phase
  --handshake-delay-ms <ms>     WebSocket handshake delay
  --request-delay-ms <ms>       Client-to-relay request delay
  --ack-delay-ms <ms>           Relay OK acknowledgement delay
  --event-delay-ms <ms>         Relay EVENT delay
  --eose-delay-ms <ms>          Relay EOSE delay
  --other-delay-ms <ms>         Delay for NOTICE, AUTH, CLOSED, COUNT, and other frames
  --jitter-ms <ms>              Add random delay from 0 through this value
  --drop-acks                   Drop relay OK acknowledgements
  --drop-events                 Drop relay EVENT messages
  --drop-eose                   Drop relay EOSE messages
  --hang <mode>                 none, handshake, or responses
  --verbose                     Log relayed message categories
  --help                        Show this help

Every option also has a MOCK_RELAY_* environment variable; see docs/mock-relay.md.`);
}

module.exports = {
  calculateDelayMs,
  classifyRelayMessage,
  parseCommandLineArguments,
  resolveMockRelayConfig,
  resolveRelayResponseBehavior,
  startMockRelayProxy,
};

if (require.main === module) {
  let handle;
  const shutdown = async () => {
    await handle?.close();
    process.exit(0);
  };

  try {
    const argumentsConfig = parseCommandLineArguments(process.argv.slice(2));
    if (argumentsConfig.help) {
      printHelp();
    } else {
      startMockRelayProxy(argumentsConfig)
        .then((startedHandle) => {
          handle = startedHandle;
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        })
        .catch((error) => {
          console.error('[mock-relay] failed to start', error);
          process.exit(1);
        });
    }
  } catch (error) {
    console.error(`[mock-relay] ${error.message}`);
    process.exit(1);
  }
}
