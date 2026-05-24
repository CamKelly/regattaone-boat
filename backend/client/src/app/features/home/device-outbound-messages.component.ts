import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DevicePresenceEventType, OutboundPresenceMessage } from '@regattaone/shared';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzPopconfirmModule } from 'ng-zorro-antd/popconfirm';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { OutboundQueueService } from '../../core/devices/outbound-queue.service';

@Component({
  selector: 'app-device-outbound-messages',
  imports: [
    DatePipe,
    NzButtonModule,
    NzCheckboxModule,
    NzEmptyModule,
    NzPopconfirmModule,
    NzTableModule,
    NzTagModule,
    NzTooltipModule,
  ],
  templateUrl: './device-outbound-messages.component.html',
  styleUrl: './device-outbound-messages.component.scss',
})
export class DeviceOutboundMessagesComponent {
  readonly deviceUid = input.required<string>();

  private readonly outboundQueueService = inject(OutboundQueueService);
  private readonly message = inject(NzMessageService);

  protected readonly messages = signal<OutboundPresenceMessage[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly deleting = signal(false);
  protected readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  protected readonly selectedCount = computed(() => this.selectedIds().size);
  protected readonly allSelected = computed(() => {
    const messages = this.messages();
    return messages.length > 0 && this.selectedIds().size === messages.length;
  });
  protected readonly selectionIndeterminate = computed(() => {
    const count = this.selectedIds().size;
    const total = this.messages().length;
    return count > 0 && count < total;
  });

  constructor() {
    effect((onCleanup) => {
      const deviceUid = this.deviceUid();
      this.loading.set(true);
      this.loadError.set(false);
      this.messages.set([]);
      this.selectedIds.set(new Set());

      const subscription = this.outboundQueueService.watchDeviceMessages(deviceUid).subscribe({
        next: (messages) => {
          this.messages.set(messages);
          this.loading.set(false);
          this.pruneSelection(messages);
        },
        error: (error) => {
          console.error('Failed to load outbound messages', deviceUid, error);
          this.loadError.set(true);
          this.loading.set(false);
        },
      });

      onCleanup(() => subscription.unsubscribe());
    });
  }

  protected isSelected(messageId: string): boolean {
    return this.selectedIds().has(messageId);
  }

  protected toggleSelected(messageId: string, checked: boolean): void {
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(messageId);
      } else {
        next.delete(messageId);
      }
      return next;
    });
  }

  protected toggleSelectAll(checked: boolean): void {
    if (!checked) {
      this.selectedIds.set(new Set());
      return;
    }

    this.selectedIds.set(new Set(this.messages().map((message) => message.id)));
  }

  protected async deleteSelected(): Promise<void> {
    const deviceUid = this.deviceUid();
    const messageIds = [...this.selectedIds()];
    if (messageIds.length === 0 || this.deleting()) {
      return;
    }

    this.deleting.set(true);
    try {
      await this.outboundQueueService.deleteMessages(deviceUid, messageIds);
      this.selectedIds.set(new Set());
      this.message.success(
        messageIds.length === 1
          ? 'Deleted 1 message from the queue.'
          : `Deleted ${messageIds.length} messages from the queue.`,
      );
    } catch (error) {
      console.error('Failed to delete outbound messages', deviceUid, messageIds, error);
      this.message.error('Unable to delete selected messages. Check Firestore rules and try again.');
    } finally {
      this.deleting.set(false);
    }
  }

  protected eventTypeLabel(type: DevicePresenceEventType): string {
    switch (type) {
      case 'DEVICE_ONLINE':
        return 'Device online';
      case 'DEVICE_OFFLINE':
        return 'Device offline';
      case 'DEVICE_ID_CHANGED':
        return 'ID changed';
      case 'DEVICE_REMOVED':
        return 'Removed';
      case 'ONLINE_DEVICE_SNAPSHOT':
        return 'Online snapshot';
    }
  }

  protected statusLabel(status: OutboundPresenceMessage['status']): string {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'sent':
        return 'Sent';
      case 'acked':
        return 'Acked';
      case 'failed':
        return 'Failed';
    }
  }

  protected statusColor(status: OutboundPresenceMessage['status']): string {
    switch (status) {
      case 'pending':
        return 'gold';
      case 'sent':
        return 'blue';
      case 'acked':
        return 'green';
      case 'failed':
        return 'red';
    }
  }

  protected payloadSummary(message: OutboundPresenceMessage): string {
    const payload = message.compactPayload;
    switch (message.eventType) {
      case 'DEVICE_ONLINE':
        return payload.id ?? '—';
      case 'DEVICE_OFFLINE':
      case 'DEVICE_REMOVED':
        return payload.id ?? '—';
      case 'DEVICE_ID_CHANGED':
        return `${payload.oid ?? '?'} → ${payload.nid ?? '?'}`;
      case 'ONLINE_DEVICE_SNAPSHOT': {
        const count = Array.isArray(payload.d) ? payload.d.length : 0;
        return `${count} peer${count === 1 ? '' : 's'}`;
      }
      default:
        return payload.t ?? '—';
    }
  }

  private pruneSelection(messages: OutboundPresenceMessage[]): void {
    const visibleIds = new Set(messages.map((message) => message.id));
    this.selectedIds.update((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }
}
