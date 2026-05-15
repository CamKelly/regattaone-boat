import { ApplicationConfig, isDevMode, provideZoneChangeDetection } from "@angular/core";
import { provideIonicAngular } from "@ionic/angular/standalone";
import { provideStore } from "@ngrx/store";
import { provideStoreDevtools } from "@ngrx/store-devtools";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIonicAngular({ mode: "md" }),
    provideStore(),
    provideStoreDevtools({
      maxAge: 100,
      logOnly: !isDevMode(),
      autoPause: true,
    }),
  ],
};
