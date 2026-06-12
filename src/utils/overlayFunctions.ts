import { LookupResolver, TopicBroadcaster, Transaction } from "@bsv/sdk";

const overlay = new LookupResolver({
    slapTrackers: ['https://overlay-us-1.bsvb.tech'],
    // ls_ship override so SHIP host discovery doesn't depend on SLAP trackers.
    hostOverrides: {
        'ls_monsterbattle': ['https://overlay-us-1.bsvb.tech'],
        'ls_ship': ['https://overlay-us-1.bsvb.tech'],
    }
});

// The wallet broadcasts the tx on signAction (acceptDelayedBroadcast: false); this
// overlay submission is best-effort indexing, so a failure must not abort the caller.
// The txid is deterministic, so we return it regardless of the overlay outcome.
export const broadcastTX = async (tx: Transaction) => {
    const txid = tx.id('hex');
    try {
        const tb = new TopicBroadcaster(['tm_monsterbattle'], { resolver: overlay });
        const overlayResponse = await tx.broadcast(tb);
        console.log("Overlay response: ", overlayResponse);
    } catch (error) {
        console.warn(`Overlay index failed for ${txid} (tx still broadcast by wallet):`, error);
    }
    return { txid };
}

export async function getTransactionByTxID(txid: string) {
    try {
        // get transaction from overlay
        const response = await overlay.query({
            service: 'ls_monsterbattle', query: {
                txid: txid
            }
        }, 10000);

        return response;
    } catch (error) {
        console.error("Error getting transaction:", error);
    }
}
