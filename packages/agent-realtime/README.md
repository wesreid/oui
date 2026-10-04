# @ouispec/agent-realtime

The realtime server for agent turns and UI actions. One implementation serves every product (ADR-0227). It does six things:

- **Carries events.** Turn events, UI action dispatches and the product's own events reach rooms through the internal emit API.
- **Holds UI action results.** It keeps each browser's answer to a UI action for the agent worker that asked (ADR-0209). Answers are shared across instances through Redis.
- **Keeps approvals.** An irreversible action runs only on an approval the user gave, bound to the exact call by a single-use token (ADR-0228).
- **Signs and checks room tokens.** A room token admits one user to one room.
- **Checks client events.** It accepts only the client events it declares, and puts each one through a chain: rate limit, size cap, schema, then authorization against the verified identity.
- **Restricts relays.** A client can relay only allow-listed events, and only into rooms its socket has joined.

## What the product supplies

Every seam is required. When one is missing, the server fails at start-up and names it. No seam defaults to another product's value.

| Seam | Config | What it is |
|---|---|---|
| Auth verifier | `auth` | `AuthAdapter.verify(token)`. It verifies your users' tokens once per socket and returns `{ userId, accountId?, platformAdmin?, metadata? }`. |
| Room policy | `roomPolicy` | `isValidRoom`, `identityRooms` (the rooms a socket joins on connect and can never leave), `requiresToken`, and `canJoin` for the rooms that need no token. |
| Internal key | `internalApiKey` | Guards `/api/emit` and `/internal/*`. Use one per environment, kept in your secret store. |
| Room-token secret | `roomTokens.secret` | Signs room tokens with HMAC-SHA256. It must be at least 32 characters and must differ from the internal key. `ttlMs` is optional and defaults to 15 minutes. |
| Approval signing key | `approvals.signingKey` | Signs approval tokens (compact JWS, HS256). It must be at least 32 characters and differ from the internal key and the room-token secret. Use one per environment; an engine that verifies approval tokens holds this key and nothing else. |
| Redis | `redis` | `{ host, port, tls }`. UI action results and room fan-out cross instances here. |
| CORS origins | `corsOrigins` | The browser origins allowed to connect. Pass `['*']` only on purpose. |
| Port | `port` | The port to listen on. `0` picks a free one. |

Optional:
- `events`: your event declarations, with the platform's own: `createEventCatalog(PLATFORM_EVENTS, yourEvents)` from `@ouispec/agent-events` (see below).
- `relay`: the client-relayable events, each with a room prefix and a data schema. With `events`, the declaration supplies both, so `{}` is enough; the event must be a declared `notice` that does not go to a turn's room.
- `clientEvents`: your own declared events, built with `defineClientEvent`.
- `logger`: a pino-shaped logger.
- `pingInterval` and `pingTimeout`.

## Room tokens: the product decides, the server signs

A room that `requiresToken` is joined only with a token binding this user to this exact room. Minting one takes two steps:

1. The browser asks your API for a token. Your API runs the resource's own read authorization, the same check its GET route applies.
2. Only if that check passes does your API call `POST /internal/room-token` with `{ userId, room }` and the internal key. The response is `{ token, expiresInMs }`, and your API returns the token to the browser.

The browser then joins with `socket.emit('subscribe', { rooms: [room], tokens: { [room]: token } }, ack)`. A room joined by identity is refused a token.

## Declared events

Pass `events` and the server follows your declarations (ADR-0227 §2.4):

- **Emit.** `/api/emit` sends only a declared event, with a payload its schema accepts, into rooms it is declared for. Anything else is refused with `400 { error }` and logged as `Emit refused` with the event, the rooms and the reason. A declared event is never broadcast.
- **Relay.** A client relays only an event you list in `relay` that is declared as a `notice`. Its declaration decides the rooms and the data it may carry. Listing a completion, failure, progress or turn event fails at start-up.
- **Settlements.** Every declared completion or failure you emit settles one job: the job of its kind whose id is in its correlation field. The first is kept for 35 minutes, shared across instances, so a worker can wait for a job to end without joining a room (`createHttpEventWaiter` in `@ouispec/agent-worker`).

The platform's own events (the worker's turn events and OUI's UI action dispatch) are declared in `PLATFORM_EVENTS`, so they pass the same checks.

## Internal endpoints

All of them require the `x-api-key` header.

| Endpoint | Purpose |
|---|---|
| `POST /api/emit` `{ event, data, rooms? }` | Sends a server event to rooms. With no `rooms`, it goes to every socket. |
| `POST /internal/room-token` `{ userId, room }` | Signs a room token (see above). |
| `GET /internal/oui/action-results/:requestId?userId=&waitMs=&final=1` | Returns the browser's answer to a UI action. The first answer wins. With `final=1` you get an async action's final answer instead. Answers are returned only to the turn's own user. `200` carries the result; `204` means not yet, so ask again. A wait lasts at most 25 s. |
| `POST /internal/approvals` | Stores a pending approval (the worker, or a conversation engine). `201`; `400` for a bad body, a hash that does not match the arguments, or an expiry more than 30 minutes away; `409` for an id already stored. |
| `POST /internal/approvals/:id/decide` `{ userId, decision, channel }` | A conversation channel's decision (`voice`, `phone`, `sms`, `chat`), made by the engine for the session's user. A `ui` decision is refused here: in a UI only the user's click counts. |
| `POST /internal/approvals/redeem` `{ token, userId, conversationId }` | Atomic single use. `200 { call }` returns exactly the stored call. `403` for a token this environment did not sign, another user's or conversation's, or one not for the stored call; `410` for an expired or already used one. |
| `GET /internal/approvals/:id?userId=` | Where an approval of this user's stands: `pending`, `approved` or `declined` (remembered for 30 minutes). |
| `POST /internal/approvals/:id/settle` `{ userId, conversationId, confirm? }` | Whether an approval a conversation still shows as waiting expired with nobody deciding it. Always `200 { approvalId, outcome, expiresAt? }`: `claimed` (it expired undecided, and this caller holds the claim to store that, for two minutes), `already` (another turn holds the claim, or it is stored), `open` (pending, or approved and not yet used), `unknown` (declined, used, another user's or conversation's, or not remembered). With `confirm: true`, the caller has stored it and the claim becomes permanent: `confirmed`. |
| `GET /internal/events/settlements/:kind/:id?waitMs=` | How a job of a declared kind ended: `{ kind, role, event, id, payload }`, with `role` `completion` or `failure`. `204` means not yet; `400` an undeclared kind; `404` a server without `events`. A wait lasts at most 25 s. |
| `GET /health` | Returns `200` with connection and pending-wait counts. No key needed. |

## Approvals (ADR-0228)

1. The worker stops the turn at a call that needs approval, stores it with `POST /internal/approvals`, and emits `agent:approval_required` with the preview.
2. The user clicks the approval card. Their socket sends `approval:decide { approvalId, decision }`, a declared client event. The store checks that the socket's verified user is the approval's own. An approval's token is answered only to that socket, in the ack: `{ ok: true, decision: 'approve', token, argsHash, expiresAt }`.
3. The next turn carries the token outside the message text. The worker redeems it, and the store returns the stored call exactly once.

An approval nobody decides sends nothing when it expires, so a later turn settles it. The store remembers, for 30 days, that an approval was asked for and is still undecided; a decline or a redemption removes that memory in the same step. Once the approval's own keys have lapsed in Redis, `POST /internal/approvals/:id/settle` answers that it expired undecided, and gives the claim to store that to one caller at a time. Expiry is Redis's clock: neither this server's nor the caller's is consulted. Approvals stored before this memory existed are answered `unknown`.

A declined approval is deleted and remembered for the next turn. Every issue, decision and redemption is logged with the approval id, user, tool, effect, channel and args hash. The arguments are logged only when their declaration marks them not sensitive, and a token never is.

The token's claims are `aid sub cid tool ah eff ch iat exp jti`. `ah` is `argsHash(args)` from `@ouispec/agent-core`: SHA-256 over the RFC 8785 canonical JSON. The package ships `approval-vectors.json`, which every other implementation must match.

## Example

```ts
import { createRealtimeServer } from '@ouispec/agent-realtime';

const server = await createRealtimeServer({
  auth: { verify: (token) => verifyMyUser(token) },
  roomPolicy: {
    isValidRoom: (room) => /^member:[\w-]+$|^chat:turn:[\w-]+$/.test(room),
    identityRooms: (user) => [`member:${user.userId}`],
    requiresToken: (room) => room.startsWith('chat:turn:'),
    canJoin: (room, user) => room === `member:${user.userId}`,
  },
  internalApiKey: secrets.realtimeInternalKey,
  roomTokens: { secret: secrets.roomTokenSecret },
  approvals: { signingKey: secrets.approvalSigningKey },
  redis: { host: env.REDIS_HOST, port: 6379, tls: true },
  corsOrigins: ['https://app.example.com'],
  port: 3331,
});
```

## Testing

`@ouispec/agent-realtime/testing` exports `startTestRedis()`. If `REDIS_URL` is set it uses that Redis. Otherwise it starts a private `redis-server` on a free port. If neither is available, it fails.
