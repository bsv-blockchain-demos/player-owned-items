# Monster Battle

Monster Battle is a BSV gaming demo for collecting, crafting, equipping and trading player-owned item tokens. A React application handles the game interface, an Express server validates application actions and constructs transactions, and MongoDB indexes players, inventory and marketplace records.

The repository demonstrates a game economy with a server-controlled issuer. It is experimental software, with wallet, database and overlay dependencies that need to be understood before running a funded instance.

## What it demonstrates

- Item and material tokens using ordinal-style inscriptions and P2PKH spending conditions.
- Server minting followed by transfer to a player's wallet.
- Crafting that consumes material tokens and links the resulting item to the consumption transaction.
- Equipment and material updates that replace the current token output.
- An OrderLock marketplace for listing, purchasing, cancelling and claiming proceeds.
- BRC-42 keys derived separately for token outputs, with derivation metadata stored for later spending.

These are the application's token formats and workflows. The repository does not include an independent certification of token-standard compliance or production readiness.

## Architecture

| Package | Responsibility |
| --- | --- |
| [client/](client/) | Vite 6, React 19, React Router 7 and Tailwind CSS 4 interface. |
| [server/](server/) | Express API, session and ownership-proof checks, wallet queue and MongoDB access. |
| [shared/](shared/) | Game data and rules, token scripts, derivation helpers and transaction encoding. |
| [_tests/](_tests/) | Jest tests for server routes, shared logic and token scripts. |

The client and API run on separate origins. The API owns one server wallet and serialises wallet operations through an in-memory queue. Run the API as **one instance**; that queue does not coordinate multiple processes.

## Token and marketplace flow

Item minting normally creates a server-held token followed by a transfer to the player. Material quantities are represented in token metadata and updated by spending the previous output. Crafting uses a client-created consumption transaction with an authorisation output, then server-created mint and transfer transactions.

New token outputs use protocol `[2, 'monsterbattle token']` and a per-output nonce. The owner's wallet basket is `monsterbattle.tokens`; MongoDB also indexes derivation metadata. Older fixed-key token paths remain supported. The code uses full `txid.vout` outpoints to distinguish outputs.

Creators carry transaction BEEF alongside the operation. Marketplace listing BEEF is backed up in `marketplace_listing_beefs`, with overlay lookup as a fallback. The overlay uses topic `tm_monsterbattle` and lookup service `ls_monsterbattle`.

The marketplace validates submitted listing transactions and uses an atomic database claim before processing a purchase. It also uses MongoDB transactions when finalising a purchase, so the database needs a **replica set or sharded deployment** supporting transactions.

For the implementation, see [transaction flow notes](TRANSACTION_FLOW_PATTERN.md), [tokenDerivation.ts](shared/tokenDerivation.ts), [ordinalP2PKH.ts](shared/ordinalP2PKH.ts), [OrderLock adapter](client/src/utils/orderLock.ts) and [marketplace.ts](server/routes/marketplace.ts).

## Requirements

- Node.js 22 and npm.
- MongoDB with transaction support for marketplace purchases.
- A funded server wallet and compatible Wallet Toolbox storage.
- A compatible BRC-100 player wallet for signing, payments and token internalisation.
- Access to the configured overlay when using its indexing and lookup services.

## Local setup

```sh
git clone https://github.com/bsv-blockchain-demos/player-owned-items.git
cd player-owned-items
npm ci
```

This installs the three npm workspaces. Create `server/.env`:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/monsterbattle?replicaSet=rs0
SERVER_PRIVATE_KEY=<your-hex-private-key>
JWT_SECRET=<your-random-session-secret>
WALLET_STORAGE_URL=https://store-us-1.bsvb.tech
BSV_NETWORK=main
ALLOWED_ORIGINS=http://localhost:5173
PORT=4000
NODE_ENV=development
```

The local URI assumes that you have already configured a replica set named `rs0`. Use your actual database connection string otherwise. The server defaults to mainnet; keep the wallet storage and player wallet on the chosen network.

Create `client/.env`:

```dotenv
VITE_API_BASE=http://localhost:4000
```

Run the database migration against the intended development database:

```sh
npm run db:migrate
```

It creates the required indexes. Startup verifies critical unique indexes and stops if they are missing. The application reads `server/.env` when launched from the repository root; the root `.env.example` is not automatically loaded as the server's environment.

Start the API and frontend in separate terminals, both from the root:

```sh
npm run server:dev
```

```sh
npm run client:dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The API uses port 4000 by default; choose another port and update `VITE_API_BASE` if that conflicts with a local wallet service. Match the frontend origin in `ALLOWED_ORIGINS`.

## API guide

[server/routes/](server/routes/) contains request shapes and guards for authentication, players, battle, inventory, materials, items, crafting, equipment, spells, consumables and marketplace operations.

Representative value-moving routes include:

- `POST /api/items/mint-and-transfer`
- `POST /api/materials/mint-and-transfer`
- `POST /api/crafting/mint-and-transfer`
- `POST /api/marketplace/list-item`
- `POST /api/marketplace/purchase-listing`
- `POST /api/marketplace/cancel-listing`
- `POST /api/marketplace/claim-proceeds`

The browser API helpers include credentials and attach signed ownership proofs where required. A successful frontend build does not validate live minting or marketplace settlement.

## Builds and tests

```sh
npm run client:build
npx tsc --noEmit
npx tsc -p client/tsconfig.json --noEmit
npm run test:client
```

The client build writes static files to `client/dist`. `server:start` runs the TypeScript API through `tsx`.

The Jest suite combines mocked route tests with wallet integration tests. Despite its name, `_tests/helpers/mockWallet.ts` re-exports the real remote-storage wallet factory. Tests importing it can contact `https://store-us-1.bsvb.tech`; review test selection before running `npm test`, `test:server` or coverage commands.

With the checked-in lockfile, the README review on Node.js 22 and npm 11 found that Jest could not start because `ts-jest` could not resolve `jest-util`. The client tests and both TypeScript checks are separate commands and can still run.

## Deployment notes

Serve `client/dist` with SPA history fallback and the intended `VITE_API_BASE` built in. Configure the API origin allowlist, cookie behaviour and database connection for the deployment. Keep the API to one instance, retain the server wallet key, and preserve MongoDB records and transaction backups.

Before using the demo with valuable items, validate the complete transaction lifecycle, recovery after partial failures and enforcement of game rules. Server issuance and an application index do not by themselves prove that every game event was valid.

## Licence

**Open BSV Licence v6.** See [LICENSE.txt](LICENSE.txt) for the full terms. The licence applies to this project's original code and documentation and restricts use to the BSV blockchain defined in the licence. Third-party code, assets and referenced standards retain their respective terms.
