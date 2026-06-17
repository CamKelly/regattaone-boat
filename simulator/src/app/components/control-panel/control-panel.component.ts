import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { AsyncPipe } from "@angular/common";
import { NzCardModule } from "ng-zorro-antd/card";
import { NzCollapseModule } from "ng-zorro-antd/collapse";
import { NzInputNumberModule } from "ng-zorro-antd/input-number";
import { NzSelectModule } from "ng-zorro-antd/select";
import { NzSliderModule } from "ng-zorro-antd/slider";
import { SimulationService } from "../../services/simulation.service";
import {
  ALL_FUSION_ALGORITHMS,
  FUSION_ALGORITHM_META,
  type FusionAlgorithmId,
  type SimulationConfig,
  type UwbSchedulingMode,
} from "../../core/models/simulation-config";

@Component({
  selector: "app-control-panel",
  standalone: true,
  imports: [
    AsyncPipe,
    FormsModule,
    NzCardModule,
    NzCollapseModule,
    NzInputNumberModule,
    NzSelectModule,
    NzSliderModule,
  ],
  templateUrl: "./control-panel.component.html",
  styleUrl: "./control-panel.component.scss",
})
export class ControlPanelComponent {
  protected readonly sim = inject(SimulationService);
  protected readonly config$ = this.sim.config$;

  protected algorithms: { id: FusionAlgorithmId; label: string }[] =
    ALL_FUSION_ALGORITHMS.map((id) => ({
      id,
      label: FUSION_ALGORITHM_META[id].label,
    }));

  protected schedulingModes: { id: UwbSchedulingMode; label: string }[] = [
    { id: "fixed_priority", label: "Fixed priority" },
    { id: "dynamic_priority", label: "Dynamic priority" },
    { id: "tdma", label: "TDMA" },
    { id: "round_robin", label: "Round robin" },
  ];

  patch<K extends keyof SimulationConfig>(key: K, value: SimulationConfig[K]): void {
    this.sim.updateConfigSection(key, value);
  }

  patchNested(
    section: "gps" | "uwb" | "lora" | "startLine" | "boat" | "algorithm",
    field: string,
    value: number | string,
  ): void {
    const cfg = structuredClone(this.sim.getConfig());
    const target = cfg[section] as unknown as Record<string, number | string>;
    target[field] = value;
    this.sim.updateConfigSection(section, cfg[section]);
  }
}
