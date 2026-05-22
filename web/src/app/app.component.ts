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
              <h1>IMU · UWB · Notecard</h1>
              <p class="hint">
                Chrome · HTTPS or <code>localhost</code> · BLE name
                <strong>RegattaOne-Boat-anchor</strong> or <strong>RegattaOne-Boat-tag</strong> · service
                <code>0xFEF0</code>
              </p>
            </div>
            <div class="ui-toolbar-row ui-toolbar-row--stream">
              <div class="imu-stream-block">
                <span class="imu-stream-label">Connection</span>
                <pre id="boat-status" class="imu-stream-status imu-connection-line">Disconnected</pre>
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
              <h2 id="uwb-heading" class="radio-h2">REYAX RYUW122 test <code>0xFEFB</code> / <code>0xFEFC</code></h2>
              <p class="hint">
                Flash one board as <strong>anchor</strong> and one as <strong>tag</strong> with the same 8-byte
                network ID and 32-digit password. Anchor polls the tag address for distance (REYAX AT manual).
              </p>
              <div class="uwb-test-grid">
                <label class="hint" for="uwb-role"><strong>Role</strong></label>
                <select id="uwb-role" class="uwb-field" disabled>
                  <option value="tag">Tag (AT+MODE=0)</option>
                  <option value="anchor">Anchor (AT+MODE=1)</option>
                </select>
                <label class="hint" for="uwb-network-id"><strong>Network ID</strong> (8 chars)</label>
                <input id="uwb-network-id" class="uwb-field" type="text" maxlength="8" spellcheck="false" disabled />
                <label class="hint" for="uwb-address"><strong>This address</strong> (8 chars)</label>
                <input id="uwb-address" class="uwb-field" type="text" maxlength="8" spellcheck="false" disabled />
                <label class="hint" for="uwb-peer"><strong>Peer tag address</strong> (anchor only)</label>
                <input id="uwb-peer" class="uwb-field" type="text" maxlength="8" spellcheck="false" disabled />
                <label class="hint" for="uwb-password"><strong>Password</strong> (32 hex)</label>
                <input id="uwb-password" class="uwb-field uwb-field--wide" type="text" maxlength="32" spellcheck="false" disabled />
                <label class="hint" for="uwb-range-ms"><strong>Poll interval (ms)</strong></label>
                <input id="uwb-range-ms" class="uwb-field" type="number" min="100" max="60000" value="500" disabled />
                <label class="hint uwb-check-label" for="uwb-auto-range">
                  <input id="uwb-auto-range" type="checkbox" disabled />
                  Auto ranging (ANCHOR_SEND / TAG_SEND loop)
                </label>
              </div>
              <div class="msp430-uart-actions">
                <button type="button" id="uwb-apply" class="msp430-uart-btn" disabled>Apply &amp; save to module</button>
              </div>
              <div class="uwb-distance-block" aria-live="polite">
                <span class="uwb-distance-label">Distance</span>
                <span id="uwb-distance" class="uwb-distance-value">—</span>
                <span id="uwb-distance-meta" class="hint uwb-distance-meta"></span>
                <span class="hint uwb-distance-hint">Shown on the anchor device when ranging is active.</span>
              </div>
              <h3 class="radio-h3">Manual AT <code>0xFEFA</code> / log <code>0xFEF9</code></h3>
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
