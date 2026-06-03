import { AuthProofClient, AuthProofServer } from '@bsv/auth';
import type { WalletProtocol } from '@bsv/sdk';

// Same options on client and server (protocol must match).
const OPTIONS = { protocol: [2, 'monster battle auth'] as WalletProtocol };

export const authClient = new AuthProofClient(OPTIONS);
export const authServer = new AuthProofServer(OPTIONS);
