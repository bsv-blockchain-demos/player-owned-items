import { makeWallet } from '@bsv/wallet-helper'

const { SERVER_PRIVATE_KEY, WALLET_STORAGE_URL, BSV_NETWORK } = process.env

export async function checkWalletBalance(): Promise<number> {
  const chain = (BSV_NETWORK ?? 'main') as 'main' | 'test'
  const privateKey = SERVER_PRIVATE_KEY!
  const storageURL = WALLET_STORAGE_URL!

  const wallet = await makeWallet(chain, privateKey, storageURL)

  const { totalOutputs } = await wallet.listOutputs(
    { basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8' }
  )
  return totalOutputs
}
