import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';

/**
 * API endpoint to check if a material token already exists
 *
 * POST /api/materials/check-token
 * Body: { lootTableId: string, tier: number }
 *
 * Returns: { exists: boolean, token?: { tokenId, quantity, keyId, counterparty } }
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const userId = payload.userId as string;

    // Validate that userId exists in the payload
    if (!userId) {
      console.error('JWT payload missing userId:', payload);
      return NextResponse.json({ error: 'Invalid token: missing userId' }, { status: 401 });
    }

    // Parse request body
    const { lootTableId, tier } = await request.json();

    if (!lootTableId || !tier) {
      return NextResponse.json({ error: 'Missing lootTableId or tier' }, { status: 400 });
    }

    // Connect to database
    const { materialTokensCollection } = await connectToMongo();

    // Check if a material token exists for this user, lootTableId, and tier
    // Also ensure the token is not consumed (used in crafting)
    const existingToken = await materialTokensCollection.findOne({
      userId,
      lootTableId,
      tier,
      consumed: { $ne: true },
    });

    if (existingToken) {
      return NextResponse.json({
        exists: true,
        token: {
          tokenId: existingToken.tokenId,
          quantity: existingToken.quantity,
          keyId: existingToken.keyId,
          counterparty: existingToken.counterparty,
        },
      });
    } else {
      return NextResponse.json({
        exists: false,
      });
    }

  } catch (error) {
    console.error('Error checking material token:', error);
    return NextResponse.json(
      { error: 'Failed to check material token' },
      { status: 500 }
    );
  }
}
