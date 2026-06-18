#!/usr/bin/env node
/* =============================================================================
 * fbx_seam_inspect.js
 * -----------------------------------------------------------------------------
 * Standalone, ZERO-DEPENDENCY binary-FBX (7.x) analyzer for debugging
 * UV / normal-map SEAMS in Adobe Substance 3D Painter workflows.
 *
 * WHY THIS EXISTS
 *   Substance Painter's in-app JavaScript API (alg.*) cannot read FBX geometry
 *   (no access to vertices / normals / UVs / smoothing). Normal-map seams that
 *   survive after baking + applying a material are USUALLY a MESH problem:
 *     - hard edges (smoothing splits) that are NOT placed on a UV seam
 *     - UV seams that are NOT on a hard edge
 *     - missing tangents (renderer/baker tangent basis mismatch)
 *     - missing / per-face normals
 *   This script parses the FBX directly and reports exactly those.
 *
 * USAGE
 *     node fbx_seam_inspect.js path/to/mesh.fbx
 *     node fbx_seam_inspect.js path/to/mesh.fbx --verbose
 *
 * REQUIREMENTS
 *   Node.js only. Uses ONLY core modules: 'fs' and 'zlib'. No npm install.
 *   (Binary FBX stores big arrays Deflate-compressed; zlib ships with Node.)
 *
 * SCOPE
 *   - Binary FBX 7.x (handles both pre-7500 uint32 offsets and 7500+ uint64).
 *   - Read-only. Never modifies the file or any project.
 *   - If given ASCII FBX it errors clearly (convert to binary, or re-export).
 * ========================================================================== */

'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* -------------------------------------------------------------------------- */
/* Small logging helpers                                                      */
/* -------------------------------------------------------------------------- */
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const supportsColor = process.stdout.isTTY;
function col(c, s) { return supportsColor ? c + s + C.reset : s; }
function hr() { console.log(col(C.dim, '-'.repeat(74))); }
function head(s) { hr(); console.log(col(C.bold + C.cyan, s)); hr(); }
function info(s) { console.log('  ' + s); }
function ok(s) { console.log('  ' + col(C.green, 'OK   ') + s); }
function warn(s) { console.log('  ' + col(C.yellow, 'WARN ') + s); }
function bad(s) { console.log('  ' + col(C.red, 'SEAM ') + s); }

/* ========================================================================== *
 * 1. BINARY FBX PARSER
 *    Produces a tree of nodes: { name, props:[...], nodes:[...] }
 * ========================================================================== */

const MAGIC = 'Kaydara FBX Binary  '; // 20 bytes (note trailing spaces)

function parseFBX(buffer) {
  // --- header / sanity ----------------------------------------------------
  const magic = buffer.toString('binary', 0, 20);
  if (magic !== MAGIC) {
    // Detect ASCII FBX for a friendly error.
    const start = buffer.toString('utf8', 0, Math.min(buffer.length, 256));
    if (/FBXHeaderExtension/.test(start) || /^;\s*FBX/.test(start.trim())) {
      throw new Error(
        'This looks like an ASCII FBX. This tool parses BINARY FBX (7.x).\n' +
        'Re-export as Binary FBX (the exporter default), or convert it, then retry.');
    }
    throw new Error('Not a binary FBX file (magic bytes mismatch).');
  }
  const version = buffer.readUInt32LE(23);
  const is64 = version >= 7500; // 7.5+ uses 64-bit record offsets

  // --- recursive node reader ---------------------------------------------
  // Header layout: 21-byte magic ("Kaydara FBX Binary  \0") + 2 bytes
  // [0x1A,0x00] + 4-byte version = 27 bytes. Node records start at offset 27.
  let offset = 27;

  function readNode() {
    let endOffset, numProps, propListLen;
    if (is64) {
      endOffset = readUInt64(buffer, offset); offset += 8;
      numProps = readUInt64(buffer, offset); offset += 8;
      propListLen = readUInt64(buffer, offset); offset += 8;
    } else {
      endOffset = buffer.readUInt32LE(offset); offset += 4;
      numProps = buffer.readUInt32LE(offset); offset += 4;
      propListLen = buffer.readUInt32LE(offset); offset += 4;
    }
    const nameLen = buffer.readUInt8(offset); offset += 1;

    // Null record => end of a node list.
    if (endOffset === 0 && numProps === 0 && propListLen === 0 && nameLen === 0) {
      return null;
    }

    const name = buffer.toString('utf8', offset, offset + nameLen);
    offset += nameLen;

    const props = [];
    for (let i = 0; i < numProps; i++) props.push(readProperty());

    const node = { name, props, nodes: [] };

    // Nested nodes occupy the bytes up to endOffset.
    while (offset < endOffset) {
      const child = readNode();
      if (child === null) break;
      node.nodes.push(child);
    }
    offset = endOffset; // resync (handles trailing null record padding)
    return node;
  }

  function readProperty() {
    const type = String.fromCharCode(buffer.readUInt8(offset)); offset += 1;
    switch (type) {
      case 'Y': { const v = buffer.readInt16LE(offset); offset += 2; return v; }
      case 'C': { const v = buffer.readUInt8(offset) !== 0; offset += 1; return v; }
      case 'I': { const v = buffer.readInt32LE(offset); offset += 4; return v; }
      case 'F': { const v = buffer.readFloatLE(offset); offset += 4; return v; }
      case 'D': { const v = buffer.readDoubleLE(offset); offset += 8; return v; }
      case 'L': { const v = readInt64(buffer, offset); offset += 8; return v; }
      case 'S':
      case 'R': {
        const len = buffer.readUInt32LE(offset); offset += 4;
        const v = type === 'S'
          ? buffer.toString('utf8', offset, offset + len)
          : buffer.slice(offset, offset + len);
        offset += len; return v;
      }
      // Array types: f(float32) d(double) l(int64) i(int32) b(bool)
      case 'f': case 'd': case 'l': case 'i': case 'b':
        return readArray(type);
      default:
        throw new Error('Unknown FBX property type byte: ' + JSON.stringify(type) +
          ' at offset ' + (offset - 1));
    }
  }

  function readArray(type) {
    const arrayLength = buffer.readUInt32LE(offset); offset += 4;
    const encoding = buffer.readUInt32LE(offset); offset += 4;
    const compLen = buffer.readUInt32LE(offset); offset += 4;

    let data = buffer.slice(offset, offset + compLen);
    offset += compLen;
    if (encoding === 1) data = zlib.inflateSync(data); // Deflate-compressed

    const elemSize = (type === 'd' || type === 'l') ? 8
      : (type === 'b') ? 1 : 4;
    const out = new Array(arrayLength);
    let p = 0;
    for (let i = 0; i < arrayLength; i++) {
      switch (type) {
        case 'f': out[i] = data.readFloatLE(p); break;
        case 'd': out[i] = data.readDoubleLE(p); break;
        case 'i': out[i] = data.readInt32LE(p); break;
        case 'l': out[i] = readInt64(data, p); break;
        case 'b': out[i] = data.readUInt8(p) !== 0; break;
      }
      p += elemSize;
    }
    return out;
  }

  // --- top level: a list of nodes ----------------------------------------
  const root = { name: '__root__', props: [], nodes: [] };
  while (offset < buffer.length - 13) { // leave room for footer / null record
    const node = readNode();
    if (node === null) break;
    root.nodes.push(node);
  }
  return { version, is64, root };
}

// 64-bit readers. FBX counts/indices fit safely in JS doubles for real meshes;
// we read low/high 32 and combine (sufficient up to 2^53).
function readUInt64(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return hi * 0x100000000 + lo;
}
function readInt64(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readInt32LE(off + 4);
  return hi * 0x100000000 + lo;
}

/* ========================================================================== *
 * 2. TREE HELPERS                                                            *
 * ========================================================================== */

function findAll(node, name, out) {
  out = out || [];
  for (const child of node.nodes) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}
function child(node, name) {
  for (const c of node.nodes) if (c.name === name) return c;
  return null;
}
// First property that is an array (the bulk data payload of a sub-node).
function arrayProp(node) {
  if (!node) return null;
  for (const p of node.props) if (Array.isArray(p)) return p;
  return null;
}
// First property that is a string (mapping/reference type values).
function stringProp(node) {
  if (!node) return null;
  for (const p of node.props) if (typeof p === 'string') return p;
  return null;
}

/* ========================================================================== *
 * 3. GEOMETRY EXTRACTION                                                     *
 * ========================================================================== */

function extractGeometry(geoNode) {
  const vertices = arrayProp(child(geoNode, 'Vertices')) || [];
  const polyIdx = arrayProp(child(geoNode, 'PolygonVertexIndex')) || [];
  const edgesRaw = arrayProp(child(geoNode, 'Edges')); // optional

  // Name (3rd prop is usually "Geometry::Name")
  let name = '';
  for (const p of geoNode.props) {
    if (typeof p === 'string' && p.indexOf('Geometry::') === 0) {
      name = p.slice('Geometry::'.length); break;
    }
  }

  // Build polygons (FBX marks the last index of a face by bitwise-NOT).
  const polygons = [];
  let cur = [];
  for (let i = 0; i < polyIdx.length; i++) {
    let idx = polyIdx[i];
    if (idx < 0) { cur.push(~idx); polygons.push(cur); cur = []; }
    else cur.push(idx);
  }

  // UV layers (can be several; usually one for Painter).
  const uvLayers = findAll(geoNode, 'LayerElementUV').map(extractUVLayer);

  // Normals.
  const normalNode = child(geoNode, 'LayerElementNormal');
  const normals = normalNode ? {
    values: arrayProp(child(normalNode, 'Normals')) || [],
    mapping: stringProp(child(normalNode, 'MappingInformationType')) || '',
    reference: stringProp(child(normalNode, 'ReferenceInformationType')) || '',
  } : null;

  // Smoothing (edge or polygon based).
  const smoothNode = child(geoNode, 'LayerElementSmoothing');
  const smoothing = smoothNode ? {
    values: arrayProp(child(smoothNode, 'Smoothing')) || [],
    mapping: stringProp(child(smoothNode, 'MappingInformationType')) || '',
  } : null;

  // Tangents (presence is what matters for seam debugging).
  const tangentNode = child(geoNode, 'LayerElementTangent');
  const tangents = tangentNode ? {
    count: (arrayProp(child(tangentNode, 'Tangents')) || []).length / 3,
    mapping: stringProp(child(tangentNode, 'MappingInformationType')) || '',
  } : null;

  const binormalNode = child(geoNode, 'LayerElementBinormal');

  return {
    name, vertices, polyIdx, polygons, edgesRaw,
    uvLayers, normals, smoothing, tangents,
    hasBinormals: !!binormalNode,
  };
}

function extractUVLayer(uvNode) {
  return {
    name: stringProp(child(uvNode, 'Name')) || '(unnamed)',
    uv: arrayProp(child(uvNode, 'UV')) || [],
    uvIndex: arrayProp(child(uvNode, 'UVIndex')) || null,
    mapping: stringProp(child(uvNode, 'MappingInformationType')) || '',
    reference: stringProp(child(uvNode, 'ReferenceInformationType')) || '',
  };
}

/* ========================================================================== *
 * 4. SEAM ANALYSIS                                                           *
 *    The heart of the tool: cross-check hard edges vs UV seams.             *
 * ========================================================================== */

// Undirected edge key from two vertex indices.
function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }

// Per-corner UV lookup: returns the UV [u,v] for the polygon-vertex at flat
// corner index `corner` (0..polyIdx.length-1) given a UV layer.
function cornerUV(layer, corner, polyVertIndex) {
  const ref = layer.reference;
  let uvIdx;
  if (ref === 'IndexToDirect' || ref === 'Index') {
    uvIdx = layer.uvIndex ? layer.uvIndex[corner] : corner;
  } else { // 'Direct'
    uvIdx = corner;
  }
  if (uvIdx < 0) return null;
  const u = layer.uv[uvIdx * 2];
  const v = layer.uv[uvIdx * 2 + 1];
  if (u === undefined || v === undefined) return null;
  return [u, v];
}

function approxEq(a, b, eps) { return Math.abs(a - b) <= eps; }

function analyze(geo, opts) {
  const result = { messages: [], stats: {} };
  const eps = 1e-5;

  const vertCount = geo.vertices.length / 3;
  const polyCount = geo.polygons.length;
  result.stats.vertices = vertCount;
  result.stats.polygons = polyCount;
  result.stats.corners = geo.polyIdx.length;

  // ---- Build corner -> (polygon, vertexIndex) and edge -> corners maps ----
  // For each polygon edge we record the two corner indices on each side.
  // edgeCorners[key] = [{corner, vert}, ...] (occurrences across faces)
  const edgeCorners = new Map();
  let corner = 0;
  for (let f = 0; f < geo.polygons.length; f++) {
    const poly = geo.polygons[f];
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      const vA = poly[k];
      const vB = poly[(k + 1) % n];
      const cornerA = corner + k;
      const cornerB = corner + ((k + 1) % n);
      const key = edgeKey(vA, vB);
      let rec = edgeCorners.get(key);
      if (!rec) { rec = []; edgeCorners.set(key, rec); }
      rec.push({ face: f, cornerA, cornerB, vA, vB });
    }
    corner += n;
  }
  result.stats.edges = edgeCorners.size;

  // ---- UV layers --------------------------------------------------------
  result.stats.uvLayers = geo.uvLayers.length;

  // ---- UV seam detection (uses first UV layer = what Painter typically uses)
  let uvSeams = new Set();
  let uvOutside01 = false;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;

  const layer = geo.uvLayers[0];
  if (layer && layer.uv.length) {
    for (let i = 0; i < layer.uv.length; i += 2) {
      const u = layer.uv[i], v = layer.uv[i + 1];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    if (uMin < -eps || uMax > 1 + eps || vMin < -eps || vMax > 1 + eps) {
      uvOutside01 = true;
    }

    // An edge is a UV seam if, for the two faces sharing it, the UV coords of
    // the shared vertices differ across the faces (UV discontinuity).
    for (const [key, recs] of edgeCorners) {
      if (recs.length < 2) continue; // border edge: handled separately
      // Compare first two face occurrences.
      const r0 = recs[0], r1 = recs[1];
      // Gather UV at vA and vB for both faces.
      const a0 = uvAtVertOnFace(layer, r0, r0.vA);
      const a1 = uvAtVertOnFace(layer, r1, r0.vA);
      const b0 = uvAtVertOnFace(layer, r0, r0.vB);
      const b1 = uvAtVertOnFace(layer, r1, r0.vB);
      const continuous =
        a0 && a1 && b0 && b1 &&
        approxEq(a0[0], a1[0], eps) && approxEq(a0[1], a1[1], eps) &&
        approxEq(b0[0], b1[0], eps) && approxEq(b0[1], b1[1], eps);
      if (!continuous) uvSeams.add(key);
    }
  }
  result.stats.uvSeams = uvSeams.size;
  result.stats.uvOutside01 = uvOutside01;
  result.stats.uvRange = { uMin, uMax, vMin, vMax };

  // Helper: UV of a specific vertex `vert` as used by face-record `rec`.
  function uvAtVertOnFace(layer, rec, vert) {
    const cornerIdx = (rec.vA === vert) ? rec.cornerA
      : (rec.vB === vert) ? rec.cornerB : -1;
    if (cornerIdx < 0) return null;
    const pv = geo.polyIdx[cornerIdx];
    const realVert = pv < 0 ? ~pv : pv;
    return cornerUV(layer, cornerIdx, realVert);
  }

  // ---- Hard-edge detection from smoothing -------------------------------
  let hardEdges = new Set();
  let smoothingAvailable = false;
  if (geo.smoothing && geo.smoothing.values.length) {
    smoothingAvailable = true;
    const sm = geo.smoothing;
    if (/Edge/i.test(sm.mapping)) {
      // ByEdge: smoothing value 0 => hard edge. Indexed by FBX Edges array.
      if (geo.edgesRaw && geo.edgesRaw.length === sm.values.length) {
        for (let e = 0; e < geo.edgesRaw.length; e++) {
          if (sm.values[e] === 0 || sm.values[e] === false) {
            // FBX 'Edges' stores a corner (polygon-vertex) index; map to verts.
            const cIdx = geo.edgesRaw[e];
            const vA = absVert(geo.polyIdx[cIdx]);
            // The edge's other endpoint is the next corner within the same face.
            const vB = edgePartner(geo, cIdx);
            if (vB !== null) hardEdges.add(edgeKey(vA, vB));
          }
        }
      }
    } else if (/Polygon/i.test(sm.mapping)) {
      // ByPolygon: each face has a smoothing group id. An edge shared by two
      // faces with DIFFERENT groups is a hard edge.
      for (const [key, recs] of edgeCorners) {
        if (recs.length < 2) continue;
        const g0 = sm.values[recs[0].face];
        const g1 = sm.values[recs[1].face];
        if (g0 !== g1) hardEdges.add(key);
      }
    }
  }
  result.stats.hardEdges = hardEdges.size;
  result.stats.smoothingAvailable = smoothingAvailable;

  // ---- Border (open) edges: shared by only one face ---------------------
  let borderEdges = 0;
  for (const recs of edgeCorners.values()) if (recs.length === 1) borderEdges++;
  result.stats.borderEdges = borderEdges;

  // ---- THE KEY CROSS-CHECK ----------------------------------------------
  // Hard edges that are NOT on a UV seam -> bake produces a visible seam.
  const hardNotSeam = [];
  for (const key of hardEdges) {
    if (!uvSeams.has(key)) hardNotSeam.push(key);
  }
  // UV seams that are NOT on a hard edge -> usually fine, sometimes soft seam.
  const seamNotHard = [];
  for (const key of uvSeams) {
    if (!hardEdges.has(key)) seamNotHard.push(key);
  }
  result.stats.hardNotSeam = hardNotSeam.length;
  result.stats.seamNotHard = seamNotHard.length;
  result.hardNotSeamSamples = hardNotSeam.slice(0, 12)
    .map(k => k.replace('_', '-'));
  result.seamNotHardSamples = seamNotHard.slice(0, 12)
    .map(k => k.replace('_', '-'));

  return result;
}

function absVert(i) { return i < 0 ? ~i : i; }

// Given a corner (polygon-vertex) index that an FBX edge points to, find the
// other endpoint vertex of that edge by walking to the next corner in the face.
function edgePartner(geo, cIdx) {
  // Walk forward: the edge goes from corner cIdx to the next corner in the
  // same polygon (wrapping at the face's terminating negative index).
  const vStart = absVert(geo.polyIdx[cIdx]);
  // Is cIdx the last corner of its face?
  if (geo.polyIdx[cIdx] < 0) {
    // last corner -> partner is the face's first corner; walk back to start.
    let j = cIdx;
    while (j > 0 && geo.polyIdx[j - 1] >= 0) j--;
    return absVert(geo.polyIdx[j]);
  }
  const next = geo.polyIdx[cIdx + 1];
  if (next === undefined) return null;
  return absVert(next);
}

/* ========================================================================== *
 * 5. REPORTING                                                               *
 * ========================================================================== */

function report(geo, a, opts) {
  head('MESH: ' + (geo.name || '(unnamed geometry)'));
  info('Vertices       : ' + a.stats.vertices);
  info('Polygons       : ' + a.stats.polygons);
  info('Edges (unique) : ' + a.stats.edges);
  info('Border edges   : ' + a.stats.borderEdges +
    (a.stats.borderEdges ? col(C.dim, '  (open mesh boundary)') : ''));

  head('UV');
  info('UV layers      : ' + a.stats.uvLayers);
  if (a.stats.uvLayers === 0) {
    bad('No UV layer found — Painter has nothing to project the material onto.');
  } else {
    if (a.stats.uvLayers > 1) {
      warn(a.stats.uvLayers + ' UV layers present. Confirm Painter is using the' +
        ' intended one (it bakes/exports from the active set).');
    }
    const r = a.stats.uvRange;
    info('UV range       : u[' + fmt(r.uMin) + ' .. ' + fmt(r.uMax) + ']  v[' +
      fmt(r.vMin) + ' .. ' + fmt(r.vMax) + ']');
    if (a.stats.uvOutside01) {
      warn('UVs extend outside the 0–1 space (UDIM / multi-tile layout). ' +
        'Make sure Painter\'s UV-tile (UDIM) setup matches, or islands in other ' +
        'tiles get no/!wrong texels and seam.');
    } else {
      ok('UVs are within the 0–1 tile.');
    }
    info('UV seams       : ' + a.stats.uvSeams + ' edges');
  }

  head('SHADING DATA');
  if (!geo.normals) {
    bad('No vertex normals in FBX. Tangent basis is undefined -> normal seams.');
  } else {
    info('Normals        : ' + (geo.normals.values.length / 3 | 0) + ' (' +
      geo.normals.mapping + '/' + geo.normals.reference + ')');
    if (/ControlPoint/i.test(geo.normals.mapping)) {
      warn('Normals are per-control-point (per-vertex), not per-polygon-vertex. ' +
        'Hard edges cannot be represented faithfully -> baking artifacts/seams.');
    } else {
      ok('Per-polygon-vertex normals (can represent hard edges).');
    }
  }
  if (!geo.tangents) {
    warn('No tangents in FBX. Painter/baker will COMPUTE them (MikkTSpace). ' +
      'Your renderer/engine MUST use the same tangent basis or seams appear.');
  } else {
    ok('Tangents present (' + (geo.tangents.count | 0) + '). Best: ensure the ' +
      'baker & renderer agree on the basis (prefer "Use mesh tangents" consistently).');
  }
  if (!a.stats.smoothingAvailable) {
    warn('No smoothing-group / hard-edge data found. Cannot verify hard-edge ' +
      'vs UV-seam alignment. Export with smoothing groups / split normals.');
  }

  head('>>> SEAM CROSS-CHECK (normal-map seam root cause) <<<');
  if (a.stats.smoothingAvailable && a.stats.uvLayers > 0) {
    info('Hard edges            : ' + a.stats.hardEdges);
    info('Hard edges NOT on UV seam : ' + a.stats.hardNotSeam);
    if (a.stats.hardNotSeam > 0) {
      bad('^ These hard edges have NO UV seam. This is the #1 cause of visible ' +
        'normal-map seams: the baker writes a sharp normal discontinuity across ' +
        'a continuous UV region, so it shows through after applying the material.');
      bad('  FIX: add a UV seam on every hard edge (or soften the edge). Rule of ' +
        'thumb: "every hard edge must be a UV seam".');
      info('  sample edges (vertA-vertB): ' + a.hardNotSeamSamples.join(', ') +
        (a.stats.hardNotSeam > a.hardNotSeamSamples.length ? ' ...' : ''));
    } else {
      ok('Every hard edge lies on a UV seam. Good — this is the correct setup.');
    }
    info('UV seams NOT on a hard edge : ' + a.stats.seamNotHard);
    if (a.stats.seamNotHard > 0) {
      warn('^ These UV seams cut through smooth surface. Usually fine with enough ' +
        'export dilation/padding, but can show faint seams. Keep padding high.');
    }
  } else {
    warn('Cross-check skipped (need both smoothing data and a UV layer).');
  }

  head('PRIORITIZED NEXT STEPS');
  const steps = [];
  if (a.stats.uvLayers === 0)
    steps.push('Create UVs for the mesh before texturing.');
  if (a.stats.hardNotSeam > 0)
    steps.push('Align hard edges to UV seams (or soften), then re-bake in Painter.');
  if (!geo.tangents)
    steps.push('Decide a tangent workflow and use it in BOTH Painter and your ' +
      'renderer (MikkTSpace / "per fragment"); inconsistency causes seams.');
  if (a.stats.uvOutside01)
    steps.push('Verify UDIM/UV-tile setup in Painter matches the mesh tiles.');
  if (!a.stats.smoothingAvailable)
    steps.push('Re-export the FBX with smoothing groups / split (hard) normals.');
  steps.push('In Painter: set export padding to "Dilation infinite" and re-export ' +
    '(low padding makes island borders bleed/seam). Run seam_debug_painter.qml.');
  steps.push('In Painter: confirm Normal map format (OpenGL vs DirectX) matches ' +
    'your target engine — a mismatch flips green and reads as seamed lighting.');
  steps.forEach((s, i) => info((i + 1) + '. ' + s));
  hr();
}

function fmt(n) {
  if (!isFinite(n)) return 'n/a';
  return (Math.round(n * 1000) / 1000).toString();
}

/* ========================================================================== *
 * 6. MAIN                                                                    *
 * ========================================================================== */

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const file = args.find(a => !a.startsWith('-'));

  if (!file) {
    console.error('Usage: node fbx_seam_inspect.js <mesh.fbx> [--verbose]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('File not found: ' + file);
    process.exit(2);
  }

  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (e) {
    console.error('Could not read file: ' + e.message);
    process.exit(2);
  }

  let parsed;
  try {
    parsed = parseFBX(buffer);
  } catch (e) {
    console.error(col(C.red, 'FBX parse error: ') + e.message);
    process.exit(1);
  }

  console.log(col(C.bold, '\nSubstance Painter Seam Inspector — FBX analysis'));
  info('File        : ' + file);
  info('FBX version : ' + parsed.version +
    (parsed.is64 ? ' (64-bit records)' : ' (32-bit records)'));

  const geoNodes = findAll(parsed.root, 'Geometry')
    .filter(g => child(g, 'Vertices')); // skip non-mesh geometry nodes
  if (geoNodes.length === 0) {
    console.error('\nNo mesh geometry found in this FBX.');
    process.exit(1);
  }
  info('Mesh objects: ' + geoNodes.length);

  for (const g of geoNodes) {
    const geo = extractGeometry(g);
    if (verbose) {
      console.log(col(C.dim, '  [verbose] uvLayers=' + geo.uvLayers.length +
        ' polyIdx=' + geo.polyIdx.length +
        ' normalsMap=' + (geo.normals ? geo.normals.mapping : 'none') +
        ' smoothMap=' + (geo.smoothing ? geo.smoothing.mapping : 'none')));
    }
    const a = analyze(geo, { verbose });
    report(geo, a, { verbose });
  }

  console.log(col(C.dim,
    '\nDone. Pair this with seam_debug_painter.qml (in-Painter export/format check).'));
}

main();
