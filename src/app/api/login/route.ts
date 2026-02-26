import { NextRequest, NextResponse } from 'next/server';
import { connectToMongo } from '@/lib/mongodb';
import { createJWT } from '@/utils/jwt';
import { verifyNonce } from '@bsv/sdk';
import { getServerWallet } from '@/lib/serverWallet';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, username, nonce } = body;

    // Validate input
    if (!userId || !username) {
      return NextResponse.json(
        { error: 'userId and username are required' },
        { status: 400 }
      );
    }

    if (!nonce) {
      return NextResponse.json(
        { error: 'nonce is required' },
        { status: 400 }
      );
    }

    // Verify nonce — proves the requester holds the private key for identityKey
    // counterparty = identityKey (the user's identity public key); backend reverses the same ECDH
    const serverWallet = await getServerWallet();
    const nonceValid = await verifyNonce(nonce, serverWallet, userId);
    if (!nonceValid) {
      return NextResponse.json(
        { error: 'Invalid nonce' },
        { status: 401 }
      );
    }

    // Connect to MongoDB and get collections
    const { usersCollection } = await connectToMongo();

    // Check if user exists
    let user = await usersCollection.findOne({ userId });

    if (!user) {
      // Create new user (userId IS the public key)
      const newUser = {
        userId,
        username,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await usersCollection.insertOne(newUser);

      // Refetch user to get complete document with _id
      user = await usersCollection.findOne({ userId });

      console.log('New user created:', userId);
    } else {
      // Update username if it changed
      if (user.username !== username) {
        await usersCollection.updateOne(
          { userId },
          {
            $set: {
              username,
              updatedAt: new Date()
            }
          }
        );
        console.log('User username updated:', userId);
      }
    }

    // At this point user should always exist, but TypeScript doesn't know that
    if (!user) {
      return NextResponse.json(
        { error: 'Failed to create or retrieve user' },
        { status: 500 }
      );
    }

    // Create JWT token
    console.log('[LOGIN] Creating JWT for userId:', user.userId);
    const token = await createJWT({
      userId: user.userId,
      username: username,
    });

    // Create response with cookie
    const response = NextResponse.json({
      success: true,
      user: {
        userId: user.userId,
        username: username,
      },
    });

    // Set cookie with JWT token
    response.cookies.set('verified', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
