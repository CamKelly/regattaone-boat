import { AsyncPipe, DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { NotehubBoatIdReason, NotehubDeviceRecord } from '@regattaone/shared';
import { of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { AuthService } from '../../core/auth/auth.service';
import { DeviceService } from '../../core/devices/device.service';
import { DeviceOutboundMessagesComponent } from './device-outbound-messages.component';

@Component({
  selector: 'app-home',
  imports: [
    AsyncPipe,
    DatePipe,
    DeviceOutboundMessagesComponent,
    NzButtonModule,
    NzCardModule,
    NzEmptyModule,
    NzIconModule,
    NzLayoutModule,
    NzTableModule,
    NzTagModule,
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  private readonly authService = inject(AuthService);
  private readonly deviceService = inject(DeviceService);
  private readonly router = inject(Router);
  private readonly message = inject(NzMessageService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly devices = signal<NotehubDeviceRecord[]>([]);
  protected readonly expandedDeviceUid = signal<string | null>(null);

  protected readonly user$ = this.authService.authState$;

  constructor() {
    this.authService.authState$
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        switchMap((user) => {
          if (!user) {
            return of([] as NotehubDeviceRecord[]);
          }

          return this.deviceService.watchNotehubDevices();
        }),
      )
      .subscribe({
        next: (devices) => this.devices.set(devices),
        error: (error) => {
          console.error('Failed to load devices', error);
          this.message.error('Unable to load devices. Check the browser console for details.');
        },
      });
  }

  protected toggleDeviceDetails(deviceUid: string): void {
    this.expandedDeviceUid.update((current) => (current === deviceUid ? null : deviceUid));
  }

  protected isExpanded(deviceUid: string): boolean {
    return this.expandedDeviceUid() === deviceUid;
  }

  protected reasonLabel(reason: NotehubBoatIdReason): string {
    switch (reason) {
      case 'boot':
        return 'Boot';
      case 'set':
        return 'ID set';
      case 'changed':
        return 'ID changed';
    }
  }

  protected reasonColor(reason: NotehubBoatIdReason): string {
    switch (reason) {
      case 'boot':
        return 'blue';
      case 'set':
        return 'green';
      case 'changed':
        return 'orange';
    }
  }

  protected transportLabel(device: NotehubDeviceRecord): string {
    if (!device.transport) {
      return 'Unknown';
    }

    return device.transport.replace('lorawan:', 'LoRaWAN ').toUpperCase();
  }

  protected deviceTypeLabel(device: NotehubDeviceRecord): string {
    if (!device.deviceType) {
      return '—';
    }

    return device.deviceType.replace(/_/g, ' ');
  }

  protected async signOut(): Promise<void> {
    await this.authService.signOut();
    await this.router.navigateByUrl('/login');
  }
}
