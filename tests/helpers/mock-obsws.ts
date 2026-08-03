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

// Task 2.12 — a scene's Browser Source input, as tracked by the mock's
// in-memory "OBS state" for GetInputList/GetInputSettings/SetInputSettings/
// CreateInput. Real obs-websocket tracks far more per input; this mock only
// carries what the dock's add-overlay-to-scene flow actually reads/writes.
export interface MockInputSeed {
  inputName: string;
  inputKind: string;
  inputSettings: Record<string, unknown>;
}

export interface MockObsOptions {
  password?: string;
  /** Seeds GetVideoSettings' response — default 1920x1080 (Task 2.12). */
  videoSettings?: { baseWidth: number; baseHeight: number };
  /** Seeds GetCurrentProgramScene's response — default 'Scene' (Task 2.12). */
  programScene?: string;
  /** Seeds the inputs GetInputList/GetInputSettings see from the start (Task 2.12) — e.g. a pre-existing overlay Browser Source, or a same-named-but-unrelated input for collision tests. */
  inputs?: MockInputSeed[];
}

export interface MockObs {
  port: number;
  url: string;
  clients(): number;
  injectEvent(type: string, data: object): void;
  dropAllClients(code?: number): void;
  /** Test hook: swallow the next incoming request (no op-7 response sent). */
  swallowNext(): void;
  /** Test hook: hold back the next Identified (op 2) reply by `ms` after a valid Identify. */
  delayIdentify(ms: number): void;
  /** Test hook: hold back the next request's op-7 response by `ms` (to force out-of-order replies). */
  delayNextResponse(ms: number): void;
  /**
   * Test hook: hold back EVERY response for `requestType` by `ms` (0 clears).
   * Unlike `delayNextResponse`, this can't be consumed by whatever request
   * happens to arrive first — needed once the dock has a 2s heartbeat
   * broadcasting on its own, when "the next request" is a coin flip.
   */
  delayResponsesFor(requestType: string, ms: number): void;
  /**
   * Test hook (Task 2.12): forces the NEXT request of `requestType` to fail
   * with a genuine obs-websocket-shaped error response (`result:false`) —
   * used to exercise the add-overlay flow's error path independent of the
   * name-collision case (which CreateInput already rejects on its own; see
   * below). Consumed after one use, same convention as `swallowNext()`.
   */
  failNext(requestType: string, code?: number, comment?: string): void;
  persistent: Map<string, unknown>;
  broadcasts: Array<{ from: number; eventData: unknown }>;
  /** Every requestType this server has ever received, in arrival order — lets a test assert NO scene/source-mutation request type was ever sent (only BroadcastCustomEvent/SetPersistentData/GetPersistentData). */
  requestLog: string[];
  /** Every request's full payload, in arrival order — lets a test assert the EXACT requestData a call carried (Task 2.12: CreateInput/SetInputSettings payload assertions). */
  requestPayloads: Array<{ type: string; data: Record<string, unknown> }>;
  /** Current scene/input state as the mock sees it (Task 2.12) — read directly for assertions instead of round-tripping through another request. */
  inputs: Map<string, { inputKind: string; inputSettings: Record<string, unknown> }>;
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
  const requestLog: string[] = [];
  const requestPayloads: Array<{ type: string; data: Record<string, unknown> }> = [];
  const identifiedClients = new Set<WsSocket>();
  const clientIds = new WeakMap<WsSocket, number>();
  let nextClientId = 1;
  let swallowNextFlag = false;
  let identifyDelayMs = 0;
  let nextResponseDelayMs = 0;
  const perTypeDelayMs = new Map<string, number>();
  const forcedFailures = new Map<string, { code: number; comment: string }>();

  // Task 2.12 — scene/input state for the add-overlay-to-scene flow.
  const videoSettings = opts.videoSettings ?? { baseWidth: 1920, baseHeight: 1080 };
  const programScene = opts.programScene ?? 'Scene';
  const inputs = new Map<string, { inputKind: string; inputSettings: Record<string, unknown> }>();
  for (const seed of opts.inputs ?? []) {
    inputs.set(seed.inputName, { inputKind: seed.inputKind, inputSettings: { ...seed.inputSettings } });
  }
  let nextSceneItemId = 1;

  function send(socket: WsSocket, op: number, d: Record<string, unknown>): void {
    socket.send(JSON.stringify({ op, d }));
  }

  function handleRequest(socket: WsSocket, clientId: number, msg: RequestMessage): void {
    if (swallowNextFlag) {
      swallowNextFlag = false;
      return;
    }
    const { requestType, requestId, requestData } = msg.d;
    requestLog.push(requestType);
    requestPayloads.push({ type: requestType, data: requestData ?? {} });
    let result = true;
    let code = 100;
    let comment: string | undefined;
    let responseData: Record<string, unknown> = {};

    const forced = forcedFailures.get(requestType);
    if (forced) {
      forcedFailures.delete(requestType);
      result = false;
      code = forced.code;
      comment = forced.comment;
    } else {
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
        // --- Task 2.12: add-overlay-to-scene ------------------------------
        case 'GetVideoSettings': {
          responseData = { baseWidth: videoSettings.baseWidth, baseHeight: videoSettings.baseHeight };
          break;
        }
        case 'GetCurrentProgramScene': {
          responseData = { currentProgramSceneName: programScene };
          break;
        }
        case 'GetInputList': {
          responseData = {
            inputs: Array.from(inputs.entries()).map(([inputName, input]) => ({
              inputName,
              inputKind: input.inputKind,
              unversionedInputKind: input.inputKind,
            })),
          };
          break;
        }
        case 'GetInputSettings': {
          const inputName = requestData?.inputName as string;
          const input = inputs.get(inputName);
          if (!input) {
            result = false;
            code = 600; // OBS_WEBSOCKET_ERROR_RESOURCE_NOT_FOUND semantics
            comment = `No source was found by the name of \`${inputName}\`.`;
          } else {
            responseData = { inputSettings: input.inputSettings, inputKind: input.inputKind };
          }
          break;
        }
        case 'SetInputSettings': {
          const inputName = requestData?.inputName as string;
          const input = inputs.get(inputName);
          if (!input) {
            result = false;
            code = 600;
            comment = `No source was found by the name of \`${inputName}\`.`;
          } else {
            // Real obs-websocket's `overlay` field defaults to `true` (MERGE
            // with the input's existing settings) when the request omits it
            // — only an explicit `overlay:false` replaces wholesale. Mocking
            // the replace-always shortcut would hide a real regression if
            // the dock ever started sending `overlay:false` (or some future
            // caller relied on merge semantics) — see review fold-in, Minor.
            const newSettings = (requestData?.inputSettings as Record<string, unknown>) ?? {};
            const overlayMerge = requestData?.overlay !== false;
            input.inputSettings = overlayMerge ? { ...input.inputSettings, ...newSettings } : { ...newSettings };
          }
          break;
        }
        case 'CreateInput': {
          const inputName = requestData?.inputName as string;
          if (inputs.has(inputName)) {
            result = false;
            code = 601; // OBS_WEBSOCKET_ERROR_RESOURCE_ALREADY_EXISTS semantics
            comment = 'A source already exists by that name.';
          } else {
            const inputKind = (requestData?.inputKind as string) ?? 'browser_source';
            const inputSettings = { ...((requestData?.inputSettings as Record<string, unknown>) ?? {}) };
            inputs.set(inputName, { inputKind, inputSettings });
            responseData = { sceneItemId: nextSceneItemId++ };
          }
          break;
        }
        default: {
          result = false;
          code = 204;
          break;
        }
      }
    }

    const respond = (): void => {
      const requestStatus: { result: boolean; code: number; comment?: string } = { result, code };
      if (comment !== undefined) requestStatus.comment = comment;
      send(socket, OP_REQUEST_RESPONSE, { requestId, requestStatus, responseData });
    };
    const typeDelay = perTypeDelayMs.get(requestType) ?? 0;
    if (nextResponseDelayMs > 0 || typeDelay > 0) {
      const delay = Math.max(nextResponseDelayMs, typeDelay);
      nextResponseDelayMs = 0;
      setTimeout(respond, delay);
    } else {
      respond();
    }
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
        const sendIdentified = (): void => {
          identifiedClients.add(socket);
          send(socket, OP_IDENTIFIED, { negotiatedRpcVersion: 1 });
        };
        if (identifyDelayMs > 0) {
          const delay = identifyDelayMs;
          identifyDelayMs = 0;
          setTimeout(sendIdentified, delay);
        } else {
          sendIdentified();
        }
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
    delayIdentify(ms) {
      identifyDelayMs = ms;
    },
    delayNextResponse(ms) {
      nextResponseDelayMs = ms;
    },
    delayResponsesFor(requestType, ms) {
      if (ms <= 0) perTypeDelayMs.delete(requestType);
      else perTypeDelayMs.set(requestType, ms);
    },
    failNext(requestType, code = 500, comment = 'forced failure (test)') {
      forcedFailures.set(requestType, { code, comment });
    },
    persistent,
    broadcasts,
    requestLog,
    requestPayloads,
    inputs,
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const c of wss.clients) c.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
