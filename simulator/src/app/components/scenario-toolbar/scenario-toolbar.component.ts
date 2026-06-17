import { DecimalPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { NzButtonModule } from "ng-zorro-antd/button";
import { NzIconModule } from "ng-zorro-antd/icon";
import { NzSelectModule } from "ng-zorro-antd/select";
import { NzSpaceModule } from "ng-zorro-antd/space";
import { NzTagModule } from "ng-zorro-antd/tag";
import { AsyncPipe } from "@angular/common";
import { SimulationService } from "../../services/simulation.service";
import type { ScenarioMeta } from "../../core/models/simulation-config";

@Component({
  selector: "app-scenario-toolbar",
  standalone: true,
  imports: [
    AsyncPipe,
    DecimalPipe,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzSelectModule,
    NzSpaceModule,
    NzTagModule,
  ],
  templateUrl: "./scenario-toolbar.component.html",
  styleUrl: "./scenario-toolbar.component.scss",
})
export class ScenarioToolbarComponent {
  protected readonly sim = inject(SimulationService);
  protected readonly snapshot$ = this.sim.snapshot$;
  protected scenarios = this.sim.listScenarios();
  protected selectedId = this.sim.getConfig().scenario.id;

  onScenarioChange(id: string): void {
    const scenario = this.scenarios.find((s) => s.id === id);
    if (scenario) {
      this.sim.applyScenario(scenario);
      this.selectedId = id;
    }
  }

  start(): void {
    this.sim.start();
  }

  pause(): void {
    this.sim.pause();
  }

  reset(): void {
    this.sim.reset();
  }

  step(): void {
    this.sim.stepOnce();
  }

  scenarioLabel(s: ScenarioMeta): string {
    return s.label;
  }
}
