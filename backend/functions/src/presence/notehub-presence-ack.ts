import { timingSafeEqual } from 'node:crypto';
import { normalizeNotehubRoutePayload } from '@regattaone/shared';
import { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { handlePresenceAckWebhook } from './device-presence-sync';
import { OutboundQueueService } from './outbound-queue.service';

function readAuthToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed) {
    return null;
  }

  const [scheme, token] = trimmed.split(/\s+/);
  if (token && scheme.toLowerCase() === 'bearer') {
    return token.trim();
  }

  return trimmed;
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseRequestPayload(req: Request): unknown {
  const body = req.body as unknown;

  if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
    return normalizeNotehubRoutePayload(body);
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody && rawBody.length > 0) {
    try {
      return normalizeNotehubRoutePayload(JSON.parse(rawBody.toString('utf8')));
    } catch (error) {
      logger.error('Unable to parse Notehub ack rawBody JSON', error);
    }
  }

  return {};
}

export function createNotehubPresenceAckHandler(db: Firestore, expectedToken: string) {
  const queue = new OutboundQueueService(db);

  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const providedToken = readAuthToken(req.get('Authorization'));
    if (!providedToken || !tokensMatch(expectedToken, providedToken)) {
      logger.warn('Rejected Notehub presence ack webhook: invalid authorization token');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await handlePresenceAckWebhook(queue, parseRequestPayload(req));
      res.status(result.ignored ? 202 : 200).json(result);
    } catch (error) {
      logger.error('Failed to process Notehub presence ack', error);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}
