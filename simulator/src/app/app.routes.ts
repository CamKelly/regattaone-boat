import { Routes } from "@angular/router";
import { SimulatorShellComponent } from "./pages/simulator-shell/simulator-shell.component";

export const routes: Routes = [
  { path: "", component: SimulatorShellComponent },
  { path: "**", redirectTo: "" },
];
