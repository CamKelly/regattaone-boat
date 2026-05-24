import * as NotehubJs from '@blues-inc/notehub-js';
import {
  CompactPresencePayload,
  PRESENCE_INBOUND_NOTEFILE,
  PRESENCE_ACK_NOTEFILE,
} from '@regattaone/shared';
import { logger } from 'firebase-functions';

export interface NotehubServiceConfig {
  personalAccessToken: string;
  defaultProjectUid?: string;
}

export interface SendPresenceNoteResult {
  success: boolean;
  error?: string;
}

export interface PresenceAckEvent {
  deviceUid: string;
  messageId: string;
  receivedAt: number;
  ok: boolean;
}

export class NotehubService {
  private readonly deviceApi: NotehubJs.DeviceApi;
  private readonly eventApi: NotehubJs.EventApi;
  private readonly defaultProjectUid?: string;

  constructor(config: NotehubServiceConfig) {
    const client = NotehubJs.ApiClient.instance;
    const auth = client.authentications['personalAccessToken'] as { accessToken?: string };
    auth.accessToken = config.personalAccessToken;

    this.deviceApi = new NotehubJs.DeviceApi();
    this.eventApi = new NotehubJs.EventApi();
    this.defaultProjectUid = config.defaultProjectUid;
  }

  resolveProjectUid(deviceProjectUid?: string): string {
    const projectUid = deviceProjectUid ?? this.defaultProjectUid;
    if (!projectUid) {
      throw new Error('Notehub project UID is required to send device notifications.');
    }

    return projectUid;
  }

  async sendPresenceNotification(
    projectUid: string,
    deviceUid: string,
    payload: CompactPresencePayload,
  ): Promise<SendPresenceNoteResult> {
    const noteInput = new NotehubJs.NoteInput();
    noteInput.body = payload as unknown as Record<string, unknown>;

    try {
      await this.deviceApi.addQiNote(
        this.resolveProjectUid(projectUid),
        deviceUid,
        PRESENCE_INBOUND_NOTEFILE,
        noteInput,
      );

      logger.info('Sent presence notification to device', {
        deviceUid,
        messageId: payload.mid,
        type: payload.t,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to send presence notification', {
        deviceUid,
        messageId: payload.mid,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  async fetchLatestPresenceAck(
    projectUid: string,
    deviceUid: string,
    messageId: string,
  ): Promise<PresenceAckEvent | null> {
    try {
      const response = (await this.eventApi.getEvents(this.resolveProjectUid(projectUid), {
        deviceUID: [deviceUid],
        files: [PRESENCE_ACK_NOTEFILE],
        pageSize: 10,
        sortBy: 'captured',
        sortOrder: 'desc',
      })) as { events?: Array<{ body?: Record<string, unknown>; when?: number }> };

      const match = (response.events ?? []).find((event) => {
        const body = event.body ?? {};
        const ackId = String(body['mid'] ?? body['id'] ?? '');
        return ackId === messageId;
      });

      if (!match) {
        return null;
      }

      const body = match.body ?? {};
      const ok = body['ok'] !== false;

      return {
        deviceUid,
        messageId,
        receivedAt: match.when ?? Date.now() / 1000,
        ok,
      };
    } catch (error) {
      logger.warn('Unable to poll Notehub presence ack', {
        deviceUid,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export function createNotehubService(config: NotehubServiceConfig): NotehubService {
  return new NotehubService(config);
}
