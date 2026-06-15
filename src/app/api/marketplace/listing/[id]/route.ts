import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

/**
 * GET /api/marketplace/listing/[id]
 * Fetch a single marketplace listing (seller-only) including OrdLock details.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId as string;

    const { id: listingId } = await params;
    if (!listingId) {
      return NextResponse.json({ error: 'Missing listing id' }, { status: 400 });
    }

    const { marketplaceItemsCollection, marketplaceListingBeefsCollection } = await connectToMongo();

    const listing = await marketplaceItemsCollection.findOne({
      _id: new ObjectId(listingId),
      status: 'active',
    });

    if (!listing) {
      return NextResponse.json(
        { error: 'Listing not found or not active' },
        { status: 404 }
      );
    }

    if (listing.sellerId !== userId) {
      return NextResponse.json(
        { error: 'You are not the seller of this listing' },
        { status: 403 }
      );
    }

    // Attach the listing tx BEEF so the seller can spend the orderLock on cancel
    // without the overlay (client falls back to overlay if this is missing).
    const beefDoc = await marketplaceListingBeefsCollection.findOne({ listingId });

    return NextResponse.json({
      success: true,
      listing: {
        ...listing,
        _id: listing._id?.toString(),
        ordLockBeef: beefDoc?.beef,
      },
    });
  } catch (error) {
    console.error('Error fetching marketplace listing:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch listing' },
      { status: 500 }
    );
  }
}
