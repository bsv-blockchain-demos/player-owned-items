// Inscriptions router: apply an inscription scroll to equipment.
// Logic unchanged from the original API handler.

import { Router, type Request, type Response } from 'express';
import { connectToMongo } from '@server/lib/mongodb';
import { requireAuthProof } from '@server/middleware/requireAuthProof';
import { ObjectId } from 'mongodb';
import { getLootItemById } from '@shared/loot-table';
import { Inscription } from '@shared/types';
import { inscriptionGoldCost } from '@shared/inscriptions';

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

    const inscriptionData = scrollTemplate.inscriptionData;
    const slot = inscriptionData.slot; // 'prefix' or 'suffix'

    // VALIDATION: Prevent both autoclick prefix AND suffix on same item
    // VALIDATION: Prevent both lifesteal prefix AND suffix on same item
    const exclusiveTypes = ['autoclick', 'lifesteal'];
    if (exclusiveTypes.includes(inscriptionData.inscriptionType)) {
      const oppositeSlot = slot === 'prefix' ? 'suffix' : 'prefix';
      const oppositeInscription = equipmentItem[oppositeSlot] as Inscription | undefined;

      if (oppositeInscription && oppositeInscription.type === inscriptionData.inscriptionType) {
        const typeLabel = inscriptionData.inscriptionType === 'autoclick' ? 'autoclick' : 'lifesteal';
        res.status(400).json({
          error: `Cannot apply ${typeLabel} inscription`,
          message: `This equipment already has a ${typeLabel} ${oppositeSlot}: "${oppositeInscription.name}". You cannot have both ${typeLabel} prefix and suffix on the same item.`
        });
        return;
      }
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
      { _id: equipmentObjectId },
      { $set: { [slot]: inscription } }
    );

    if (updateResult.matchedCount === 0) {
      res.status(500).json({ error: 'Failed to update equipment' });
      return;
    }

    // Deduct gold cost from player
    await playerStatsCollection.updateOne(
      { userId },
      { $inc: { coins: -goldCost } }
    );

    // Delete consumed scroll from inventory
    await userInventoryCollection.deleteOne({ _id: scrollObjectId });

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
