import { Injectable, inject } from '@angular/core';
import { Auth, User, connectAuthEmulator } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator } from 'firebase/firestore';
import { Functions, connectFunctionsEmulator } from 'firebase/functions';
import { firebaseAuth, firebaseDb, firebaseFunctions } from './firebase.providers';
import { useEmulators } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly auth = inject(firebaseAuth);
  private readonly db = inject(firebaseDb);
  private readonly functions = inject(firebaseFunctions);
  private emulatorsConnected = false;

  get authClient(): Auth {
    return this.auth;
  }

  get firestore(): Firestore {
    return this.db;
  }

  get cloudFunctions(): Functions {
    return this.functions;
  }

  currentUser(): User | null {
    return this.auth.currentUser;
  }

  connectEmulatorsIfNeeded(): void {
    if (!useEmulators || this.emulatorsConnected) {
      return;
    }

    connectAuthEmulator(this.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(this.db, '127.0.0.1', 8080);
    connectFunctionsEmulator(this.functions, '127.0.0.1', 5001);
    this.emulatorsConnected = true;
  }
}
