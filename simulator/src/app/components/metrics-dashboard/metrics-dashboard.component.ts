import { DecimalPipe, PercentPipe } from "@angular/common";
import { Component, Input, OnChanges, SimpleChanges } from "@angular/core";
import { NzCardModule } from "ng-zorro-antd/card";
import { NzDescriptionsModule } from "ng-zorro-antd/descriptions";
import { NzGridModule } from "ng-zorro-antd/grid";
import { NzTagModule } from "ng-zorro-antd/tag";
import type { SimulationSnapshot } from "../../core/models/simulation-state";

@Component({
  selector: "app-metrics-dashboard",
  standalone: true,
  imports: [
    DecimalPipe,
    PercentPipe,
    NzCardModule,
    NzDescriptionsModule,
    NzGridModule,
    NzTagModule,
  ],
  templateUrl: "./metrics-dashboard.component.html",
  styleUrl: "./metrics-dashboard.component.scss",
})
export class MetricsDashboardComponent implements OnChanges {
  @Input({ required: true }) snapshot!: SimulationSnapshot;

  protected fusion = this.snapshot?.fusion[0];
  protected truth = this.snapshot?.truthMetrics[0];
  protected summary = this.snapshot?.summary;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["snapshot"] && this.snapshot) {
      this.fusion = this.snapshot.fusion[0];
      this.truth = this.snapshot.truthMetrics[0];
      this.summary = this.snapshot.summary;
    }
  }

  ocsColor(risk: string): string {
    switch (risk) {
      case "OCS":
        return "red";
      case "MARGINAL":
        return "orange";
      default:
        return "green";
    }
  }
}
