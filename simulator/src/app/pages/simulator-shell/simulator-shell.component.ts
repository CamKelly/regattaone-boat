import { AsyncPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { NzLayoutModule } from "ng-zorro-antd/layout";
import { NzTypographyModule } from "ng-zorro-antd/typography";
import { SimulationService } from "../../services/simulation.service";
import { ChartPanelComponent } from "../../components/chart-panel/chart-panel.component";
import { ControlPanelComponent } from "../../components/control-panel/control-panel.component";
import { MapViewComponent } from "../../components/map-view/map-view.component";
import { MetricsDashboardComponent } from "../../components/metrics-dashboard/metrics-dashboard.component";
import { ScenarioToolbarComponent } from "../../components/scenario-toolbar/scenario-toolbar.component";

@Component({
  selector: "app-simulator-shell",
  standalone: true,
  imports: [
    AsyncPipe,
    NzLayoutModule,
    NzTypographyModule,
    ScenarioToolbarComponent,
    MapViewComponent,
    ChartPanelComponent,
    ControlPanelComponent,
    MetricsDashboardComponent,
  ],
  templateUrl: "./simulator-shell.component.html",
  styleUrl: "./simulator-shell.component.scss",
})
export class SimulatorShellComponent {
  protected readonly sim = inject(SimulationService);
  protected readonly snapshot$ = this.sim.snapshot$;
}
