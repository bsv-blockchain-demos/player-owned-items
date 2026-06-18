import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

/**
 * POST /api/marketplace/claim-proceeds
 * Records that the seller has claimed (internalized) the payout for a sold listing.
 * The on-chain internalize happens client-side; this only flips payoutClaimed so the
 * inbox can hide/distinguish already-claimed sales.
 */
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId as string;

    const body = await request.json();
    const { listingId } = body;

    if (!listingId) {
      return NextResponse.json(
        { error: 'Missing required field: listingId' },
        { status: 400 }
      );
    }

    const { marketplaceItemsCollection } = await connectToMongo();

    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
    });

    if (!listing) {
      return NextResponse.json(
        { error: 'Listing not found' },
        { status: 404 }
      );
    }

    if (listing.sellerId !== userId) {
      return NextResponse.json(
        { error: 'You are not the seller of this listing' },
        { status: 403 }
      );
    }

    if (listing.status !== 'sold') {
      return NextResponse.json(
        { error: 'Listing is not sold' },
        { status: 400 }
      );
    }

    await marketplaceItemsCollection.updateOne(
      { _id: new ObjectId(listingId) },
      { $set: { payoutClaimed: true } }
    );

    console.log('[MARKETPLACE CLAIM] Proceeds claimed:', {
      listingId,
      sellerId: userId,
      itemName: listing.itemName,
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Error claiming proceeds:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to claim proceeds' },
      { status: 500 }
    );
  }
}
