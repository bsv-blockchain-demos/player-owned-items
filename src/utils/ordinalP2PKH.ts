import {
     LockingScript,
     ScriptTemplate,
     Transaction,
     UnlockingScript,
     Hash,
     OP,
     Utils,
     WalletInterface,
     Script,
     TransactionSignature,
     Signature,
     PublicKey
 } from "@bsv/sdk";
import { calculatePreimage } from "./createPreimage";
import type { Derivation } from "./tokenDerivation";

const LEGACY_DERIVATION: Derivation = {
    protocolID: [0, "monsterbattle"],
    keyID: "0",
    counterparty: "self",
};

export class OrdinalsP2PKH implements ScriptTemplate {
    lock(
        address: string | number[], // Just pubkey of user to send token to
        assetId: string, // AssetID = txid_vout
        data: Record<string, any>, // Dropped loot data
        type: "deploy+mint" | "transfer",
        amt?: number // Optional amount (defaults to 1). Materials use this for quantities, items/equipment default to 1
    ): LockingScript {
        let pubKeyHash: number[];
        if (typeof address === "string") {
            pubKeyHash = Hash.hash160(address, "hex")
        } else {
            pubKeyHash = address;
        }

        // For inscriptions, amt represents quantity (materials) or uniqueness (items/equipment)
        // Materials: amt > 1 possible (stackable quantities)
        // Items/Equipment: amt = 1 (each is unique NFT)
        let inscription: any;
        if (type === "deploy+mint") {
            inscription = {
                p: "bsv-20",
                op: type,
                amt: amt ?? 1,
            }
        } else {
            inscription = {
                p: "bsv-20",
                op: type,
                amt: amt ?? 1,
                id: assetId,
            }
        }

        // Add metadata headers for ordinal standard
        const metadata = {
            "app": "monsterbattle",
            "type": "ord",
        }
        const combined = {...metadata, ...data};

        const jsonString = JSON.stringify(inscription);
        const ordinalMetadataJson = JSON.stringify(combined);
        const lockingScript = new LockingScript();
        lockingScript
            // Write inscription
            .writeOpCode(OP.OP_0)
            .writeOpCode(OP.OP_IF)
            .writeBin(Utils.toArray('ord', 'utf8'))
            .writeOpCode(OP.OP_1)
            .writeBin(Utils.toArray('application/bsv-20', 'utf8'))
            .writeOpCode(OP.OP_0)
            .writeBin(Utils.toArray(jsonString, 'utf8'))
            .writeOpCode(OP.OP_ENDIF)
            // Write single signature lockingScript
            .writeOpCode(OP.OP_DUP)
            .writeOpCode(OP.OP_HASH160)
            .writeBin(pubKeyHash)
            .writeOpCode(OP.OP_EQUALVERIFY)
            .writeOpCode(OP.OP_CHECKSIG)
            // Token metadata
            .writeOpCode(OP.OP_RETURN)
            .writeBin(Utils.toArray(ordinalMetadataJson, "utf8"));

        return lockingScript;
    }

    /**
     * Note: "single" default allows wallet.createAction() to add change outputs after pre-signing
     */
    unlock(
        wallet: WalletInterface,
        signOutputs: "all" | "none" | "single" = "single",
        anyoneCanPay = false,
        sourceSatoshis?: number,
        lockingScript?: Script,
        derivation: Derivation = LEGACY_DERIVATION,
    ): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: () => Promise<number>;
    } {
        return {
            sign: async (tx: Transaction, inputIndex: number) => {
                 const { preimage, signatureScope } = calculatePreimage(tx, inputIndex, signOutputs, anyoneCanPay, sourceSatoshis, lockingScript);

                const { signature } = await wallet.createSignature({
                    hashToDirectlySign: Hash.hash256(preimage),
                    protocolID: derivation.protocolID,
                    keyID: derivation.keyID,
                    counterparty: derivation.counterparty,
                })

                const { publicKey } = await wallet.getPublicKey({
                    protocolID: derivation.protocolID,
                    keyID: derivation.keyID,
                    counterparty: derivation.counterparty,
                    forSelf: derivation.counterparty !== 'self',
                })

                const rawSignature = Signature.fromDER(signature, 'hex')
                const sig = new TransactionSignature(
                    rawSignature.r,
                    rawSignature.s,
                    signatureScope
                );
                const unlockScript = new UnlockingScript();
                unlockScript.writeBin(sig.toChecksigFormat());
                unlockScript.writeBin(
                    PublicKey.fromString(publicKey).encode(true) as number[]
                );

                return unlockScript;
            },
            estimateLength: async () => 108,
        }
    }
}