export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId: string;
}

export const firebaseConfig: FirebaseConfig = {
  apiKey: "AIzaSyC2dxy3_WOVllYDrYDagviDqgrOGkFBigM",
  authDomain: "regattaone-boat-backend.firebaseapp.com",
  projectId: "regattaone-boat-backend",
  storageBucket: "regattaone-boat-backend.firebasestorage.app",
  messagingSenderId: "973138977769",
  appId: "1:973138977769:web:73ce9ddf675d0fd954e178",
  measurementId: "G-B9TYB41T5T"

};

export const useEmulators = false;
