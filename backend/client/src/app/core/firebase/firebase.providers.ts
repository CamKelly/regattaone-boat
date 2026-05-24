import { InjectionToken } from '@angular/core';
import { Auth } from 'firebase/auth';
import { Firestore } from 'firebase/firestore';
import { Functions } from 'firebase/functions';

export const firebaseAuth = new InjectionToken<Auth>('firebaseAuth');
export const firebaseDb = new InjectionToken<Firestore>('firebaseDb');
export const firebaseFunctions = new InjectionToken<Functions>('firebaseFunctions');
