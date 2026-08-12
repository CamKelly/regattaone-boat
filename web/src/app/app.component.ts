import { AfterViewInit, Component } from "@angular/core";
import { NzButtonModule } from "ng-zorro-antd/button";
import { NzCardModule } from "ng-zorro-antd/card";
import { NzGridModule } from "ng-zorro-antd/grid";
import { NzInputModule } from "ng-zorro-antd/input";
import { NzLayoutModule } from "ng-zorro-antd/layout";
import { NzTabsModule } from "ng-zorro-antd/tabs";
import { NzTagModule } from "ng-zorro-antd/tag";
import { startRegattaApp } from "../regatta-main";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    NzLayoutModule,
    NzButtonModule,
    NzTagModule,
    NzCardModule,
    NzGridModule,
    NzInputModule,
    NzTabsModule,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent implements AfterViewInit {
  /** DWM3000 · 0xFEF2 — Device=0, IMU=1, Position=2, DWM3000=3 */
  selectedTabIndex = 3;

  ngAfterViewInit(): void {
    startRegattaApp();
  }
}
