import { Injectable, inject } from '@angular/core';
import { NotehubDeviceRecord } from '@regattaone/shared';
import { Timestamp, collection, onSnapshot, query, where } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { firebaseDb } from '../firebase/firebase.providers';

function toIsoString(value: unknown): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  return '';
}

function mapNotehubDevice(docId: string, data: Record<string, unknown>): NotehubDeviceRecord {
  const deviceType = data['deviceType'];
  return {
    notehubDeviceUid: String(data['notehubDeviceUid'] ?? docId),
    boatId: String(data['boatId'] ?? ''),
    ...(typeof deviceType === 'string' && deviceType.trim().length > 0
      ? { deviceType: deviceType as NotehubDeviceRecord['deviceType'] }
      : {}),
    reason: (data['reason'] as NotehubDeviceRecord['reason']) ?? 'boot',
    lastEventTime: toIsoString(data['lastEventTime']),
    createdAt: toIsoString(data['createdAt']),
    lastUpdatedAt: toIsoString(data['lastUpdatedAt']),
    transport: String(data['transport'] ?? ''),
    product: String(data['product'] ?? ''),
    app: String(data['app'] ?? ''),
    fleet: String(data['fleet'] ?? ''),
    fleets: Array.isArray(data['fleets'])
      ? data['fleets'].filter((fleet): fleet is string => typeof fleet === 'string')
      : [],
    lastEventId: String(data['lastEventId'] ?? ''),
    source: 'notehub',
    online: data['online'] === true,
    lastSeen: toIsoString(data['lastSeen']),
    deviceId: String(data['deviceId'] ?? data['boatId'] ?? ''),
  };
}

@Injectable({ providedIn: 'root' })
export class DeviceService {
  private readonly db = inject(firebaseDb);

  watchNotehubDevices(): Observable<NotehubDeviceRecord[]> {
    return new Observable((subscriber) => {
      const devicesQuery = query(collection(this.db, 'devices'), where('source', '==', 'notehub'));

      const unsubscribe = onSnapshot(
        devicesQuery,
        (snapshot) => {
          const devices = snapshot.docs
            .map((doc) => mapNotehubDevice(doc.id, doc.data()))
            .sort((a, b) => a.boatId.localeCompare(b.boatId));
          subscriber.next(devices);
        },
        (error) => subscriber.error(error),
      );

      return () => unsubscribe();
    });
  }
}
