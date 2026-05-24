import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { firebaseConfig } from '../../../environments/environment';
import { firebaseAuth, firebaseDb, firebaseFunctions } from './firebase.providers';

export function provideFirebase(): EnvironmentProviders {
  const app = initializeApp(firebaseConfig);

  return makeEnvironmentProviders([
    { provide: firebaseAuth, useValue: getAuth(app) },
    { provide: firebaseDb, useValue: getFirestore(app) },
    { provide: firebaseFunctions, useValue: getFunctions(app) },
  ]);
}
