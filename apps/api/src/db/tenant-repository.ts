import mongoose, { Document, FilterQuery, Model, ProjectionType, QueryOptions, UpdateQuery } from 'mongoose';
import { ForbiddenError } from '../errors/app-error';

/**
 * Tenant-scoped repository helper that strictly enforces tenant isolation (Hard Rule #1).
 * Every query, find, mutation, count, and aggregation is forced to include the authenticated tenantId.
 */
export class TenantRepository<T extends Document> {
  public readonly tenantId: string;
  private readonly model: Model<T>;

  constructor(tenantId: string, model: Model<T>) {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('TenantRepository requires a valid non-empty tenantId');
    }
    this.tenantId = tenantId.trim();
    this.model = model;
  }

  /**
   * Asserts that if a filter explicitly includes tenantId, it matches the repository's tenantId.
   */
  private enforceTenantFilter(filter: FilterQuery<T> = {}): FilterQuery<T> {
    if (filter.tenantId && filter.tenantId !== this.tenantId) {
      throw new ForbiddenError(
        `Cross-tenant access violation: requested tenant ${filter.tenantId} does not match authenticated tenant ${this.tenantId}`
      );
    }
    return {
      ...filter,
      tenantId: this.tenantId,
    };
  }

  public find(filter: FilterQuery<T> = {}, projection?: ProjectionType<T> | null, options?: QueryOptions<T> | null) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.find(scopedFilter, projection, options);
  }

  public findOne(filter: FilterQuery<T> = {}, projection?: ProjectionType<T> | null, options?: QueryOptions<T> | null) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.findOne(scopedFilter, projection, options);
  }

  public findById(id: string | mongoose.Types.ObjectId, projection?: ProjectionType<T> | null, options?: QueryOptions<T> | null) {
    return this.model.findOne({ _id: id, tenantId: this.tenantId } as FilterQuery<T>, projection, options);
  }

  public countDocuments(filter: FilterQuery<T> = {}): Promise<number> {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.countDocuments(scopedFilter).exec();
  }

  public async create(docData: Partial<T>): Promise<T> {
    const docWithTenant = {
      ...docData,
      tenantId: this.tenantId,
    };
    const [created] = await this.model.create([docWithTenant]);
    return created;
  }

  public async createMany(docsData: Partial<T>[]): Promise<T[]> {
    const docsWithTenant = docsData.map((d) => ({
      ...d,
      tenantId: this.tenantId,
    }));
    return (await this.model.create(docsWithTenant)) as unknown as T[];
  }

  public updateOne(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options?: any
  ) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.updateOne(scopedFilter, update, options);
  }

  public updateMany(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options?: any
  ) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.updateMany(scopedFilter, update, options);
  }

  public findOneAndUpdate(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    options?: any
  ) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.findOneAndUpdate(scopedFilter, update, options);
  }

  public deleteOne(filter: FilterQuery<T>, options?: any) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.deleteOne(scopedFilter, options);
  }

  public deleteMany(filter: FilterQuery<T>, options?: any) {
    const scopedFilter = this.enforceTenantFilter(filter);
    return this.model.deleteMany(scopedFilter, options);
  }

  public aggregate(pipeline: mongoose.PipelineStage[] = []) {
    // Inject mandatory $match stage at the beginning of pipeline
    const scopedPipeline: mongoose.PipelineStage[] = [
      { $match: { tenantId: this.tenantId } },
      ...pipeline,
    ];
    return this.model.aggregate(scopedPipeline);
  }
}

export function createTenantRepository<T extends Document>(
  tenantId: string,
  model: Model<T>
): TenantRepository<T> {
  return new TenantRepository<T>(tenantId, model);
}

import { CampaignVersionModel, ICampaignVersion } from './models/campaign-version.model';

export class CampaignVersionRepository extends TenantRepository<ICampaignVersion> {
  constructor(tenantId: string) {
    super(tenantId, CampaignVersionModel);
  }

  /**
   * Updates an unpublished draft version. Strictly rejects modifications if the version is already published (Hard Rule 6).
   */
  public async updateDraftVersion(campaignId: string, version: number, update: UpdateQuery<any>) {
    const existing = await this.findOne({ campaignId, version });
    if (!existing) {
      throw new Error(`Campaign version ${version} not found for campaign ${campaignId}`);
    }
    if (existing.isPublished) {
      throw new Error(
        `Campaign version ${version} is published and immutable. Modifications are forbidden.`
      );
    }
    return this.updateOne({ campaignId, version, isPublished: false }, update);
  }
}

export function createCampaignVersionRepository(tenantId: string): CampaignVersionRepository {
  return new CampaignVersionRepository(tenantId);
}

