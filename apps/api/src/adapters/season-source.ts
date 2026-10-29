import { SrcSeasonModel, ISrcSeason, SeasonStatus } from '../db/models/src-season.model';
import { SrcCollectionModel, ISrcCollection } from '../db/models/src-collection.model';
import { ForbiddenError } from '../errors/app-error';
import { clock } from '../services/clock';

export interface SourceSeason {
  seasonId: string;
  tenantId: string;
  name: string;
  festivalDate: Date;
  releaseId?: string | null;
  collectionId?: string | null;
  description?: string | null;
  validFrom: Date;
  validUntil: Date;
  status: SeasonStatus;
  branchIds?: string[];
  entityVersion: number;
  collection?: ISrcCollection | null;
}

export function toSourceSeason(doc: ISrcSeason, collection?: ISrcCollection | null): SourceSeason {
  return {
    seasonId: doc.seasonId,
    tenantId: doc.tenantId,
    name: doc.name,
    festivalDate: doc.festivalDate,
    releaseId: doc.releaseId,
    collectionId: doc.collectionId || doc.releaseId,
    description: doc.description,
    validFrom: doc.validFrom,
    validUntil: doc.validUntil,
    status: doc.status,
    branchIds: doc.branchIds,
    entityVersion: doc.entityVersion,
    collection: collection || null,
  };
}

export interface SeasonSource {
  getSeason(tenantId: string, seasonId: string): Promise<SourceSeason | null>;
  listActiveSeasons(tenantId: string, atInstant?: Date): Promise<SourceSeason[]>;
}

export class MockSeasonSource implements SeasonSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for SeasonSource operations');
    }
  }

  async getSeason(tenantId: string, seasonId: string): Promise<SourceSeason | null> {
    this.validateTenant(tenantId);
    const doc: any = await SrcSeasonModel.findOne({ tenantId, seasonId }).lean();
    if (!doc) return null;
    const relId = doc.releaseId || doc.collectionId;
    let collection: any = null;
    if (relId) {
      collection = await SrcCollectionModel.findOne({ tenantId, releaseId: relId }).lean();
    }
    return toSourceSeason(doc as any, collection);
  }

  async listActiveSeasons(tenantId: string, atInstant?: Date): Promise<SourceSeason[]> {
    this.validateTenant(tenantId);
    const now = atInstant || clock.now();
    const docs = await SrcSeasonModel.find({
      tenantId,
      status: 'ACTIVE',
      validFrom: { $lte: now },
      validUntil: { $gte: now },
    }).lean();

    return Promise.all(
      docs.map(async (doc) => {
        const relId = doc.releaseId || doc.collectionId;
        let collection: any = null;
        if (relId) {
          collection = await SrcCollectionModel.findOne({ tenantId, releaseId: relId }).lean();
        }
        return toSourceSeason(doc as any, collection);
      })
    );
  }
}

export const mockSeasonSource = new MockSeasonSource();
