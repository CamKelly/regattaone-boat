import { Subscription } from "rxjs";
import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from "@angular/core";
import Feature from "ol/Feature";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import TileLayer from "ol/layer/Tile";
import Map from "ol/Map";
import { fromLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from "ol/style";
import View from "ol/View";
import { NzCardModule } from "ng-zorro-antd/card";
import { ALL_FUSION_ALGORITHMS, FUSION_ALGORITHM_META } from "../../core/models/simulation-config";
import type { SimulationSnapshot } from "../../core/models/simulation-state";
import { enuToLonLat } from "../../core/geo/geometry";
import { SimulationService } from "../../services/simulation.service";

@Component({
  selector: "app-map-view",
  standalone: true,
  imports: [NzCardModule],
  templateUrl: "./map-view.component.html",
  styleUrl: "./map-view.component.scss",
})
export class MapViewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) snapshot!: SimulationSnapshot;
  @ViewChild("mapHost", { static: true }) mapHost!: ElementRef<HTMLDivElement>;

  private readonly sim = inject(SimulationService);
  private map: Map | null = null;
  private visibilitySub: Subscription | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private truthSource = new VectorSource();
  private sensorSource = new VectorSource();
  private fusionSource = new VectorSource();
  private lineSource = new VectorSource();

  ngAfterViewInit(): void {
    this.initMap();
    this.renderSnapshot();
    this.visibilitySub = this.sim.chartVisibility$.subscribe(() => this.renderSnapshot());
    this.resizeObserver = new ResizeObserver(() => this.map?.updateSize());
    this.resizeObserver.observe(this.mapHost.nativeElement);
    requestAnimationFrame(() => this.map?.updateSize());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["snapshot"] && this.map) {
      this.renderSnapshot();
    }
  }

  ngOnDestroy(): void {
    this.visibilitySub?.unsubscribe();
    this.resizeObserver?.disconnect();
    this.map?.setTarget(undefined);
    this.map = null;
  }

  private initMap(): void {
    const cfg = this.sim.getConfig();
    const center = fromLonLat([cfg.mapOriginLon, cfg.mapOriginLat]);

    this.map = new Map({
      target: this.mapHost.nativeElement,
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({
          source: this.lineSource,
          style: new Style({
            stroke: new Stroke({ color: "#ff4d4f", width: 3 }),
          }),
        }),
        new VectorLayer({
          source: this.sensorSource,
          style: (feature) => {
            const kind = feature.get("kind");
            if (kind === "gps") {
              return new Style({
                image: new CircleStyle({
                  radius: 6,
                  fill: new Fill({ color: "rgba(24, 144, 255, 0.35)" }),
                  stroke: new Stroke({ color: "#1890ff", width: 2 }),
                }),
              });
            }
            return new Style({
              image: new CircleStyle({
                radius: 5,
                fill: new Fill({ color: "rgba(250, 173, 20, 0.5)" }),
                stroke: new Stroke({ color: "#faad14", width: 2 }),
              }),
            });
          },
        }),
        new VectorLayer({
          source: this.fusionSource,
          style: (feature) => {
            const color = (feature.get("color") as string) ?? "#52c41a";
            return new Style({
              image: new CircleStyle({
                radius: 7,
                fill: new Fill({ color: color + "88" }),
                stroke: new Stroke({ color, width: 2 }),
              }),
            });
          },
        }),
        new VectorLayer({
          source: this.truthSource,
          style: (feature) => {
            const kind = feature.get("kind");
            if (kind === "boat") {
              return new Style({
                image: new CircleStyle({
                  radius: 5,
                  fill: new Fill({ color: "#722ed1" }),
                  stroke: new Stroke({ color: "#fff", width: 1 }),
                }),
              });
            }
            return new Style({
              image: new CircleStyle({
                radius: 8,
                fill: new Fill({ color: "#eb2f96" }),
                stroke: new Stroke({ color: "#fff", width: 2 }),
              }),
              text: new Text({
                text: feature.get("label"),
                offsetY: -14,
                font: "12px sans-serif",
                fill: new Fill({ color: "#000" }),
              }),
            });
          },
        }),
      ],
      view: new View({
        center,
        zoom: 17,
      }),
    });
  }

  private renderSnapshot(): void {
    if (!this.map || !this.snapshot) {
      return;
    }
    const cfg = this.sim.getConfig();
    const toCoord = (eastM: number, northM: number) => {
      const [lon, lat] = enuToLonLat(
        eastM,
        northM,
        cfg.mapOriginLat,
        cfg.mapOriginLon,
      );
      return fromLonLat([lon, lat]);
    };

    this.truthSource.clear();
    this.sensorSource.clear();
    this.fusionSource.clear();
    this.lineSource.clear();

    const { port, starboard } = this.snapshot.truth.marks;
    this.lineSource.addFeature(
      new Feature({
        geometry: new LineString([toCoord(port.eastM, port.northM), toCoord(starboard.eastM, starboard.northM)]),
      }),
    );

    this.truthSource.addFeature(
      new Feature({
        geometry: new Point(toCoord(port.eastM, port.northM)),
        kind: "mark",
        label: "P",
      }),
    );
    this.truthSource.addFeature(
      new Feature({
        geometry: new Point(toCoord(starboard.eastM, starboard.northM)),
        kind: "mark",
        label: "S",
      }),
    );

    for (const boat of this.snapshot.truth.boats) {
      this.truthSource.addFeature(
        new Feature({
          geometry: new Point(toCoord(boat.position.eastM, boat.position.northM)),
          kind: "boat",
        }),
      );
    }

    for (const gps of this.snapshot.sensors.gps) {
      this.sensorSource.addFeature(
        new Feature({
          geometry: new Point(toCoord(gps.position.eastM, gps.position.northM)),
          kind: "gps",
        }),
      );
    }

    for (const lora of this.snapshot.sensors.lora) {
      this.sensorSource.addFeature(
        new Feature({
          geometry: new Point(toCoord(lora.position.eastM, lora.position.northM)),
          kind: "lora",
        }),
      );
    }

    for (const algo of ALL_FUSION_ALGORITHMS) {
      if (!this.sim.isAlgorithmVisible(algo)) {
        continue;
      }
      for (const est of this.snapshot.fusionByAlgorithm[algo] ?? []) {
        this.fusionSource.addFeature(
          new Feature({
            geometry: new Point(toCoord(est.position.eastM, est.position.northM)),
            color: FUSION_ALGORITHM_META[algo].color,
            algo,
          }),
        );
      }
    }
  }
}
