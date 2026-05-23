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
            <button type="button" id="connect" class="regatta-ble-btn">Add device</button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <div id="ui" class="ui-panel">
        <div id="screen-boat" class="app-screen ui-screen-horiz boat-screen" role="main">
          <div class="ui-toolbar-band boat-toolbar-band">
            <div class="ui-toolbar-row ui-toolbar-row--title">
              <h1>IMU · UWB · Notecard</h1>
              <p class="hint">
                Chrome · HTTPS or <code>localhost</code> · <strong>RegattaOne-Boat</strong> · service
                <code>0xFEF0</code>
              </p>
            </div>
            <div class="ui-toolbar-row ui-toolbar-row--devices">
              <div class="ble-device-picker-wrap">
                <label class="imu-stream-label" for="ble-device-select">Connected device</label>
                <div class="ble-device-picker-row">
                  <select id="ble-device-select" class="ble-device-select" disabled aria-live="polite">
                    <option value="">No devices connected</option>
                  </select>
                  <button
                    type="button"
                    id="ble-device-disconnect"
                    class="regatta-ble-btn regatta-ble-btn--secondary ble-device-disconnect"
                    disabled
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </div>

            <div class="ui-toolbar-row ui-toolbar-row--boat-id">
              <div class="ble-device-picker-wrap">
                <label class="imu-stream-label" for="boat-id-input">Boat ID <code>0xFEFB</code></label>
                <div class="ble-device-picker-row">
                  <input
                    id="boat-id-input"
                    class="boat-id-input"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    maxlength="32"
                    placeholder="e.g. port-bow"
                    disabled
                  />
                  <button type="button" id="boat-id-save" class="regatta-ble-btn" disabled>Save ID</button>
                </div>
                <p id="boat-id-status" class="hint boat-id-status">Connect a device to set its boat ID.</p>
              </div>
            </div>

            <section class="boat-section" aria-labelledby="imu-heading">
              <h2 id="imu-heading" class="radio-h2">SEN0140 IMU <code>0xFEF1</code></h2>
              <p id="imu-meta" class="hint imu-meta-line">Connect to stream accel, gyro, mag, temperature, and pressure.</p>
              <div class="sensor-grid" aria-live="polite">
                <div class="sensor-card sensor-card--accel">
                  <span class="sensor-card-label">Accelerometer</span>
                  <span id="imu-accel" class="sensor-card-value">—</span>
                </div>
                <div class="sensor-card">
                  <span class="sensor-card-label">Gyroscope</span>
                  <span id="imu-gyro" class="sensor-card-value">—</span>
                </div>
                <div class="sensor-card">
                  <span class="sensor-card-label">Magnetometer</span>
                  <span id="imu-mag" class="sensor-card-value">—</span>
                </div>
                <div class="sensor-card">
                  <span class="sensor-card-label">Temperature</span>
                  <span id="imu-temp" class="sensor-card-value">—</span>
                </div>
                <div class="sensor-card">
                  <span class="sensor-card-label">Barometer</span>
                  <span id="imu-baro" class="sensor-card-value">—</span>
                </div>
              </div>
            </section>

            <section class="boat-section" aria-labelledby="uwb-heading">
              <h2 id="uwb-heading" class="radio-h2">REYAX RYUW122 <code>0xFEFA</code> / <code>0xFEF9</code></h2>
              <p class="hint">
                Send AT commands (e.g. <code>AT</code>). Firmware appends <code>CRLF</code> if needed; responses appear below.
              </p>
              <label class="hint" for="uwb-at-input"><strong>AT command</strong></label>
              <div class="uwb-at-row">
                <input
                  id="uwb-at-input"
                  class="uwb-at-input"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="AT"
                  disabled
                />
                <button type="button" id="uwb-at-send" class="msp430-uart-btn" disabled>Send AT</button>
              </div>
              <h3 class="radio-h3">UART log</h3>
              <pre id="uwb-line-log" class="msp430-uart-log uwb-line-log" aria-live="polite"></pre>
            </section>

            <section class="boat-section boat-section--notecard" aria-labelledby="nc-heading">
              <h2 id="nc-heading" class="radio-h2">Blues Notecard <code>0xFEF7</code></h2>
              <label class="hint" for="notecard-json"><strong>Notecard JSON</strong> (newline-terminated)</label>
              <textarea
                id="notecard-json"
                class="notecard-json-ta"
                rows="4"
                spellcheck="false"
                placeholder='{"req":"hub.status"}'
              ></textarea>
              <div class="msp430-uart-actions">
                <button type="button" id="notecard-send" class="msp430-uart-btn" disabled>Send to Notecard</button>
              </div>
              <h3 class="radio-h3">Notecard response <code>0xFEF8</code></h3>
              <pre id="notecard-rsp-log" class="msp430-uart-log" aria-live="polite"></pre>
            </section>
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
