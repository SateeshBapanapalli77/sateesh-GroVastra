import {
  CampaignValidationItem,
  CampaignValidationReport,
  CampaignVersion,
  ALLOWED_BINDING_SOURCES,
  isValidBookingLinkUrl,
  PRODUCT_CATEGORIES,
} from '@grovastra/shared';
import { mockTemplateSource } from '../adapters';
import { BranchModel } from '../db/models/branch.model';
import { isValidIANATimezone } from '@grovastra/shared';
import { validateAudience } from './audience';
import { validateTemplateMapping } from '../templates';
import { campaignSettingsService } from './campaign-settings.service';

export class CampaignValidationService {
  /**
   * Validates a campaign draft against the full specification matrix (spec p7-8, p20).
   * Returns structured errors and warnings with fieldPath and resolutionOwner.
   */
  async validateDraft(
    tenantId: string,
    draft: CampaignVersion,
    isActivation = false
  ): Promise<CampaignValidationReport> {
    const errors: CampaignValidationItem[] = [];
    const warnings: CampaignValidationItem[] = [];

    const settings = await campaignSettingsService.getSettings(tenantId);

    // 1. Campaign Name validation (3-100 characters)
    if (!draft.name || draft.name.trim().length < 3 || draft.name.trim().length > 100) {
      errors.push({
        fieldPath: 'name',
        message: 'Campaign name must be between 3 and 100 characters',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }

    // 2. Branch scope validation
    if (!draft.enabledBranches || draft.enabledBranches.length === 0) {
      errors.push({
        fieldPath: 'enabledBranches',
        message: 'At least one store branch must be selected in campaign scope',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    } else {
      const activeBranches = await BranchModel.find({
        tenantId,
        branchId: { $in: draft.enabledBranches },
        status: 'active',
      }).lean();

      const activeBranchIds = new Set(activeBranches.map((b) => b.branchId));
      for (const branchId of draft.enabledBranches) {
        if (!activeBranchIds.has(branchId)) {
          errors.push({
            fieldPath: 'enabledBranches',
            message: `Unauthorized or invalid branch reference '${branchId}' in campaign scope`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    // Determine campaign preset identity
    const isWelcome =
      ['welcome_new_customer', 'WELCOME_NEW_CUSTOMER'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft as any).name?.toLowerCase().includes('welcome') ||
      draft.steps?.some((s: any) => s.stepId?.toLowerCase().includes('welcome') || s.templateRef?.id?.toLowerCase().includes('welcome'));

    const isRepeatPurchase =
      !isWelcome &&
      (
        ['FIRST_TO_SECOND_PURCHASE', 'first_to_second_purchase', 'second_purchase'].includes(
          (draft as any).presetId || ''
        ) ||
        (draft as any).name?.toLowerCase().includes('bring back') ||
        (draft as any).name?.toLowerCase().includes('second') ||
        draft.trigger?.anchor === 'FIRST_QUALIFYING_ORDER' ||
        draft.trigger?.anchor === 'FIRST_ORDER_COMPLETED' ||
        draft.steps?.some((s: any) => s.stepId?.toLowerCase().includes('bring_back') || s.templateRef?.id?.toLowerCase().includes('repeat'))
      );

    const isEnquiry =
      ['unresolved_enquiry', 'UNRESOLVED_ENQUIRY', 'enquiry', 'ENQUIRY'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft.trigger as any)?.type === 'ENQUIRY_EVENT_DELAY' ||
      ((draft.trigger as any)?.type === 'EVENT_DELAY' && (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION');

    const isOutfit =
      ['complete_the_outfit', 'COMPLETE_THE_OUTFIT', 'outfit_completion', 'OUTFIT_COMPLETION'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft.trigger as any)?.type === 'ORDER_EVENT_DELAY' ||
      ((draft.trigger as any)?.type === 'EVENT_DELAY' && (draft.trigger as any)?.anchor === 'ORDER_COMPLETED_AT');

    const isRequestedItem =
      ['requested_item_available', 'REQUESTED_ITEM_AVAILABLE', 'request_stock_available', 'REQUEST_STOCK_AVAILABLE'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft.trigger as any)?.type === 'REQUEST_STOCK_AVAILABLE' ||
      ((draft.trigger as any)?.type === 'EVENT_DELAY' && (draft.trigger as any)?.anchor === 'STOCK_PUBLISHED_AT');

    const isMatchingCollection =
      ['matching_collection', 'MATCHING_COLLECTION'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft.trigger as any)?.type === 'COLLECTION_PUBLICATION';
    const isSelectedStock =
      ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'].includes((draft as any).presetId || '') ||
      (draft.trigger as any)?.type === 'OFFER_PUBLICATION';
    const isFestivalCollection =
      ['festival_collection', 'FESTIVAL_COLLECTION', 'festival'].includes((draft as any).presetId || '') ||
      (draft.trigger as any)?.type === 'OWNER_DATED_EVENT' ||
      (draft.trigger as any)?.type === 'FESTIVAL_SEASON';
    const isFittingAlteration =
      ['fitting_alteration', 'FITTING_ALTERATION', 'fitting', 'alteration', 'fitting_appointment', 'alteration_milestone'].includes(
        (draft as any).presetId || ''
      ) ||
      (draft.trigger as any)?.type === 'APPOINTMENT' ||
      (draft.trigger as any)?.type === 'PRODUCTION_MILESTONE';

    // 2.5. Reject removed triggerMode field
    if ((draft as any).triggerMode !== undefined) {
      errors.push({
        fieldPath: 'triggerMode',
        message: 'Field triggerMode is no longer supported',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }

    // 2.6. Validate minFirstOrderNetPaise (only for Welcome order mode)
    if (isWelcome && (draft as any).minFirstOrderNetPaise !== undefined) {
      const minNet = (draft as any).minFirstOrderNetPaise;
      if (typeof minNet !== 'number' || minNet < 0 || minNet > 100000000 || !Number.isInteger(minNet)) {
        errors.push({
          fieldPath: 'minFirstOrderNetPaise',
          message: 'minFirstOrderNetPaise must be an integer between 0 and 100000000 paise',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    }

    // 2.7. Validate usefulForDays and goalMode for Enquiry
    if (isEnquiry) {
      if ((draft as any).usefulForDays !== undefined) {
        const u = (draft as any).usefulForDays;
        if (typeof u !== 'number' || !Number.isInteger(u) || u < 1 || u > 60) {
          errors.push({
            fieldPath: 'usefulForDays',
            message: 'usefulForDays must be an integer between 1 and 60 days',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
      if ((draft as any).goalMode !== undefined) {
        const gm = (draft as any).goalMode;
        if (!['ITEM_OR_TAGGED', 'TAGGED_ONLY', 'ANY_QUALIFYING_ORDER'].includes(gm)) {
          errors.push({
            fieldPath: 'goalMode',
            message: `Invalid goalMode '${gm}'. Supported: ITEM_OR_TAGGED, TAGGED_ONLY, ANY_QUALIFYING_ORDER`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else if (gm === 'ANY_QUALIFYING_ORDER') {
          warnings.push({
            fieldPath: 'goalMode',
            message: 'ANY_QUALIFYING_ORDER may stop the sequence for unrelated purchases by this customer (spec p11)',
            code: 'ANY_QUALIFYING_ORDER',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    // 2.75. Validate stockAvailabilityWindowDays and goalMode for Requested Item Available (F25)
    if (isRequestedItem) {
      if ((draft as any).stockAvailabilityWindowDays !== undefined) {
        const sw = (draft as any).stockAvailabilityWindowDays;
        if (typeof sw !== 'number' || !Number.isInteger(sw) || sw < 1 || sw > 60) {
          errors.push({
            fieldPath: 'stockAvailabilityWindowDays',
            message: 'stockAvailabilityWindowDays must be an integer between 1 and 60 days',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
      if ((draft as any).goalMode !== undefined) {
        const gm = (draft as any).goalMode;
        if (!['ITEM_OR_TAGGED', 'TAGGED_ONLY', 'ANY_QUALIFYING_ORDER'].includes(gm)) {
          errors.push({
            fieldPath: 'goalMode',
            message: `Invalid goalMode '${gm}'. Supported: ITEM_OR_TAGGED, TAGGED_ONLY, ANY_QUALIFYING_ORDER`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    // 2.76. Validate minAffinityScore for Matching Collection (F26)
    if (isMatchingCollection && (draft as any).minAffinityScore !== undefined) {
      const mas = (draft as any).minAffinityScore;
      if (typeof mas !== 'number' || mas < 0.0 || mas > 1.0) {
        errors.push({
          fieldPath: 'minAffinityScore',
          message: 'minAffinityScore must be a number between 0.0 and 1.0',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      if (isSelectedStock) {
        const audienceMode = (draft as any).audience?.mode || 'PREFERENCE_MATCH';
        const matchMode = (draft as any).matchMode || 'STRICT';
        const goalMode = (draft as any).goalMode || 'OFFER_ITEM_OR_TAGGED';
        if (!['PREFERENCE_MATCH', 'ALL_ELIGIBLE'].includes(audienceMode)) {
          errors.push({ fieldPath: 'audience.mode', message: 'Invalid selected-stock audience mode', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        if (audienceMode === 'ALL_ELIGIBLE' && (draft as any).audience?.mode !== 'ALL_ELIGIBLE') {
          errors.push({ fieldPath: 'audience.mode', message: 'ALL_ELIGIBLE must be explicitly selected', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        if (!['STRICT', 'BROAD'].includes(matchMode) || (matchMode === 'BROAD' && audienceMode !== 'PREFERENCE_MATCH')) {
          errors.push({ fieldPath: 'matchMode', message: 'matchMode must be STRICT or BROAD, and BROAD requires PREFERENCE_MATCH', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        if (!['OFFER_ITEM_OR_TAGGED', 'TAGGED_ONLY'].includes(goalMode)) {
          errors.push({ fieldPath: 'goalMode', message: 'Invalid selected-stock goalMode', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        const maxItems = (draft as any).maxItemsInMessage ?? 3;
        const maxRecipients = (draft as any).maxRecipientsPerOffer ?? 1000;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3) errors.push({ fieldPath: 'maxItemsInMessage', message: 'maxItemsInMessage must be an integer from 1 to 3', resolutionOwner: 'BOUTIQUE_OWNER' });
        if (!Number.isInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 100000) errors.push({ fieldPath: 'maxRecipientsPerOffer', message: 'maxRecipientsPerOffer must be an integer from 1 to 100000', resolutionOwner: 'BOUTIQUE_OWNER' });
        if (maxRecipients > 10000) warnings.push({ fieldPath: 'maxRecipientsPerOffer', message: 'Large selected-stock audience; verify the recipient limit', code: 'RECIPIENT_LIMIT_WARNING', resolutionOwner: 'BOUTIQUE_OWNER' });
      }

      if (isFestivalCollection) {
        const audienceMode = (draft as any).audience?.mode || 'ALL_ELIGIBLE';
        const matchMode = (draft as any).matchMode || 'STRICT';
        if (!['PREFERENCE_MATCH', 'ALL_ELIGIBLE'].includes(audienceMode)) {
          errors.push({ fieldPath: 'audience.mode', message: 'Invalid festival audience mode', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        if (!['STRICT', 'BROAD', 'LENIENT'].includes(matchMode)) {
          errors.push({ fieldPath: 'matchMode', message: 'matchMode must be STRICT or LENIENT', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
        const maxItems = (draft as any).maxItemsInMessage ?? 3;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 3) {
          errors.push({ fieldPath: 'maxItemsInMessage', message: 'maxItemsInMessage must be an integer from 1 to 3', resolutionOwner: 'BOUTIQUE_OWNER' });
        }
      }
    }

    // 2.8. Validate pairing and goalMode for Complete the Outfit (F24)
    if (isOutfit) {
      const pairing = (draft as any).pairing || (draft as any).config?.pairing;
      if (pairing) {
        if (pairing.anchorCategories !== undefined) {
          if (!Array.isArray(pairing.anchorCategories) || pairing.anchorCategories.length === 0) {
            errors.push({
              fieldPath: 'pairing.anchorCategories',
              message: 'At least one anchor category must be specified',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          } else {
            for (const cat of pairing.anchorCategories) {
              if (!PRODUCT_CATEGORIES.includes(cat as any)) {
                errors.push({
                  fieldPath: 'pairing.anchorCategories',
                  message: `Unknown anchor category '${cat}'. Must be one of: ${PRODUCT_CATEGORIES.join(', ')}`,
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            }
          }
        }

        if (pairing.complementMap !== undefined) {
          if (typeof pairing.complementMap !== 'object' || pairing.complementMap === null) {
            errors.push({
              fieldPath: 'pairing.complementMap',
              message: 'complementMap must be an object mapping anchor categories to complement categories',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          } else {
            const anchorCats = pairing.anchorCategories || ['saree'];
            for (const anchorCat of anchorCats) {
              const complements = pairing.complementMap[anchorCat];
              if (!Array.isArray(complements) || complements.length === 0) {
                errors.push({
                  fieldPath: `pairing.complementMap.${anchorCat}`,
                  message: `Anchor category '${anchorCat}' must have at least one complement category defined in complementMap`,
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else {
                for (const compCat of complements) {
                  if (!PRODUCT_CATEGORIES.includes(compCat as any)) {
                    errors.push({
                      fieldPath: `pairing.complementMap.${anchorCat}`,
                      message: `Unknown complement category '${compCat}'. Must be one of: ${PRODUCT_CATEGORIES.join(', ')}`,
                      resolutionOwner: 'BOUTIQUE_OWNER',
                    });
                  }
                }
              }
            }
          }
        }

        if (pairing.colourMatch !== undefined) {
          if (!['ANY', 'SAME_FAMILY', 'NEUTRAL_OR_SAME'].includes(pairing.colourMatch)) {
            errors.push({
              fieldPath: 'pairing.colourMatch',
              message: `Invalid colourMatch '${pairing.colourMatch}'. Supported: ANY, SAME_FAMILY, NEUTRAL_OR_SAME`,
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }

        if (pairing.alreadyOwnedLookbackDays !== undefined) {
          const lbd = pairing.alreadyOwnedLookbackDays;
          if (typeof lbd !== 'number' || !Number.isInteger(lbd) || lbd < 0 || lbd > 730) {
            errors.push({
              fieldPath: 'pairing.alreadyOwnedLookbackDays',
              message: 'alreadyOwnedLookbackDays must be an integer between 0 and 730 days',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }
      }

      if ((draft as any).minDaysBetweenEnrollments !== undefined) {
        const md = (draft as any).minDaysBetweenEnrollments;
        if (typeof md !== 'number' || !Number.isInteger(md) || md < 0 || md > 365) {
          errors.push({
            fieldPath: 'minDaysBetweenEnrollments',
            message: 'minDaysBetweenEnrollments must be an integer between 0 and 365 days',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      const gm = (draft as any).goalMode || (draft as any).config?.goalMode;
      if (gm !== undefined) {
        if (!['COMPLEMENT_OR_TAGGED', 'TAGGED_ONLY'].includes(gm)) {
          errors.push({
            fieldPath: 'goalMode',
            message: `Invalid goalMode '${gm}'. Supported: COMPLEMENT_OR_TAGGED, TAGGED_ONLY`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else if (gm === 'TAGGED_ONLY') {
          warnings.push({
            fieldPath: 'goalMode',
            message: 'Campaign will not stop automatically on complement purchase without an explicit outfit tag',
            code: 'GOAL_MODE_TAGGED_ONLY',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    // 3. Trigger validation
    // matching_collection has an implicit trigger (collection.published event); no trigger config needed.
    if (!draft.trigger && !isMatchingCollection) {
      errors.push({
        fieldPath: 'trigger',
        message: 'Trigger configuration is required',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    } else if (draft.trigger?.type === 'ANNUAL_DATE') {
      if (!['customer.birthday', 'customer.event'].includes(draft.trigger.field || '')) {
        errors.push({
          fieldPath: 'trigger.field',
          message: `Invalid trigger date field '${draft.trigger.field}'. Must be customer.birthday or customer.event`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      if (!['FEB_28', 'MAR_01', 'LEAP_ONLY'].includes(draft.trigger.leapDayPolicy || '')) {
        errors.push({
          fieldPath: 'trigger.leapDayPolicy',
          message: 'Explicit leap-day policy (FEB_28, MAR_01, or LEAP_ONLY) is required',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (draft.trigger?.type === 'INACTIVITY_THRESHOLD') {
      const thresholdDays = draft.trigger.thresholdDays;
      if (typeof thresholdDays !== 'number' || thresholdDays <= 0 || !Number.isInteger(thresholdDays)) {
        errors.push({
          fieldPath: 'trigger.thresholdDays',
          message: 'Inactivity threshold (thresholdDays) must be a positive integer of days (e.g. 90 or 180)',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (draft.trigger?.type === 'ENQUIRY_EVENT_DELAY') {
      const allowedAnchors = ['ENQUIRY_LAST_INTERACTION'];
      if ((draft.trigger as any).anchor && !allowedAnchors.includes((draft.trigger as any).anchor)) {
        errors.push({
          fieldPath: 'trigger.anchor',
          message: `Invalid trigger anchor '${(draft.trigger as any).anchor}'. Supported: ${allowedAnchors.join(', ')}`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (draft.trigger?.type === 'EVENT_DELAY') {
      const allowedAnchors = [
        'FIRST_QUALIFYING_ORDER',
        'CREDIT_EXPIRY_APPROACHING',
        'CREDIT_ISSUED',
        'ENQUIRY_LAST_INTERACTION',
      ];
      if (!allowedAnchors.includes((draft.trigger as any).anchor)) {
        errors.push({
          fieldPath: 'trigger.anchor',
          message: `Invalid trigger anchor '${(draft.trigger as any).anchor}'. Supported: ${allowedAnchors.join(', ')}`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (draft.trigger?.type === 'CUSTOMER_EVENT_DATE') {
      if (!['GIFT', 'WEDDING'].includes(draft.trigger.occasionKind || '')) {
        errors.push({
          fieldPath: 'trigger.occasionKind',
          message: "occasionKind is required and must be either 'GIFT' or 'WEDDING'",
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
      const leadDays = draft.trigger.fulfillmentLeadDays;
      if (typeof leadDays !== 'number' || leadDays < 0 || leadDays > 180 || !Number.isInteger(leadDays)) {
        errors.push({
          fieldPath: 'trigger.fulfillmentLeadDays',
          message: 'fulfillmentLeadDays must be an integer between 0 and 180 days',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (draft.trigger?.type === 'REQUEST_STOCK_AVAILABLE') {
      const allowedAnchors = ['STOCK_PUBLISHED_AT'];
      if ((draft.trigger as any).anchor && !allowedAnchors.includes((draft.trigger as any).anchor)) {
        errors.push({
          fieldPath: 'trigger.anchor',
          message: `Invalid trigger anchor '${(draft.trigger as any).anchor}'. Supported: ${allowedAnchors.join(', ')}`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else if (isMatchingCollection || (draft.trigger as any)?.type === 'COLLECTION_PUBLICATION') {
      // COLLECTION_PUBLICATION trigger is implicit for matching_collection — no extra fields to validate.
      // The trigger fires when a collection.published event is received by the event consumer.
    } else if (draft.trigger) {
      errors.push({
        fieldPath: 'trigger.type',
        message: `Trigger type '${(draft.trigger as any).type}' is not supported. Supported: ANNUAL_DATE, INACTIVITY_THRESHOLD, EVENT_DELAY, ENQUIRY_EVENT_DELAY, CUSTOMER_EVENT_DATE, REQUEST_STOCK_AVAILABLE, COLLECTION_PUBLICATION`,
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }

    // 4. Timezone validation
    const effectiveTimezone = draft.timezone || 'Asia/Kolkata';
    if (!isValidIANATimezone(effectiveTimezone)) {
      errors.push({
        fieldPath: 'timezone',
        message: `Invalid IANA timezone: '${draft.timezone || ''}'`,
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }

    // 4.5. Audience rules validation (Spec p10)
    // For matching_collection, audience defaults to ALL_ELIGIBLE when omitted
    if (draft.audience || !isMatchingCollection) {
      const audienceValidation = validateAudience(draft.audience);
      if (!audienceValidation.valid) {
        for (const err of audienceValidation.errors) {
          errors.push({
            fieldPath: err.fieldPath,
            message: err.message,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    // 5. Steps validation (1 to 3 steps)
    const steps = draft.steps || [];
    if (steps.length < 1 || steps.length > 3) {
      errors.push({
        fieldPath: 'steps',
        message: `Campaign must have between 1 and 3 steps (found ${steps.length})`,
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }

    const seenStepIds = new Set<string>();

    const isEventDelay =
      isMatchingCollection ||
      isRequestedItem ||
      (draft.trigger as any)?.type === 'EVENT_DELAY' ||
      (draft.trigger as any)?.type === 'ENQUIRY_EVENT_DELAY' ||
      (draft.trigger as any)?.type === 'ORDER_EVENT_DELAY' ||
      (draft.trigger as any)?.type === 'REQUEST_STOCK_AVAILABLE' ||
      (draft.trigger as any)?.type === 'COLLECTION_PUBLICATION';
    let prevTotalDelayHours = -1;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const prefix = `steps[${i}]`;

      // Stable stepId
      if (!step.stepId || !step.stepId.trim()) {
        errors.push({
          fieldPath: `${prefix}.stepId`,
          message: `Step ${i + 1} must have a stable non-empty stepId`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      } else if (seenStepIds.has(step.stepId.trim())) {
        errors.push({
          fieldPath: `${prefix}.stepId`,
          message: `Duplicate stepId '${step.stepId}'. Step identifiers must be unique and stable`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      } else {
        seenStepIds.add(step.stepId.trim());
      }

      if (isEventDelay) {
        // Event delay timing validation
        const delay = (step as any).delay;
        if (!delay || typeof delay !== 'object') {
          errors.push({
            fieldPath: `${prefix}.delay`,
            message: 'Delay specification is required (unit and value)',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else {
          if (!['MINUTES', 'HOURS', 'DAYS'].includes(delay.unit)) {
            errors.push({
              fieldPath: `${prefix}.delay.unit`,
              message: 'Delay unit must be MINUTES, HOURS, or DAYS',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (typeof delay.value !== 'number' || delay.value < 0) {
            errors.push({
              fieldPath: `${prefix}.delay.value`,
              message: 'Delay value cannot be negative',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          } else {
            if (isOutfit) {
              if (delay.unit === 'MINUTES') {
                errors.push({
                  fieldPath: `${prefix}.delay.unit`,
                  message: 'Delay unit for complete the outfit campaign must be HOURS or DAYS',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else if (delay.unit === 'HOURS' && (delay.value < 1 || delay.value > 720)) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: 'Delay in hours must be between 1 and 720 hours',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else if (delay.unit === 'DAYS' && (delay.value < 1 || delay.value > 60)) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: 'Delay in days must be between 1 and 60 days',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            } else if (isEnquiry) {
              if (delay.unit === 'MINUTES') {
                errors.push({
                  fieldPath: `${prefix}.delay.unit`,
                  message: 'Delay unit for enquiry campaign must be HOURS or DAYS',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else if (delay.unit === 'HOURS' && (delay.value < 1 || delay.value > 720)) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: 'Delay in hours must be between 1 and 720 hours',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else if (delay.unit === 'DAYS' && (delay.value < 1 || delay.value > 30)) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: 'Delay in days must be between 1 and 30 days',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            } else {
              const maxHours = isRepeatPurchase ? 8760 : 168;
              const maxDays = isRepeatPurchase ? 365 : 30;

              if (delay.unit === 'MINUTES' && delay.value > 1440) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: 'Delay in minutes cannot exceed 1440 minutes (24 hours)',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
              if (delay.unit === 'HOURS' && delay.value > maxHours) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: isRepeatPurchase
                    ? 'Delay in hours cannot exceed 8760 hours (365 days)'
                    : 'Delay in hours cannot exceed 168 hours (7 days)',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
              if (delay.unit === 'DAYS' && delay.value > maxDays) {
                errors.push({
                  fieldPath: `${prefix}.delay.value`,
                  message: isRepeatPurchase
                    ? 'Delay in days cannot exceed 365 days'
                    : 'Delay in days cannot exceed 30 days',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            }

            const currentTotalHours =
              delay.unit === 'MINUTES' ? delay.value / 60 : delay.unit === 'DAYS' ? delay.value * 24 : delay.value;
            if (i > 0 && currentTotalHours <= prevTotalDelayHours) {
              errors.push({
                fieldPath: `${prefix}.delay`,
                message: `Step ${i + 1} delay (${currentTotalHours}h) must be strictly greater than step ${i} delay (${prevTotalDelayHours}h)`,
                resolutionOwner: 'BOUTIQUE_OWNER',
              });
            }
            prevTotalDelayHours = currentTotalHours;
          }
        }

        if ((step as any).maxDeferralHours !== undefined) {
          const maxDef = (step as any).maxDeferralHours;
          if (typeof maxDef !== 'number' || maxDef < 0 || maxDef > 48) {
            errors.push({
              fieldPath: `${prefix}.maxDeferralHours`,
              message: 'maxDeferralHours must be between 0 and 48 hours',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }

        if ((step as any).outsideHoursPolicy === 'DEFER_NEXT_DAY') {
          const textToCheck: string[] = [];
          if (step.bindings) {
            for (const b of Object.values(step.bindings)) {
              if (typeof b === 'object' && b && (b as any).value) {
                textToCheck.push(String((b as any).value));
              }
            }
          }
          const combinedText = textToCheck.join(' ').toLowerCase();
          if (combinedText.includes('today') || combinedText.includes('tonight')) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message: 'Template text references "today" or "tonight" while outside-hours policy is DEFER_NEXT_DAY. The recipient may receive this message the next morning.',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }

        let hasOfferBinding = false;
        if (step.bindings) {
          for (const b of Object.values(step.bindings)) {
            const src = typeof b === 'string' ? b : (b as any)?.source;
            if (src === 'offer.amountRupees') {
              hasOfferBinding = true;
              break;
            }
          }
        }
        if (hasOfferBinding && !(step as any).offerRef?.offerId) {
          errors.push({
            fieldPath: `${prefix}.offerRef`,
            message: 'offerRef is required when offer bindings or variables are present',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      } else {
        // Strictly increasing offsets for date-based campaigns
        const currentOffset = step.offsetDays;
        const prevOffset = steps[i - 1]?.offsetDays;
        if (i > 0 && currentOffset !== undefined && prevOffset !== undefined && currentOffset <= prevOffset) {
          errors.push({
            fieldPath: `${prefix}.offsetDays`,
            message: `Step offsets must be strictly increasing: step ${i + 1} offset (${currentOffset}) is not greater than step ${i} offset (${prevOffset})`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }

        if (draft.trigger?.type === 'CUSTOMER_EVENT_DATE') {
          if (step.offsetDays === undefined || step.offsetDays >= 0 || step.offsetDays < -365) {
            errors.push({
              fieldPath: `${prefix}.offsetDays`,
              message: 'Step offsetDays must be a negative integer between -365 and -1 days',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }

        // Local time format (HH:mm)
        if (!step.localTime || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(step.localTime)) {
          errors.push({
            fieldPath: `${prefix}.localTime`,
            message: `Step localTime must be in HH:mm 24-hour format (e.g. 10:00)`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else if (settings?.allowedSendingHours) {
          const { start, end } = settings.allowedSendingHours;
          if (step.localTime < start || step.localTime >= end) {
            warnings.push({
              fieldPath: `${prefix}.localTime`,
              message: `Step localTime '${step.localTime}' is outside tenant allowed sending hours (${start} - ${end}). Messages will be adjusted at dispatch.`,
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }
      }

      // Prerequisite
      if (i === 0 && step.prerequisite === 'PREVIOUS_ACCEPTED') {
        errors.push({
          fieldPath: `${prefix}.prerequisite`,
          message: 'First campaign step cannot require PREVIOUS_ACCEPTED',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      // Stop conditions
      if (step.stopOnReply !== undefined && typeof step.stopOnReply !== 'boolean') {
        errors.push({
          fieldPath: `${prefix}.stopOnReply`,
          message: 'stopOnReply must be explicitly defined as true or false',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
      if (step.stopOnGoal !== undefined && typeof step.stopOnGoal !== 'boolean') {
        errors.push({
          fieldPath: `${prefix}.stopOnGoal`,
          message: 'stopOnGoal must be explicitly defined as true or false',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      // maxLatenessMinutes (for date/calendar campaigns; event delay presets default it)
      if (!isEventDelay && (!step.maxLatenessMinutes || step.maxLatenessMinutes <= 0)) {
        errors.push({
          fieldPath: `${prefix}.maxLatenessMinutes`,
          message: 'maxLatenessMinutes must be a positive integer',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      // 6. Template reference & Catalogue verification
      const templateId =
        typeof step.templateRef === 'string'
          ? step.templateRef
          : step.templateRef?.id;

      if (!templateId) {
        errors.push({
          fieldPath: `${prefix}.templateRef`,
          message: 'Approved WhatsApp template reference is required for step',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      } else {
        const template = await mockTemplateSource.getTemplateById(templateId);
        if (!template) {
          errors.push({
            fieldPath: `${prefix}.templateRef.id`,
            message: `Template '${templateId}' was not found in the approved template catalogue`,
            resolutionOwner: 'INTEGRATION_DEVELOPER',
          });
        } else if (typeof step.templateRef === 'object' && step.templateRef !== null) {
          // Exact revision check
          if (step.templateRef.revision !== undefined && step.templateRef.revision !== template.revision) {
            errors.push({
              fieldPath: `${prefix}.templateRef.revision`,
              message: `Template revision mismatch: step references revision ${step.templateRef.revision}, but catalogue has revision ${template.revision}`,
              resolutionOwner: 'INTEGRATION_DEVELOPER',
            });
          }

          // Exact language check
          if (step.templateRef.language && step.templateRef.language !== template.language) {
            errors.push({
              fieldPath: `${prefix}.templateRef.language`,
              message: `Template language mismatch: step references '${step.templateRef.language}', but catalogue has '${template.language}'`,
              resolutionOwner: 'INTEGRATION_DEVELOPER',
            });
          }

          // Sendable check (warning in draft)
          if (!template.sendable) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message: 'dummy template: cannot be sent',
              resolutionOwner: 'INTEGRATION_DEVELOPER',
            });
          }

          // Category rule: MARKETING campaigns require MARKETING templates
          if (template.category !== 'MARKETING') {
            const isDevMismatchAllowed =
              process.env.ALLOW_TEST_CATEGORY_MISMATCH === 'true' &&
              process.env.NODE_ENV !== 'production';

            if (isDevMismatchAllowed) {
              warnings.push({
                fieldPath: `${prefix}.templateRef.category`,
                message: `TEST ONLY: category mismatch - template category is ${template.category} (permitted in dev mode only)`,
                resolutionOwner: 'INTEGRATION_DEVELOPER',
              });
            } else {
              errors.push({
                fieldPath: `${prefix}.templateRef.category`,
                message: `Category mismatch: marketing campaigns require MARKETING templates, but '${template.name}' is '${template.category}'`,
                resolutionOwner: 'INTEGRATION_DEVELOPER',
              });
            }
          }

          // Check for 'today' or 'tonight' warning with DEFER_NEXT_DAY policy
          const outsideHoursPolicy = (step as any).outsideHoursPolicy || 'DEFER_NEXT_DAY';
          if (outsideHoursPolicy === 'DEFER_NEXT_DAY' && template.bodyText) {
            const bodyLower = template.bodyText.toLowerCase();
            if (bodyLower.includes('today') || bodyLower.includes('tonight')) {
              warnings.push({
                fieldPath: `${prefix}.templateRef`,
                message: "Template text contains 'today' or 'tonight', which may be inaccurate when messages are deferred to the next day",
                resolutionOwner: 'BOUTIQUE_OWNER',
              });
            }
          }

          // Check for reservation wording (spec p13)
          const reservationWordingRegex = /\b(reserved|reserve|held for you|kept aside|on hold for you|guarantee)\b/i;
          if (template.bodyText && reservationWordingRegex.test(template.bodyText)) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message:
                'Template text contains reservation phrasing ("reserved", "reserve", "held for you", "kept aside", "on hold for you", or "guarantee"). A follow-up message must never imply a reservation (spec p13).',
              code: 'RESERVATION_WORDING',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }

          // Check for scarcity wording (spec p8)
          const scarcityRegex = /\b(limited stock|only \d+ left|hurry|last piece|selling fast|last chance)\b/i;
          if (template.bodyText && scarcityRegex.test(template.bodyText)) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message:
                'Template text contains artificial scarcity phrasing ("limited stock", "only N left", "hurry", "last piece", "selling fast", "last chance"). Marketing messages must never fabricate scarcity (spec p8).',
              code: 'SCARCITY_WORDING',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (isSelectedStock && template.bodyText && /\b(lowest price|best price|guaranteed price|price match|biggest sale|flat)\b/i.test(template.bodyText)) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message: 'Template text contains an unsupported price claim; use only the authoritative offer bindings.',
              code: 'PRICE_CLAIM_WORDING',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (isSelectedStock && template.bodyText && /\b(in stock|available now|available)\b/i.test(template.bodyText)) {
            warnings.push({
              fieldPath: `${prefix}.templateRef`,
              message: 'Stock wording must be resolved from current inventory at dispatch.',
              code: 'STOCK_CLAIM_WORDING',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }

          // Complete the Outfit binding checks
          if (isOutfit) {
            let hasComplementBinding = false;
            const complementSlots = new Set<number>();

            if (step.bindings && typeof step.bindings === 'object') {
              for (const [key, b] of Object.entries(step.bindings)) {
                const src = typeof b === 'string' ? b : (b as any)?.source;
                const fallback = typeof b === 'object' ? (b as any)?.fallbackLiteral : undefined;

                if (src && typeof src === 'string') {
                  if (src.startsWith('complement.')) {
                    hasComplementBinding = true;
                    const match = src.match(/^complement\.(\d+)\.name$/);
                    if (match) {
                      complementSlots.add(Number(match[1]));
                    }
                    if (fallback && typeof fallback === 'string' && fallback.trim()) {
                      errors.push({
                        fieldPath: `${prefix}.bindings.${key}.fallbackLiteral`,
                        message: 'fallbackLiteral is not permitted for product complement sources',
                        code: 'FALLBACK_NOT_ALLOWED',
                        resolutionOwner: 'BOUTIQUE_OWNER',
                      });
                    }
                  } else if (src === 'anchor.itemName') {
                    if (fallback && typeof fallback === 'string' && fallback.trim()) {
                      errors.push({
                        fieldPath: `${prefix}.bindings.${key}.fallbackLiteral`,
                        message: 'fallbackLiteral is not permitted for anchor item source',
                        code: 'FALLBACK_NOT_ALLOWED',
                        resolutionOwner: 'BOUTIQUE_OWNER',
                      });
                    }
                  }
                }
              }
            }

            if (!hasComplementBinding) {
              errors.push({
                fieldPath: `${prefix}.bindings`,
                message:
                  'Complete the outfit campaign requires at least one complement binding (complement.1.name, etc.)',
                code: 'COMPLEMENT_BINDING_REQUIRED',
                resolutionOwner: 'BOUTIQUE_OWNER',
              });
            } else {
              const slotsArray = Array.from(complementSlots).sort((a, b) => a - b);
              if (
                slotsArray.length > 3 ||
                (slotsArray.length > 0 && slotsArray[slotsArray.length - 1] > 3)
              ) {
                errors.push({
                  fieldPath: `${prefix}.bindings`,
                  message:
                    'At most 3 complement slots (complement.1, complement.2, complement.3) are supported',
                  code: 'COMPLEMENT_SLOTS_EXCEEDED',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
              const maxSlot = slotsArray.length > 0 ? slotsArray[slotsArray.length - 1] : 0;
              for (let s = 1; s <= maxSlot; s++) {
                if (!complementSlots.has(s)) {
                  errors.push({
                    fieldPath: `${prefix}.bindings`,
                    message: `Complement slots must be consecutive starting from complement.1.name (missing slot ${s})`,
                    code: 'COMPLEMENT_BINDING_GAP',
                    resolutionOwner: 'BOUTIQUE_OWNER',
                  });
                  break;
                }
              }
            }
          }

          // Check ITEM_BINDING_NEEDS_ITEM warning
          if (step.bindings) {
            const usesItemName = Object.values(step.bindings).some((b: any) => {
              const src = typeof b === 'string' ? b : b?.source;
              return src === 'item.name';
            });
            if (usesItemName && (draft as any).requireItem !== true) {
              warnings.push({
                fieldPath: `${prefix}.bindings`,
                message:
                  'Template references item.name but requireItem is false. Enquiries without an item will skip this step or use fallback literal.',
                code: 'ITEM_BINDING_NEEDS_ITEM',
                resolutionOwner: 'BOUTIQUE_OWNER',
              });
            }
          }

          // Infer presetId from draft if not explicitly present
          let stepPresetId = (draft as any).presetId;
          if (!stepPresetId && draft.trigger) {
            if (isOutfit || (draft.trigger as any).type === 'ORDER_EVENT_DELAY') {
              stepPresetId = 'complete_the_outfit';
            } else if (
              isEnquiry ||
              draft.trigger.type === 'ENQUIRY_EVENT_DELAY' ||
              (draft.trigger as any).anchor === 'ENQUIRY_LAST_INTERACTION'
            ) {
              stepPresetId = 'unresolved_enquiry';
            } else if (draft.trigger.type === 'EVENT_DELAY') {
              if (isWelcome) {
                stepPresetId = 'welcome_new_customer';
              } else if (isRepeatPurchase || draft.trigger.anchor === 'FIRST_ORDER_COMPLETED' || draft.trigger.anchor === 'FIRST_QUALIFYING_ORDER') {
                stepPresetId = 'first_to_second_purchase';
              }
            } else if (draft.trigger.type === 'ANNUAL_DATE') {
              if (draft.trigger.field === 'customer.birthday') {
                stepPresetId = 'birthday';
              } else if (draft.trigger.field === 'customer.anniversary') {
                stepPresetId = 'anniversary';
              }
            } else if (draft.trigger.type === 'CUSTOMER_EVENT_DATE') {
              stepPresetId = 'gift_wedding_reminder';
            } else if (draft.trigger.type === 'INACTIVITY_THRESHOLD') {
              stepPresetId = 'win_back';
            } else if (
              isRequestedItem ||
              draft.trigger.type === 'REQUEST_STOCK_AVAILABLE' ||
              (draft.trigger as any).anchor === 'STOCK_PUBLISHED_AT'
            ) {
              stepPresetId = 'requested_item_available';
            }
          }

          // Check shop.bookingLink requires bookingLinkUrl in settings on activation
          if (step.bindings) {
            const usesBookingLink = Object.values(step.bindings).some((b: any) => {
              const src = typeof b === 'string' ? b : b?.source;
              return src === 'shop.bookingLink';
            });
            if (isActivation && usesBookingLink) {
              if (!settings?.bookingLinkUrl || !settings.bookingLinkUrl.trim()) {
                errors.push({
                  fieldPath: `${prefix}.bindings`,
                  message: 'shop.bookingLink requires bookingLinkUrl to be configured in campaign settings before activation',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              } else if (!isValidBookingLinkUrl(settings.bookingLinkUrl)) {
                errors.push({
                  fieldPath: `${prefix}.bindings`,
                  message: 'bookingLinkUrl in campaign settings is not a valid HTTP/HTTPS URL',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            }

            // G05: Warning if template copy or literal falsely claims appointment is already booked/confirmed
            const templateBody = (template as any)?.bodyText || (template as any)?.body || '';
            const bookingClaimRegex = /appointment (has been|is) (booked|confirmed)|already booked|we('ve| have) booked an appointment/i;
            if (bookingClaimRegex.test(templateBody)) {
              warnings.push({
                fieldPath: `${prefix}.templateRef`,
                message: 'Template copy falsely claims an appointment is already booked. Booking links must only invite the customer to schedule an appointment.',
                code: 'BOOKING_CLAIM_WORDING_WARNING',
                resolutionOwner: 'BOUTIQUE_OWNER',
              });
            }
            for (const [key, b] of Object.entries(step.bindings)) {
              const val = typeof b === 'string' ? b : (b as any)?.fallbackLiteral || (b as any)?.literalValue || '';
              if (typeof val === 'string' && bookingClaimRegex.test(val)) {
                warnings.push({
                  fieldPath: `${prefix}.bindings.${key}`,
                  message: 'Variable value falsely claims an appointment is already booked. Booking links must only invite the customer to schedule an appointment.',
                  code: 'BOOKING_CLAIM_WORDING_WARNING',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            }
          }

          // Welcome order details warning (spec p33, Hard Rule 8)
          if (isWelcome && step.bindings) {
            for (const [key, b] of Object.entries(step.bindings)) {
              const src = typeof b === 'string' ? b : (b as any)?.source;
              if (src && typeof src === 'string' && src.startsWith('order.')) {
                warnings.push({
                  fieldPath: `${prefix}.bindings.${key}`,
                  message:
                    'Welcome message should not contain order details to avoid exposing purchase details (WELCOME_CONTAINS_ORDER_DETAILS)',
                  resolutionOwner: 'BOUTIQUE_OWNER',
                });
              }
            }
          }

          // 7. Template Variable Mapping, OfferRef & CreditRef validation
          const mappingResult = validateTemplateMapping({
            template: template as any,
            templateRef: step.templateRef,
            bindings: step.bindings,
            presetId: stepPresetId,
            fieldPrefix: prefix,
            offerRef: (step as any).offerRef,
            creditRef: (step as any).creditRef,
            dispatchMode: process.env.DISPATCH_MODE || 'dry',
            isActivation,
            occasionKind: draft.trigger?.occasionKind,
          });

          errors.push(...mappingResult.errors);
          warnings.push(...mappingResult.warnings);
        }
      }
    }

    // Lead time sanity warning for CUSTOMER_EVENT_DATE
    if (draft.trigger?.type === 'CUSTOMER_EVENT_DATE' && steps.length > 0) {
      const leadDays = draft.trigger.fulfillmentLeadDays ?? 0;
      const firstOffset = steps[0].offsetDays;
      if (firstOffset !== undefined && Math.abs(firstOffset) < leadDays) {
        warnings.push({
          fieldPath: 'steps[0].offsetDays',
          message: `First step offset (${firstOffset} days) is shorter than fulfillment lead time (${leadDays} days). Steps will be skipped with INSUFFICIENT_LEAD_TIME for typical event dates.`,
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      notices: warnings,
    } as any;
  }

  async validateVersion(
    tenantId: string,
    version: CampaignVersion,
    settings?: any
  ): Promise<CampaignValidationReport & { notices?: CampaignValidationItem[] }> {
    return this.validateDraft(tenantId, version);
  }
}

export const campaignValidationService = new CampaignValidationService();
