import { ApplicationConfig } from "@angular/core";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { PlusOutline } from "@ant-design/icons-angular/icons";
import { en_US, provideNzI18n } from "ng-zorro-antd/i18n";
import { provideNzIcons } from "ng-zorro-antd/icon";

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimationsAsync(),
    provideNzI18n(en_US),
    provideNzIcons([PlusOutline]),
  ],
};
