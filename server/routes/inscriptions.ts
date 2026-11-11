// Inscriptions router: apply an inscription scroll to equipment.
// Logic unchanged from the original API handler.

import { Router, type Request, type Response } from 'express';
import { connectToMongo } from '@server/lib/mongodb';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { ObjectId } from 'mongodb';
import { getLootItemById } from '@shared/loot-table';
import { Inscription } from '@shared/types';
import { inscriptionConflict, inscriptionGoldCost } from '@shared/inscriptions';

// A minted item's inscription lives on chain (/api/equipment/update); this route edits the DB only.
const UNMINTED = { nftLootId: { $not: { $type: 'objectId' as const } } };

export const inscriptionsRouter = Router();

/**
 * POST /api/inscriptions/apply
 *
 * Apply an inscription scroll to equipment (weapon, armor, artifact)
 *
 * Request Body:
 * - equipmentId: string (UserInventory._id)
 * - scrollId: string (UserInventory._id)
 * - overwriteExisting: boolean (optional, default: false)
 *
 * Response:
 * - success: boolean
 * - message: string
 * - equipment: Updated equipment object
 * - overwriteWarning?: { slot: 'prefix' | 'suffix', existingInscription: Inscription }
 */
inscriptionsRouter.post('/apply', requireAuthProof('inscribe'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId as string;

    const body = req.body;
    const { equipmentId, scrollId, overwriteExisting = false } = body;

    if (!equipmentId || !scrollId) {
      res.status(400).json({ error: 'Missing equipmentId or scrollId' });
      return;
    }

    // Validate ObjectIds
    let equipmentObjectId: ObjectId;
    let scrollObjectId: ObjectId;

    try {
      equipmentObjectId = new ObjectId(equipmentId);
      scrollObjectId = new ObjectId(scrollId);
    } catch (err) {
      res.status(400).json({ error: 'Invalid equipment or scroll ID format' });
      return;
    }

    // Connect to MongoDB
    const { userInventoryCollection, playerStatsCollection } = await connectToMongo();

    // Fetch player stats to check gold
    const playerStats = await playerStatsCollection.findOne({ userId });
    if (!playerStats) {
      res.status(404).json({ error: 'Player stats not found' });
      return;
    }

    // Fetch equipment item
    const equipmentItem = await userInventoryCollection.findOne({
      _id: equipmentObjectId,
      userId
    });

    if (!equipmentItem) {
      res.status(404).json({ error: 'Equipment not found or you do not own it' });
      return;
    }

    // Validate equipment is inscribable (weapon, armor, artifact)
    if (!['weapon', 'armor', 'artifact'].includes(equipmentItem.itemType)) {
      res.status(400).json({ error: 'Only weapons, armor, and artifacts can be inscribed' });
      return;
    }

    // Fetch scroll item
    const scrollItem = await userInventoryCollection.findOne({
      _id: scrollObjectId,
      userId
    });

    if (!scrollItem) {
      res.status(404).json({ error: 'Inscription scroll not found or you do not own it' });
      return;
    }

    // Validate scroll is an inscription_scroll
    if (scrollItem.itemType !== 'inscription_scroll') {
      res.status(400).json({ error: 'Selected item is not an inscription scroll' });
      return;
    }

    // Get inscription data from loot table
    const scrollTemplate = getLootItemById(scrollItem.lootTableId);
    if (!scrollTemplate || !scrollTemplate.inscriptionData) {
      res.status(500).json({ error: 'Invalid inscription scroll data' });
      return;
    }

    // Minted items (and only they) can be listed or claimed by a craft; editing them here
    // would desync the chain and let a minted scroll be spent twice.
    if (equipmentItem.nftLootId || scrollItem.nftLootId) {
      res.status(400).json({ error: 'Minted items are inscribed on chain through the Blacksmith' });
      return;
    }

    const inscriptionData = scrollTemplate.inscriptionData;
    const slot = inscriptionData.slot; // 'prefix' or 'suffix'

    // Prevent the same autoclick/lifesteal type on both prefix and suffix
    const conflict = inscriptionConflict(equipmentItem, inscriptionData);
    if (conflict) {
      const oppositeSlot = slot === 'prefix' ? 'suffix' : 'prefix';
      const oppositeInscription = equipmentItem[oppositeSlot] as Inscription;
      res.status(400).json({
        error: `Cannot apply ${conflict} inscription`,
        message: `This equipment already has a ${conflict} ${oppositeSlot}: "${oppositeInscription.name}". You cannot have both ${conflict} prefix and suffix on the same item.`
      });
      return;
    }

    const goldCost = inscriptionGoldCost(scrollTemplate.rarity);

    // Check if player has enough gold
    if (playerStats.coins < goldCost) {
      res.status(400).json({
        error: `Insufficient gold. Need ${goldCost} gold to apply this inscription.`,
        goldCost,
        currentGold: playerStats.coins
      });
      return;
    }

    // Check if slot is already occupied
    const existingInscription = equipmentItem[slot] as Inscription | undefined;
    if (existingInscription && !overwriteExisting) {
      // Warn user that slot is occupied
      res.status(409).json({
        overwriteWarning: {
          slot,
          existingInscription
        },
        message: `This equipment already has a ${slot} inscription: "${existingInscription.name}". Set overwriteExisting=true to replace it.`
      });
      return;
    }

    // Create inscription object
    const inscription: Inscription = {
      type: inscriptionData.inscriptionType,
      value: inscriptionData.statValue,
      name: inscriptionData.name
    };

    // Apply inscription to equipment
    const updateResult = await userInventoryCollection.updateOne(
      { _id: equipmentObjectId, userId, ...UNMINTED },
      { $set: { [slot]: inscription } }
    );

    if (updateResult.matchedCount === 0) {
      res.status(409).json({ error: 'Equipment changed during the request' });
      return;
    }

    // Deduct gold cost from player
    await playerStatsCollection.updateOne(
      { userId },
      { $inc: { coins: -goldCost } }
    );

    // Delete consumed scroll from inventory
    await userInventoryCollection.deleteOne({ _id: scrollObjectId, userId, ...UNMINTED });

    // Fetch updated equipment
    const updatedEquipment = await userInventoryCollection.findOne({
      _id: equipmentObjectId
    });

    res.json({
      success: true,
      message: `Successfully applied "${inscription.name}" ${slot} inscription (-${goldCost} gold)`,
      goldCost,
      equipment: {
        ...updatedEquipment,
        _id: updatedEquipment?._id?.toString()
      }
    });
    return;

  } catch (error) {
    console.error('Apply inscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
});
