import { NextResponse } from 'next/server'
import { MongoClient } from 'mongodb'
import { checkWalletBalance } from '@/utils/wallet-balance'

const { MIN_BALANCE, MONGODB_URI } = process.env

// app/ready/route.ts - combined check (wallet + db)
export async function GET() {
  const client = new MongoClient(MONGODB_URI!)
  try {
    const balance = await checkWalletBalance()
    if (balance < parseInt(MIN_BALANCE!)) throw new Error('Insufficient wallet balance')
    await client.connect()
    await client.db().command({ ping: 1 })
    return NextResponse.json({ status: 'ready' })
  } catch (err) {
    return NextResponse.json(
      { status: 'not ready', error: (err as Error).message },
      { status: 503 }
    )
  } finally {
    await client.close()
  }
}
