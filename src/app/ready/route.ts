import { NextResponse } from 'next/server'
import { connectToMongo } from '@/lib/mongodb'
import { checkWalletBalance } from '@/utils/wallet-balance'

// app/ready/route.ts - combined check (wallet + db)
export async function GET() {
  const { MIN_BALANCE } = process.env
  try {
    const balance = await checkWalletBalance()
    if (balance < parseInt(MIN_BALANCE!)) throw new Error('Insufficient wallet balance')
    const { db } = await connectToMongo()
    await db.command({ ping: 1 })
    return NextResponse.json({ status: 'ready' })
  } catch (err) {
    return NextResponse.json(
      { status: 'not ready', error: (err as Error).message },
      { status: 503 }
    )
  }
}
