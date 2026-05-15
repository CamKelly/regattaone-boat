import { AfterViewInit, Component } from "@angular/core";
import {
  IonApp,
  IonButtons,
  IonHeader,
  IonTitle,
  IonToolbar,
} from "@ionic/angular/standalone";
import { startRegattaApp } from "../regatta-main";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [IonApp, IonHeader, IonToolbar, IonTitle, IonButtons],
  template: `
    <ion-app>
      <ion-header class="ion-no-border regatta-ion-header" translucent="true">
        <ion-toolbar color="dark">
          <div class="ble-toolbar-status" slot="start">
            <span id="ble-status" class="ble-imu-rx" aria-live="polite">BLE: —</span>
          </div>
          <ion-title>RegattaOne Boat</ion-title>
          <ion-buttons slot="end" class="regatta-ble-buttons">
            <button type="button" id="connect" class="regatta-ble-btn">Connect Bluetooth</button>
            <button type="button" id="disconnect" class="regatta-ble-btn regatta-ble-btn--secondary" disabled>
              Disconnect
            </button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <div id="ui" class="ui-panel">
        <div id="screen-boat" class="app-screen ui-screen-horiz boat-screen" role="main">
          <div class="ui-toolbar-band boat-toolbar-band">
            <div class="ui-toolbar-row ui-toolbar-row--title">
              <h1>LoRa (Blues Notecard) + UWB (RYUW122)</h1>
              <p class="hint">
                Chrome · HTTPS or <code>localhost</code> · Web Bluetooth · device name e.g.
                <strong>RegattaOne-Boat</strong> · service <code>0xFEF0</code>.
              </p>
            </div>
            <div class="ui-toolbar-row ui-toolbar-row--stream">
              <div class="imu-stream-block">
                <span class="imu-stream-label">Status</span>
                <pre id="boat-status" class="imu-stream-status">Disconnected</pre>
              </div>
            </div>
            <div class="msp430-uart-panel boat-main-panel">
              <div class="msp430-sub-head">
                <p class="hint">
                  <a href="https://shop.blues.com/products/notecard-lora" target="_blank" rel="noopener">Notecard for LoRa</a>
                  over I2C. <a href="https://reyax.com/products/RYUW122_Lite" target="_blank" rel="noopener">RYUW122_Lite</a>
                  over UART — lines arrive on notify <code>0xFEF9</code>. Each Notecard request must end with a
                  newline character (e.g. <code>&#123;"req":"hub.status"&#125;</code> then press Enter before Send).
                </p>
              </div>
              <label class="hint" for="notecard-json"><strong>Notecard JSON</strong> (GATT write <code>0xFEF7</code>)</label>
              <textarea
                id="notecard-json"
                class="notecard-json-ta"
                rows="5"
                spellcheck="false"
                placeholder='{"req":"hub.status"}'
              ></textarea>
              <div class="msp430-uart-actions" style="margin-top: 0.5rem">
                <button type="button" id="notecard-send" class="msp430-uart-btn" disabled>Send to Notecard</button>
              </div>
              <h2 class="radio-h2">Notecard response (<code>0xFEF8</code>)</h2>
              <pre id="notecard-rsp-log" class="msp430-uart-log" aria-live="polite"></pre>
              <h2 class="radio-h2">UWB UART (<code>0xFEF9</code>)</h2>
              <pre id="uwb-line-log" class="msp430-uart-log" aria-live="polite"></pre>
            </div>
          </div>
        </div>
      </div>
    </ion-app>
  `,
})
export class AppComponent implements AfterViewInit {
  ngAfterViewInit(): void {
    startRegattaApp();
  }
}
