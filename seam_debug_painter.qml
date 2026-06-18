// =============================================================================
// seam_debug_painter.qml
// -----------------------------------------------------------------------------
// In-Painter diagnostics plugin for debugging UV / NORMAL-MAP SEAMS that remain
// visible after applying a material in Adobe Substance 3D Painter.
//
// This is the PROJECT/EXPORT-side companion to fbx_seam_inspect.js (which
// inspects the mesh itself). Painter's JS API (alg.*) cannot read FBX geometry,
// so this script focuses on what Painter DOES expose and what commonly causes
// seams on the Painter side:
//   - export DILATION / PADDING (too low = island borders bleed -> seams)
//   - NORMAL MAP FORMAT (OpenGL vs DirectX -> green-channel flip reads as seams)
//   - texture-set RESOLUTION (too low exaggerates seams)
//   - UV TILES / UDIM layout (tiles without coverage seam)
//   - presence of a Normal channel and its mix with Height
//
// It is DIAGNOSTICS-ONLY: it never modifies the project or its settings.
// All output goes to Painter's Log window (Window > Views > Log).
//
// INSTALL
//   1. Copy this file to:
//        Windows: Documents/Adobe/Adobe Substance 3D Painter/plugins/
//        macOS:   ~/Documents/Adobe/Adobe Substance 3D Painter/plugins/
//      (A single .qml file directly in /plugins/ is fine.)
//   2. In Painter: Python (JS) menu > Plugins > seam_debug_painter > enable it,
//      or Plugins > Reload Plugins Folder.
//   3. Open your project, then click "Seam Diagnostics" in the toolbar/menu
//      (or just (re)load the plugin while the project is open).
//   4. Read the report in the Log window.
//
// NOTE ON API NAMES
//   Method names below target current Substance 3D Painter. Every API call is
//   wrapped in try/catch, so if a name differs on your version the script logs
//   "(unavailable on this version)" for that line instead of failing. Lines you
//   may need to tweak are marked with  // VERIFY .
// =============================================================================

import QtQuick 2.7
import Painter 1.0

PainterPlugin {

  // -- Run automatically when the plugin loads (e.g. after Reload Plugins). --
  Component.onCompleted: {
    try {
      alg.log.info("[SeamDebug] plugin loaded.");
    } catch (e) { /* alg not ready */ }
    runDiagnostics();
  }

  // -- Re-run whenever a project is opened, so you don't have to reload. -----
  // PainterPlugin exposes onProjectOpened on current versions.  // VERIFY
  onProjectOpened: {
    runDiagnostics();
  }

  // ---------------------------------------------------------------------------
  // Small logging helpers (all output lands in the Log window).
  // ---------------------------------------------------------------------------
  function logInfo(m) { try { alg.log.info("[SeamDebug] " + m); } catch (e) {} }
  function logWarn(m) { try { alg.log.warn("[SeamDebug] " + m); } catch (e) {} }
  function logErr(m)  { try { alg.log.error("[SeamDebug] " + m); } catch (e) {} }
  function rule()     { logInfo("----------------------------------------------------------"); }

  // Run fn() and return its value; on any error log a friendly note and return
  // the provided fallback. Keeps the report going across API differences.
  function safe(label, fn, fallback) {
    try {
      return fn();
    } catch (e) {
      logWarn(label + ": (unavailable on this version) " + e);
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Main report.
  // ---------------------------------------------------------------------------
  function runDiagnostics() {
    rule();
    logInfo("UV / Normal-map SEAM diagnostics — Painter side");
    rule();

    var isOpen = safe("project.isOpen", function () {
      return alg.project.isOpen();
    }, false);

    if (!isOpen) {
      logWarn("No project is open. Open your project, then either reload this " +
              "plugin (Plugins > Reload Plugins Folder) or click 'Seam Diagnostics'.");
      rule();
      return;
    }

    reportProject();
    reportNormalFormat();
    reportTextureSets();
    reportPaddingGuidance();
    reportSummary();
    rule();
  }

  // ---- Project + mesh -------------------------------------------------------
  function reportProject() {
    logInfo("PROJECT");
    var url = safe("project.url", function () { return alg.project.url(); }, "");
    if (url) logInfo("  Project   : " + url);

    var mesh = safe("project.lastImportedMeshUrl", function () {
      return alg.project.lastImportedMeshUrl();           // VERIFY
    }, "");
    if (!mesh) {
      mesh = safe("project.lastImportedMeshPath", function () {
        return alg.project.lastImportedMeshPath();        // VERIFY
      }, "");
    }
    if (mesh) {
      logInfo("  Mesh      : " + mesh);
      logInfo("  -> Run  node fbx_seam_inspect.js \"" + stripScheme(mesh) +
              "\"  for the mesh-side seam check (hard edges vs UV seams).");
    } else {
      logWarn("  Could not read the imported mesh path from the API.");
    }
  }

  function stripScheme(u) {
    if (!u) return u;
    return ("" + u).replace(/^file:\/\/\/?/, "");
  }

  // ---- Normal map format (OpenGL vs DirectX) --------------------------------
  function reportNormalFormat() {
    logInfo("NORMAL MAP FORMAT");
    var fmt = safe("normal map format", function () {
      // Different versions expose this differently; try the common ones.
      if (alg.project.getNormalMapFormat)                 // VERIFY
        return alg.project.getNormalMapFormat();
      if (alg.project.normalMapFormat)                    // VERIFY
        return alg.project.normalMapFormat();
      throw "no normal-format accessor";
    }, null);

    if (fmt === null) {
      logWarn("  Could not read normal format via API. CHECK MANUALLY: " +
              "Edit > Project Configuration (or texture set settings) > Normal Map " +
              "Format. It MUST match your target engine.");
    } else {
      logInfo("  Project normal format: " + fmt);
    }
    logInfo("  Reminder: OpenGL (+Y / green up) vs DirectX (-Y / green down). A " +
            "mismatch between Painter and your renderer flips the green channel " +
            "and reads as seamed / inverted lighting. Unreal=DirectX, Unity/most " +
            "glTF=OpenGL (verify for your pipeline).");
  }

  // ---- Texture sets: channels, resolution, UV tiles -------------------------
  function reportTextureSets() {
    logInfo("TEXTURE SETS");
    var doc = safe("mapexport.documentStructure", function () {
      return alg.mapexport.documentStructure();           // VERIFY
    }, null);

    if (!doc || !doc.materials) {
      logWarn("  Could not read document structure. CHECK MANUALLY: Texture Set " +
              "List + Texture Set Settings (resolution, channels, UV tiles).");
      return;
    }

    for (var i = 0; i < doc.materials.length; i++) {
      var mat = doc.materials[i];
      var name = mat.name || ("set#" + i);
      logInfo("  - " + name);

      // Resolution
      var res = safe("textureSetResolution(" + name + ")", function () {
        return alg.mapexport.textureSetResolution(name);  // VERIFY
      }, null);
      if (res) {
        var w = res.width || res[0];
        var h = res.height || res[1];
        logInfo("      resolution: " + w + " x " + h);
        if (w && w < 2048) {
          logWarn("      low resolution exaggerates seams; try 2048+ while debugging.");
        }
      }

      // UV tiles / UDIM
      var tiles = mat.uvTiles || mat.uvtiles || null;
      if (tiles && tiles.length) {
        logInfo("      UV tiles  : " + tiles.length + " (UDIM/multi-tile)");
        logWarn("      Multi-tile set: every island must sit in a covered tile, " +
                "else it samples empty space and seams. Confirm tiles match the mesh.");
      }

      // Channels — look for a Normal channel and Height (which can fight it).
      var channels = collectChannels(mat);
      if (channels.length) {
        logInfo("      channels  : " + channels.join(", "));
      }
      var hasNormal = containsCI(channels, "normal");
      var hasHeight = containsCI(channels, "height");
      if (!hasNormal) {
        logWarn("      No Normal channel detected — if the seam is in normals, " +
                "the surface detail may be coming only from Height/elsewhere.");
      }
      if (hasNormal && hasHeight) {
        logInfo("      Both Normal + Height present: on export they are combined. " +
                "A height discontinuity across a UV seam can re-introduce a seam in " +
                "the converted normal — keep padding high and seams on hard edges.");
      }
    }
  }

  // Gather channel identifiers from a material entry across possible shapes.
  function collectChannels(mat) {
    var out = [];
    try {
      if (mat.channels) {
        for (var c = 0; c < mat.channels.length; c++) {
          var ch = mat.channels[c];
          out.push(typeof ch === "string" ? ch : (ch.name || ch.type || ("ch" + c)));
        }
      } else if (mat.stacks) {
        for (var s = 0; s < mat.stacks.length; s++) {
          var st = mat.stacks[s];
          if (st.channels) {
            for (var k = 0; k < st.channels.length; k++) {
              var c2 = st.channels[k];
              out.push(typeof c2 === "string" ? c2 : (c2.name || c2.type || ("ch" + k)));
            }
          }
        }
      }
    } catch (e) { /* tolerate shape differences */ }
    return out;
  }

  function containsCI(arr, needle) {
    needle = needle.toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      if (("" + arr[i]).toLowerCase().indexOf(needle) >= 0) return true;
    }
    return false;
  }

  // ---- Padding / dilation guidance (the #1 Painter-side seam cause) ---------
  function reportPaddingGuidance() {
    logInfo("EXPORT PADDING / DILATION");
    logWarn("  The most common Painter-side seam cause is insufficient padding: " +
            "texels at UV-island borders aren't extended, so neighboring islands / " +
            "the background bleed in (especially with mipmapping).");
    logInfo("  FIX: File > Export Textures > Output settings: set Padding to " +
            "\"Dilation infinite\" (or a large dilation), then re-export.");
    logInfo("  Also bake with adequate padding: Texture Set Settings > Bake Mesh " +
            "Maps > Common > increase \"Dilation Width\".");
    // The current export padding mode isn't reliably exposed to the JS API across
    // versions, so we give guidance rather than read it.  // VERIFY
  }

  // ---- Summary --------------------------------------------------------------
  function reportSummary() {
    rule();
    logInfo("LIKELY CAUSES (check in this order):");
    logInfo("  1. MESH: hard edges not on UV seams / missing tangents — run " +
            "fbx_seam_inspect.js on the mesh (Painter can't see this).");
    logInfo("  2. PADDING: export with 'Dilation infinite'; raise bake dilation.");
    logInfo("  3. NORMAL FORMAT: OpenGL vs DirectX must match your renderer.");
    logInfo("  4. UV TILES: every island in a covered (UDIM) tile.");
    logInfo("  5. RESOLUTION: raise while diagnosing to confirm it's not just texel size.");
    logInfo("Diagnostics complete — no project settings were modified.");
  }
}
