import { ApplicationConfig, provideZoneChangeDetection } from "@angular/core";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { provideRouter } from "@angular/router";
import {
  CaretRightOutline,
  PauseOutline,
  ReloadOutline,
  StepForwardOutline,
} from "@ant-design/icons-angular/icons";
import { en_US, provideNzI18n } from "ng-zorro-antd/i18n";
import { provideNzIcons } from "ng-zorro-antd/icon";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    provideNzI18n(en_US),
    provideNzIcons([CaretRightOutline, PauseOutline, ReloadOutline, StepForwardOutline]),
  ],
};
