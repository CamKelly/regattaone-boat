import { Injectable, inject } from '@angular/core';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';
import { Observable } from 'rxjs';
import { firebaseAuth } from '../firebase/firebase.providers';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(firebaseAuth);

  readonly authState$: Observable<User | null> = new Observable((subscriber) => {
    const unsubscribe = onAuthStateChanged(this.auth, (user) => subscriber.next(user));
    return () => unsubscribe();
  });

  get currentUser(): User | null {
    return this.auth.currentUser;
  }

  signIn(email: string, password: string) {
    return signInWithEmailAndPassword(this.auth, email, password);
  }

  signUp(email: string, password: string) {
    return createUserWithEmailAndPassword(this.auth, email, password);
  }

  signOut() {
    return signOut(this.auth);
  }
}
