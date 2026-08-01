// Minimal mock of an obs-websocket 5.x server, for exercising ObsWsClient
// against real sockets on an ephemeral localhost port. Test-only: uses the
// 'ws' devDependency and node:crypto directly (never shipped to src/).
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from 'ws';

const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

export interface MockObsOptions {
  password?: string;
}

export interface MockObs {
  port: number;
  url: string;
  clients(): number;
  injectEvent(type: string, data: object): void;
  dropAllClients(code?: number): void;
  /** Test hook: swallow the next incoming request (no op-7 response sent). */
  swallowNext(): void;
  persistent: Map<string, unknown>;
  broadcasts: Array<{ from: number; eventData: unknown }>;
  close(): Promise<void>;
}

interface RequestMessage {
  op: typeof OP_REQUEST;
  d: { requestType: string; requestId: string; requestData?: Record<string, unknown> };
}
interface IdentifyMessage {
  op: typeof OP_IDENTIFY;
  d: { rpcVersion: number; eventSubscriptions?: number; authentication?: string };
}
type IncomingMessage = RequestMessage | IdentifyMessage | { op: number; d?: unknown };

// obs-websocket 5.x auth digest, computed independently here (node:crypto)
// to verify the client's crypto.subtle chain server-side:
//   secret = base64(sha256(password + salt))
//   authString = base64(sha256(secret + challenge))
function computeAuthString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt, 'utf8').digest('base64');
  return createHash('sha256').update(secret + challenge, 'utf8').digest('base64');
}

export async function startMockObs(opts: MockObsOptions = {}): Promise<MockObs> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const persistent = new Map<string, unknown>();
  const broadcasts: Array<{ from: number; eventData: unknown }> = [];
  const identifiedClients = new Set<WsSocket>();
  const clientIds = new WeakMap<WsSocket, number>();
  let nextClientId = 1;
  let swallowNextFlag = false;

  function send(socket: WsSocket, op: number, d: Record<string, unknown>): void {
    socket.send(JSON.stringify({ op, d }));
  }

  function handleRequest(socket: WsSocket, clientId: number, msg: RequestMessage): void {
    if (swallowNextFlag) {
      swallowNextFlag = false;
      return;
    }
    const { requestType, requestId, requestData } = msg.d;
    let result = true;
    let code = 100;
    let responseData: Record<string, unknown> = {};

    switch (requestType) {
      case 'BroadcastCustomEvent': {
        const eventData = (requestData?.eventData ?? {}) as unknown;
        broadcasts.push({ from: clientId, eventData });
        for (const c of identifiedClients) {
          send(c, OP_EVENT, { eventType: 'CustomEvent', eventData });
        }
        break;
      }
      case 'SetPersistentData': {
        const realm = requestData?.realm as string;
        const slotName = requestData?.slotName as string;
        const slotValue = requestData?.slotValue;
        persistent.set(`${realm}/${slotName}`, slotValue);
        break;
      }
      case 'GetPersistentData': {
        const realm = requestData?.realm as string;
        const slotName = requestData?.slotName as string;
        const value = persistent.get(`${realm}/${slotName}`);
        responseData = { slotValue: value === undefined ? null : value };
        break;
      }
      default: {
        result = false;
        code = 204;
        break;
      }
    }

    send(socket, OP_REQUEST_RESPONSE, { requestId, requestStatus: { result, code }, responseData });
  }

  wss.on('connection', (socket) => {
    const id = nextClientId++;
    clientIds.set(socket, id);

    let challenge: string | undefined;
    let salt: string | undefined;
    const hello: Record<string, unknown> = { rpcVersion: 1, obsWebSocketVersion: '5.0.0' };
    if (opts.password !== undefined) {
      challenge = randomBytes(16).toString('base64');
      salt = randomBytes(16).toString('base64');
      hello.authentication = { challenge, salt };
    }
    send(socket, OP_HELLO, hello);

    socket.on('message', (raw: RawData) => {
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(String(raw)) as IncomingMessage;
      } catch {
        return;
      }

      if (msg.op === OP_IDENTIFY) {
        const identify = msg as IdentifyMessage;
        if (opts.password !== undefined) {
          const expected = computeAuthString(opts.password, salt as string, challenge as string);
          if (identify.d.authentication !== expected) {
            socket.close(4009, 'Authentication failed');
            return;
          }
        }
        identifiedClients.add(socket);
        send(socket, OP_IDENTIFIED, { negotiatedRpcVersion: 1 });
        return;
      }

      if (msg.op === OP_REQUEST) {
        handleRequest(socket, id, msg as RequestMessage);
        return;
      }
    });

    socket.on('close', () => {
      identifiedClients.delete(socket);
    });
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    clients: () => wss.clients.size,
    injectEvent(type, data) {
      for (const c of identifiedClients) {
        send(c, OP_EVENT, { eventType: type, eventData: data });
      }
    },
    dropAllClients(code) {
      for (const c of Array.from(wss.clients)) {
        if (code === undefined) {
          c.terminate();
        } else {
          c.close(code);
        }
      }
    },
    swallowNext() {
      swallowNextFlag = true;
    },
    persistent,
    broadcasts,
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const c of wss.clients) c.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
