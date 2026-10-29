import path from 'path';
import dotenv from 'dotenv';
import {
  IntegrationReadinessReport,
  ReadinessFailure,
  ReadinessCheckItem,
  SourceConnection,
} from '@grovastra/shared';
import { mockConnectionSource, mockTemplateSource } from '../adapters';

export const REQUIRED_SETTINGS_NOTICE =
  'This module runs auto campaigns using an existing WhatsApp connection and approved templates. WhatsApp setup and template approval are managed by the integration developer.';

export class ReadinessService {
  /**
   * Evaluates end-to-end integration readiness for automated campaigns.
   * Checks:
   * 1. Connection exists for tenant and is active.
   * 2. Token environment variable specified by secretRef is configured (never returning token value).
   * 3. Sandbox allowlist (META_TEST_ALLOWLIST) is configured with 1-5 verified numbers.
   * 4. At least one sendable template is approved in the catalogue.
   *
   * Returns structured failures with reason codes and designated fixOwners.
   */
  async getTenantReadiness(tenantId: string): Promise<IntegrationReadinessReport> {
    if (process.env.NODE_ENV !== 'test') {
      dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
      dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), override: true });
    }

    const failures: ReadinessFailure[] = [];

    // 1. Connection check
    const connection: SourceConnection | null = await mockConnectionSource.getConnection(tenantId);
    let connectionCheck: ReadinessCheckItem;

    if (!connection) {
      connectionCheck = {
        passed: false,
        message: `No WhatsApp connection record found for tenant '${tenantId}'`,
      };
      failures.push({
        code: 'CONNECTION_NOT_FOUND',
        message: `WhatsApp connection has not been provisioned for tenant '${tenantId}'.`,
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else if (connection.status.toUpperCase() !== 'ACTIVE') {
      connectionCheck = {
        passed: false,
        message: `Connection '${connection.id}' is in status '${connection.status}'`,
      };
      failures.push({
        code: 'CONNECTION_INACTIVE',
        message: `WhatsApp connection '${connection.id}' is not in ACTIVE status (current: ${connection.status}).`,
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else {
      connectionCheck = {
        passed: true,
        message: `Active connection '${connection.id}' (Phone Number ID: ${connection.phoneNumberId})`,
      };
    }

    // 2. Token environment variable check (SecretRef key must exist in process.env; NEVER returned to client)
    let tokenCheck: ReadinessCheckItem;
    if (!connection) {
      tokenCheck = {
        passed: false,
        message: 'Cannot verify token: No connection configured',
      };
      failures.push({
        code: 'TOKEN_CHECK_SKIPPED',
        message: 'Provisioning connection is required before token verification.',
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else {
      const secretKey = connection.secretRef;
      const tokenValue = process.env[secretKey];

      const isConfigured =
        Boolean(tokenValue) &&
        typeof tokenValue === 'string' &&
        tokenValue.trim().length > 0 &&
        !tokenValue.includes('<') &&
        !tokenValue.includes('>');

      if (!isConfigured) {
        tokenCheck = {
          passed: false,
          secretRef: secretKey,
          message: `Environment variable '${secretKey}' is missing or not set in server .env`,
        };
        failures.push({
          code: 'TOKEN_ENV_MISSING',
          message: `Environment variable '${secretKey}' is not configured in .env on the server.`,
          fixOwner: 'INTEGRATION_DEVELOPER',
        });
      } else {
        tokenCheck = {
          passed: true,
          secretRef: secretKey,
          message: `Environment variable '${secretKey}' is configured on the server.`,
        };
      }
    }

    // 3. Sandbox allowlist check (max 5 verified recipient numbers in dev sandbox)
    const rawAllowlist = (process.env.META_TEST_ALLOWLIST || '').trim();
    const isAllowlistPlaceholder = rawAllowlist.includes('<') || rawAllowlist.includes('>');
    const allowlistNumbers = isAllowlistPlaceholder
      ? []
      : rawAllowlist
          .split(',')
          .map((n) => n.trim().replace(/^\+/, ''))
          .filter((n) => /^\d{10,15}$/.test(n));

    let allowlistCheck: ReadinessCheckItem;
    if (allowlistNumbers.length === 0) {
      allowlistCheck = {
        passed: false,
        count: 0,
        message: 'META_TEST_ALLOWLIST is empty or contains unreplaced placeholders',
      };
      failures.push({
        code: 'ALLOWLIST_NOT_CONFIGURED',
        message:
          'Meta test allowlist (META_TEST_ALLOWLIST) must be configured with at least one verified phone number.',
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else if (allowlistNumbers.length > 5) {
      allowlistCheck = {
        passed: false,
        count: allowlistNumbers.length,
        message: `META_TEST_ALLOWLIST has ${allowlistNumbers.length} numbers (max 5 allowed in sandbox)`,
      };
      failures.push({
        code: 'ALLOWLIST_EXCEEDS_MAX',
        message:
          'Meta test allowlist exceeds maximum of 5 verified phone numbers permitted by Meta test mode.',
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else {
      allowlistCheck = {
        passed: true,
        count: allowlistNumbers.length,
        message: `Allowlist configured with ${allowlistNumbers.length} verified recipient number(s).`,
      };
    }

    // 4. Sendable template check
    const sendableCount = await mockTemplateSource.countTemplates({ sendable: true });
    const totalCount = await mockTemplateSource.countTemplates();

    let templateCheck: ReadinessCheckItem;
    if (sendableCount === 0) {
      templateCheck = {
        passed: false,
        count: 0,
        message: 'No approved sendable WhatsApp templates found in catalogue',
      };
      failures.push({
        code: 'NO_SENDABLE_TEMPLATES',
        message:
          'At least one approved, sendable WhatsApp template must exist in the catalogue.',
        fixOwner: 'INTEGRATION_DEVELOPER',
      });
    } else {
      templateCheck = {
        passed: true,
        count: sendableCount,
        message: `Found ${sendableCount} approved sendable template(s) in catalogue.`,
      };
    }

    const isReady = failures.length === 0;

    return {
      ready: isReady,
      tenantId,
      connection: connection
        ? {
            id: connection.id,
            phoneNumberId: connection.phoneNumberId,
            wabaId: connection.wabaId,
            secretRef: connection.secretRef, // Environment variable NAME only
            graphApiVersion: connection.graphApiVersion,
            status: connection.status,
          }
        : null,
      checks: {
        connectionExists: connectionCheck,
        tokenPresent: tokenCheck,
        allowlistConfigured: allowlistCheck,
        hasSendableTemplate: templateCheck,
      },
      sendableTemplatesCount: sendableCount,
      totalTemplatesCount: totalCount,
      failures,
      notice: REQUIRED_SETTINGS_NOTICE,
      timestamp: new Date().toISOString(),
    };
  }
}

export const readinessService = new ReadinessService();
