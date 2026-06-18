import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyJWT } from '@/utils/jwt';
import { connectToMongo } from '@/lib/mongodb';

/**
 * GET /api/marketplace/my-sales
 * Fetch the requester's sold listings that have a claimable payout outpoint.
 * Used by the sold-items inbox so sellers can internalize (claim) their proceeds.
 */
export async function GET(_request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('verified')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    const userId = payload.userId as string;

    const { marketplaceItemsCollection } = await connectToMongo();

    const sales = await marketplaceItemsCollection
      .find({
        sellerId: userId,
        status: 'sold',
        payoutOutpoint: { $exists: true },
      })
      .sort({ soldAt: -1 })
      .toArray();

    const formattedSales = sales.map(doc => ({
      _id: doc._id?.toString(),
      itemName: doc.itemName,
      itemIcon: doc.itemIcon,
      rarity: doc.rarity,
      price: doc.price,
      payoutOutpoint: doc.payoutOutpoint,
      listingNonce: doc.listingNonce,
      payoutClaimed: !!doc.payoutClaimed,
      soldAt: doc.soldAt,
    }));

    return NextResponse.json({
      success: true,
      sales: formattedSales,
      count: formattedSales.length,
    });

  } catch (error) {
    console.error('Error fetching my-sales:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sales' },
      { status: 500 }
    );
  }
}
