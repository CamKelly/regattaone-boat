# OpenSCAD in this project

Models for the anemometer (and related parts) live in this folder. Edit `.scad` files in **Cursor** (or VS Code) and preview geometry in the external **OpenSCAD** app.

## Files

| File | Purpose |
|------|---------|
| `common.scad` | Shared dimensions (plate size, bolt holes, pole socket). Included by other files — edit here when both parts must stay in sync. |
| `top.scad` | Top plate with ultrasonic transducer mounts. |
| `bottom.scad` | Bottom plate with pole socket. **Print:** plate flat on the bed (z = 0); socket points up. Flip for mast assembly. |

Parts that share dimensions should `include <common.scad>` rather than duplicating numbers.

## Install OpenSCAD

1. Download from [openscad.org/downloads](https://openscad.org/downloads.html).
2. Install to `/Applications/OpenSCAD.app` (default on macOS).

Verify in Terminal:

```bash
"/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD" --version
```

## Cursor / VS Code setup

### 1. Install the extension

Install **OpenSCAD** by **Antyos** (`Antyos.openscad`) from the Extensions panel (Cmd+Shift+X).

This repo recommends it in `.vscode/extensions.json`.

### 2. Set the launch path

The extension must point at the **binary inside the app bundle**, not `OpenSCAD.app` itself.

Workspace setting (already in `.vscode/settings.json`):

```json
"openscad.launchPath": "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
```

To set it globally: **Settings** → search **OpenSCAD Launch Path**.

Reload the editor after changing settings (**Cmd+Shift+P** → **Developer: Reload Window**).

### 3. Enable auto-reload in OpenSCAD

In OpenSCAD: **Design → Automatic Reload and Preview**.

Optional for a cleaner preview window: **View → Hide Editor** and **View → Hide Customizer**.

## Preview workflow

1. Open a `.scad` file (e.g. `bottom.scad`).
2. Preview using any of:
   - **Preview in OpenSCAD** button in the editor title bar
   - Command Palette (**Cmd+Shift+P**) → **OpenSCAD: Preview in OpenSCAD**
   - Right-click the file tab → **Preview in OpenSCAD**
3. OpenSCAD opens (or focuses) with your model.
4. Edit and **save** in Cursor — OpenSCAD reloads and re-renders if **Automatic Reload and Preview** is on.

Press **F5** in OpenSCAD to force a preview refresh.

### Preview without the extension

```bash
open -a OpenSCAD "/Users/cameronkelly/regattaone-boat/3D Printing/bottom.scad"
```

Or from this directory:

```bash
open -a OpenSCAD bottom.scad
```

## Export STL for printing

**From OpenSCAD:** **File → Export → Export as STL…**

**From Terminal** (no GUI):

```bash
"/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD" \
  -o bottom.stl \
  "/Users/cameronkelly/regattaone-boat/3D Printing/bottom.scad"
```

Large `$fn` values (see `common.scad`) improve curves but slow exports.

## Editing tips

- **Units:** All dimensions in these files are **millimeters** unless a comment says otherwise.
- **Shared constants:** Change plate or bolt sizes in `common.scad` so `top.scad` and `bottom.scad` stay aligned.
- **`include`:** Files in this folder use `include <common.scad>`. Keep `common.scad` in the same directory as the file you preview.
- **`$fn`:** Circle resolution (default `200` in `common.scad`). Lower for faster preview while iterating; raise for final STL export if needed.
- **Preview vs render:** OpenSCAD preview (F5) is fast but approximate. **Design → Render** (F6) is slower and more accurate before exporting.

### Print orientation (anemometer parts)

| Part | Suggested bed orientation |
|------|---------------------------|
| `top.scad` | Plate flat on the bed (largest flat face down). |
| `bottom.scad` | Plate flat on the bed; socket points up (+Z). Flip 180° when mounting on the pole. |

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| **Preview in OpenSCAD** missing | Install extension **Antyos.openscad**, not only a syntax highlighter. |
| `Could not launch OpenSCAD` / `spawn ENOENT` | Set `openscad.launchPath` to the path above and reload Cursor. |
| Launch path rejected | Add `"openscad.experimental.skipLaunchPathValidation": true` to settings. |
| macOS blocks OpenSCAD | Run once: `xattr -cr /Applications/OpenSCAD.app` |
| Preview opens but never updates | Enable **Design → Automatic Reload and Preview**; save the file in Cursor. |
| `include` / file not found | Open or preview from this folder; paths are relative to the `.scad` file location. |
| Slow preview | Temporarily lower `$fn` in `common.scad` while editing. |

## Useful links

- [OpenSCAD User Manual](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual)
- [Using an external editor with OpenSCAD](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Using_an_external_Editor_with_OpenSCAD)
- [Antyos OpenSCAD extension](https://marketplace.visualstudio.com/items?itemName=Antyos.openscad)
