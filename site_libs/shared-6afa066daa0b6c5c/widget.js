
// Molstar allocates every render target of every pass when a viewer starts, illumination, depth peeling, bloom
// and the rest included, though a viewer draws with only a few: hundreds of megabytes of GPU memory per viewer at
// a Retina pixel ratio. In every WebGL context of the page, a texture or renderbuffer given storage without data
// receives it only when a draw, clear, blit, copy or read first uses it, as a framebuffer attachment or a bound
// texture; WebGL zero-fills new storage either way, so drawing is unchanged.
// Inline Markdown (bold, italic, code) with $...$ LaTeX typeset by KaTeX by the page's KaTeX; without KaTeX the
// formulas keep their source, without dollars.
function escapeHTML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function richHTML(text) {
    const math = globalThis.katex;
    return text.split(/(\$[^$]+\$)/).map(part => {
        if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) {
            return math ? math.renderToString(part.slice(1, -1), {throwOnError:false}) : escapeHTML(part.slice(1, -1));
        }
        return escapeHTML(part).replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }).join('');
}

// The field of CubeGrid.compact as cube text for Molstar's parser. Done once per field in the browser, so the page
// carries compact integers; Molstar's shaders then extract the surface at any level from the full-precision values.
function decodeField(buffer) {
    const view = new DataView(buffer);
    const headerLength = view.getUint32(0, true), knee = view.getFloat64(4, true), step = view.getFloat64(12, true);
    const header = new TextDecoder().decode(new Uint8Array(buffer, 20, headerLength));
    // The 16-bit differences are stored as all their low bytes, then all their high bytes.
    const bytes = new Uint8Array(buffer, 20 + headerLength), count = bytes.length >> 1;
    const differences = new Int16Array(count);
    for (let index = 0; index < count; index++) differences[index] = bytes[index] | (bytes[count + index] << 8);
    // Each sample is the previous one, in the grid's file order, plus its stored difference.
    const lines = [header.trimEnd()];
    let row = [], sample = 0;
    for (let index = 0; index < differences.length; index++) {
        sample += differences[index];
        row.push((knee * Math.sinh(sample * step)).toExponential(8));
        if (row.length === 6) { lines.push(row.join(' ')); row = []; }
    }
    if (row.length) lines.push(row.join(' '));
    return lines.join('\n') + '\n';
}

// Snapshots whose fields stay built at once. Each holds its field, isosurfaces and fog in Molstar's state and on the
// GPU, about a dozen megabytes for an orbital, so a viewer of many snapshots keeps only the latest it showed; one shown
// again is rebuilt, its field read from the browser's cache.
const KEPT_SNAPSHOTS = 6;

// Data kept in the store is its address, which names its content, so the browser's cache keeps it for good. A viewer's
// fields are packed into a few files: an address ending in #start-end names those bytes of one, which is fetched whole,
// once at a time, and kept for the next fields among the few files used last.
const isStored = text => /^https:\/\//.test(text);
const storedFiles = new Map();
function storedFile(url) {
    let file = storedFiles.get(url);
    if (!file) {
        file = fetch(url).then(response => {
            if (!response.ok) throw new Error(`Viewer data could not be loaded (HTTP ${response.status}).`);
            return response.arrayBuffer();
        });
        file.catch(() => storedFiles.delete(url));
    }
    storedFiles.delete(url);
    storedFiles.set(url, file);
    while (storedFiles.size > 4) storedFiles.delete(storedFiles.keys().next().value);
    return file;
}
async function readStored(address) {
    const [url, range] = address.split('#');
    const file = await storedFile(url);
    if (!range) return file;
    const [start, end] = range.split('-').map(Number);
    return file.slice(start, end);
}

// An encoded field as cube text, inflated as a stream: read from the store, or base64 the page carries, decoded
// through a data URL.
async function readField(text) {
    const encoded = isStored(text) ? new Response(await readStored(text)) : await fetch('data:application/gzip;base64,' + text);
    return decodeField(await new Response(encoded.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

// A field's smooth interpolant: a cubic B-spline through every grid value, with continuous second derivatives, so its
// level sets and their gradient normals have no kink anywhere. The spline's coefficients come from one recursive filter
// per axis. ``inverse`` is the column-major matrix from Cartesian offsets to grid coordinates. ``sample`` writes the
// value and the Cartesian gradient at a point into ``out``; it allocates nothing, because a surface evaluates it often.
// An interpolating spline rings around a singularity, such as the potential or density at a nucleus, by about a quarter
// of the jump per voxel, so a cusp of hundreds of atomic units throws false level crossings several voxels away; a clamp
// near the level rings as well, as contour-like ripples beside the surface. The spline therefore interpolates
// u = asinh(v / ``scale``), which is monotonic and odd, so every level set of v is the level set of u at asinh(level /
// scale) and keeps its sign. With the scale near the level, u is linear in v around it, nearly linear in distance
// along a density's exponential tail, and only logarithmic at a nucleus, where the spline then hardly rings.
// ``toField`` and ``fromField`` map a value of the field to u and back.
function surfaceField({data, dimensions, strides, base, inverse, origin, scale:smallest}) {
    const total = dimensions[0] * dimensions[1] * dimensions[2];
    // Across a node, where a signed field changes sign within one voxel, u = asinh(v / scale) with a small scale turns the
    // gentle slope into a near step, and the spline rings on either side of it: the surfaces of the two signs, which lie
    // close together there, wrinkle and cross. The scale is therefore raised, by doubling, until no two neighbouring
    // samples of opposite sign are more than ``jump`` apart in u; a field with no node, or a gentle one, keeps the
    // level's own scale, and a cusp, whose neighbours share a sign, is compressed as before.
    const scale = (() => {
        const jump = 3;
        let top = 0;
        for (let g = 0; g < total; g++) top = Math.max(top, Math.abs(data[base + (Math.floor(g / (dimensions[1] * dimensions[2])) * strides[0]
            + (Math.floor(g / dimensions[2]) % dimensions[1]) * strides[1] + (g % dimensions[2]) * strides[2])]));
        let trial = smallest;
        while (trial < top) {
            let worst = 0;
            for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) for (let k = 0; k < dimensions[2]; k++) {
                const here = data[base + i * strides[0] + j * strides[1] + k * strides[2]];
                for (let axis = 0; axis < 3; axis++) {
                    if ([i, j, k][axis] + 1 >= dimensions[axis]) continue;
                    const next = data[base + i * strides[0] + j * strides[1] + k * strides[2] + strides[axis]];
                    if (here * next < 0) worst = Math.max(worst, Math.abs(Math.asinh(here / trial)) + Math.abs(Math.asinh(next / trial)));
                }
            }
            if (worst <= jump) break;
            trial *= 2;
        }
        return trial;
    })();
    const coefficients = new Float64Array(total);
    for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) for (let k = 0; k < dimensions[2]; k++) {
        const flat = (i * dimensions[1] + j) * dimensions[2] + k;
        coefficients[flat] = Math.asinh(data[base + i * strides[0] + j * strides[1] + k * strides[2]] / scale);
    }
    // The field's own samples in u, before the filter replaces them with coefficients, and how far each bends from a straight
    // line along its axes: the least a cell's spline can stray beyond its corner values.
    const samples = Float64Array.from(coefficients);
    const flatStrides = [dimensions[1] * dimensions[2], dimensions[2], 1];
    const bend = new Float64Array(total);
    for (let g = 0; g < total; g++) {
        const i = Math.floor(g / flatStrides[0]), j = Math.floor(g / flatStrides[1]) % dimensions[1], k = g % dimensions[2];
        let worst = 0;
        if (i > 0 && i < dimensions[0] - 1) worst = Math.max(worst, Math.abs(samples[g - flatStrides[0]] - 2 * samples[g] + samples[g + flatStrides[0]]));
        if (j > 0 && j < dimensions[1] - 1) worst = Math.max(worst, Math.abs(samples[g - flatStrides[1]] - 2 * samples[g] + samples[g + flatStrides[1]]));
        if (k > 0 && k < dimensions[2] - 1) worst = Math.max(worst, Math.abs(samples[g - 1] - 2 * samples[g] + samples[g + 1]));
        bend[g] = worst;
    }
    const pole = Math.sqrt(3) - 2, horizon = 24;
    for (let axis = 0; axis < 3; axis++) {
        const size = dimensions[axis], stride = flatStrides[axis];
        if (size < 2) continue;
        const line = new Float64Array(size);
        const others = [0, 1, 2].filter(other => other !== axis);
        for (let u = 0; u < dimensions[others[0]]; u++) for (let v = 0; v < dimensions[others[1]]; v++) {
            const start = u * flatStrides[others[0]] + v * flatStrides[others[1]];
            for (let n = 0; n < size; n++) line[n] = 6 * coefficients[start + n * stride];
            // Causal, then anticausal, with the mirror boundary starting each pass.
            let power = 1, sum = 0;
            for (let n = 0; n < Math.min(size, horizon); n++) { sum += power * line[n]; power *= pole; }
            line[0] = sum;
            for (let n = 1; n < size; n++) line[n] += pole * line[n - 1];
            line[size - 1] = pole / (pole * pole - 1) * (line[size - 1] + pole * line[size - 2]);
            for (let n = size - 2; n >= 0; n--) line[n] = pole * (line[n + 1] - line[n]);
            for (let n = 0; n < size; n++) coefficients[start + n * stride] = line[n];
        }
    }
    const w = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    const d = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    const at = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
    const place = (axis, coordinate) => {
        const size = dimensions[axis];
        const cell = Math.max(0, Math.min(size - 2, Math.floor(coordinate))), t = coordinate - cell, s = 1 - t;
        const weights = w[axis], slopes = d[axis], offsets = at[axis];
        weights[0] = s * s * s / 6; weights[1] = (4 + t * t * (3 * t - 6)) / 6;
        weights[2] = (1 + t * (3 + t * (3 - 3 * t))) / 6; weights[3] = t * t * t / 6;
        slopes[0] = -s * s / 2; slopes[1] = t * (3 * t - 4) / 2; slopes[2] = (1 + t * (2 - 3 * t)) / 2; slopes[3] = t * t / 2;
        for (let k = 0; k < 4; k++) {
            // Mirrored past the grid's ends, as the filter assumed.
            let index = cell - 1 + k;
            if (index < 0) index = -index; else if (index >= size) index = 2 * size - 2 - index;
            offsets[k] = index * flatStrides[axis];
        }
    };
    const sample = (x, y, z, out) => {
        const rx = x - origin[0], ry = y - origin[1], rz = z - origin[2];
        place(0, inverse[0] * rx + inverse[3] * ry + inverse[6] * rz);
        place(1, inverse[1] * rx + inverse[4] * ry + inverse[7] * rz);
        place(2, inverse[2] * rx + inverse[5] * ry + inverse[8] * rz);
        let value = 0, gi = 0, gj = 0, gk = 0;
        for (let a = 0; a < 4; a++) {
            const A = at[0][a];
            for (let b = 0; b < 4; b++) {
                const B = A + at[1][b];
                let along = 0, slope = 0;
                for (let c = 0; c < 4; c++) { const f = coefficients[B + at[2][c]]; along += f * w[2][c]; slope += f * d[2][c]; }
                const wab = w[0][a] * w[1][b];
                value += along * wab; gi += along * d[0][a] * w[1][b]; gj += along * w[0][a] * d[1][b]; gk += slope * wab;
            }
        }
        out[0] = value;
        // The gradient in grid coordinates to Cartesian, through the inverse's transpose.
        out[1] = inverse[0] * gi + inverse[1] * gj + inverse[2] * gk;
        out[2] = inverse[3] * gi + inverse[4] * gj + inverse[5] * gk;
        out[3] = inverse[6] * gi + inverse[7] * gj + inverse[8] * gk;
    };
    const toField = value => Math.asinh(value / scale), fromField = u => scale * Math.sinh(u);
    return {sample, toField, fromField, coefficients, samples, bend, dimensions};
}

// The level set of the spline as a closed triangle mesh, built only where the surface can be: every cell of the grid whose
// samples, widened by how far the spline can bend beyond them, bracket the level is evaluated on a lattice ``factor`` times
// finer (twice, which resolves the thin sheets of a surface as three times does, with a third of the triangles) and cut into tetrahedra, six to a lattice cube split the same way in every cube, so neighbours share their faces and no crack or ambiguous case arises, so the surface is as fine as that lattice while the cells away from it cost
// nothing. Vertices are shared across cells by their lattice edge. ``hand`` and ``side`` match Molstar's conventions;
// normals are left to settleMesh.
function sparseMesh(field, level, {hand, side}, toCartesian, toVector, groupOf, factor = 2) {
    const {coefficients, samples, bend, dimensions:[n0, n1, n2]} = field, F = factor, R = F + 1;
    const sgn = Math.sign(level) || 1, plane = n1 * n2, m1 = (n1 - 1) * F + 1, m2 = (n2 - 1) * F + 1;
    const total = ((n0 - 1) * F + 1) * m1 * m2;
    const weights = Array.from({length:R}, (_, r) => {
        const t = r / F, s = 1 - t;
        return [s * s * s / 6, (4 + t * t * (3 * t - 6)) / 6, (1 + t * (3 + t * (3 - 3 * t))) / 6, t * t * t / 6];
    });
    const mirror = (index, n) => index < 0 ? -index : index >= n ? 2 * n - 2 - index : index;
    const tmpX = new Float64Array(R * 4 * 4), tmpY = new Float64Array(R * R * 4), nodes = new Float64Array(R * R * R);
    const rowX = new Int32Array(4), rowY = new Int32Array(4), rowZ = new Int32Array(4);
    // The spline's values on the R by R by R lattice nodes of one cell, from the 4 by 4 by 4 coefficients around it.
    const evaluate = (i, j, k) => {
        for (let a = 0; a < 4; a++) {
            rowX[a] = mirror(i - 1 + a, n0) * plane; rowY[a] = mirror(j - 1 + a, n1) * n2; rowZ[a] = mirror(k - 1 + a, n2);
        }
        for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) {
            const at = rowY[b] + rowZ[c];
            const c0 = coefficients[rowX[0] + at], c1 = coefficients[rowX[1] + at], c2 = coefficients[rowX[2] + at], c3 = coefficients[rowX[3] + at];
            for (let x = 0; x < R; x++) {
                const w = weights[x];
                tmpX[(x * 4 + b) * 4 + c] = w[0] * c0 + w[1] * c1 + w[2] * c2 + w[3] * c3;
            }
        }
        for (let x = 0; x < R; x++) for (let c = 0; c < 4; c++) for (let y = 0; y < R; y++) {
            const w = weights[y], at = x * 16 + c;
            tmpY[(x * R + y) * 4 + c] = w[0] * tmpX[at] + w[1] * tmpX[at + 4] + w[2] * tmpX[at + 8] + w[3] * tmpX[at + 12];
        }
        for (let x = 0; x < R; x++) for (let y = 0; y < R; y++) for (let z = 0; z < R; z++) {
            const w = weights[z], at = (x * R + y) * 4;
            nodes[(x * R + y) * R + z] = w[0] * tmpY[at] + w[1] * tmpY[at + 1] + w[2] * tmpY[at + 2] + w[3] * tmpY[at + 3];
        }
    };
    const P = [], N = [], G = [], I = [], edges = new Map();
    const point = new Float64Array(3), lattice = new Float64Array(3), outward = new Float64Array(3), cross = new Float64Array(3);
    const vertex = (ga, gb, va, vb, ax, ay, az, bx, by, bz) => {
        const key = ga < gb ? ga * total + gb : gb * total + ga;
        let v = edges.get(key);
        if (v !== undefined) return v;
        const t = (level - va) / (vb - va);
        lattice[0] = (ax + t * (bx - ax)) / F; lattice[1] = (ay + t * (by - ay)) / F; lattice[2] = (az + t * (bz - az)) / F;
        toCartesian(lattice, point);
        v = P.length / 3;
        P.push(point[0], point[1], point[2]);
        N.push(0, 0, 0);
        G.push(groupOf(lattice));
        edges.set(key, v);
        return v;
    };
    const triangle = (a, b, c) => {
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
        cross[0] = uy * vz - uz * vy; cross[1] = uz * vx - ux * vz; cross[2] = ux * vy - uy * vx;
        const facing = cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2];
        if (facing * side * hand < 0) I.push(a, c, b); else I.push(a, b, c);
    };
    const tetrahedra = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];
    const value = new Float64Array(8), node = new Float64Array(8), cx = new Int32Array(8), cy = new Int32Array(8), cz = new Int32Array(8);
    const ins = [], outs = [], local = new Float64Array(3);
    for (let i = 0; i < n0 - 1; i++) for (let j = 0; j < n1 - 1; j++) for (let k = 0; k < n2 - 1; k++) {
        // The cell is cut if the level lies between its samples, widened by the most the spline can bend beyond them.
        const g = i * plane + j * n2 + k;
        let low = Infinity, high = -Infinity, pad = 0;
        for (let c = 0; c < 8; c++) {
            const at = g + (c & 1) * plane + ((c >> 1) & 1) * n2 + ((c >> 2) & 1), u = samples[at];
            if (u < low) low = u;
            if (u > high) high = u;
            if (bend[at] > pad) pad = bend[at];
        }
        pad *= 0.3;
        if (level < low - pad || level > high + pad) continue;
        evaluate(i, j, k);
        for (let a = 0; a < F; a++) for (let b = 0; b < F; b++) for (let c = 0; c < F; c++) {
            let count = 0;
            for (let q = 0; q < 8; q++) {
                const x = a + (q & 1), y = b + ((q >> 1) & 1), z = c + ((q >> 2) & 1);
                cx[q] = i * F + x; cy[q] = j * F + y; cz[q] = k * F + z;
                value[q] = nodes[(x * R + y) * R + z];
                node[q] = (cx[q] * m1 + cy[q]) * m2 + cz[q];
                if ((value[q] - level) * sgn > 0) count++;
            }
            if (count === 0 || count === 8) continue;
            for (const tet of tetrahedra) {
                ins.length = 0; outs.length = 0;
                for (const q of tet) ((value[q] - level) * sgn > 0 ? ins : outs).push(q);
                if (!ins.length || !outs.length) continue;
                local.fill(0);
                for (const q of outs) { local[0] += (q & 1) / outs.length; local[1] += ((q >> 1) & 1) / outs.length; local[2] += ((q >> 2) & 1) / outs.length; }
                for (const q of ins) { local[0] -= (q & 1) / ins.length; local[1] -= ((q >> 1) & 1) / ins.length; local[2] -= ((q >> 2) & 1) / ins.length; }
                toVector(local, outward);
                const at = (a2, b2) => vertex(node[a2], node[b2], value[a2], value[b2], cx[a2], cy[a2], cz[a2], cx[b2], cy[b2], cz[b2]);
                if (ins.length === 2) {
                    const [p, q] = ins, [r, s] = outs;
                    const pr = at(p, r), ps = at(p, s), qs = at(q, s), qr = at(q, r);
                    triangle(pr, ps, qs); triangle(pr, qs, qr);
                } else {
                    const [lone, others] = ins.length === 1 ? [ins[0], outs] : [outs[0], ins];
                    triangle(at(lone, others[0]), at(lone, others[1]), at(lone, others[2]));
                }
            }
        }
    }
    return {positions:Float32Array.from(P), normals:Float32Array.from(N), groups:Float32Array.from(G),
            indices:Uint32Array.from(I), vertices:P.length / 3, triangles:I.length / 3};
}

// Puts every vertex of a mesh on the level set, by Newton steps along the spline's gradient, and gives it that gradient as its
// normal, so shading is exact however the triangles lie. ``orient`` is +1 or -1: every normal is the gradient times it.
function settleMesh(field, mesh, level, step, orient) {
    const out = new Float64Array(4), P = mesh.positions, N = mesh.normals;
    for (let v = 0; v < mesh.vertices; v++) {
        let x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        for (let iteration = 0; iteration < 3; iteration++) {
            field.sample(x, y, z, out);
            const squared = out[1] * out[1] + out[2] * out[2] + out[3] * out[3];
            if (!(squared > 0)) break;
            let scale = (out[0] - level) / squared;
            const length = Math.abs(scale) * Math.sqrt(squared);
            if (length > step / 2) scale *= step / 2 / length;
            x -= scale * out[1]; y -= scale * out[2]; z -= scale * out[3];
            if (length < 1e-6 * step) break;
        }
        field.sample(x, y, z, out);
        const norm = Math.hypot(out[1], out[2], out[3]), scale = norm > 0 ? orient / norm : 0;
        P[3 * v] = x; P[3 * v + 1] = y; P[3 * v + 2] = z;
        N[3 * v] = scale * out[1]; N[3 * v + 1] = scale * out[2]; N[3 * v + 2] = scale * out[3];
    }
    return mesh;
}

// Molstar's winding (``hand``: whether a triangle's edges turn about its stored normal) and normal side (``side``: whether the
// stored normal points out of the region beyond the level), read by majority from the mesh it built.
function meshConvention(field, mesh, level) {
    const out = new Float64Array(4), P = mesh.positions, N = mesh.normals, I = mesh.indices, outward = -(Math.sign(level) || 1);
    let hand = 0, side = 0;
    for (let t = 0; t < Math.min(mesh.triangles, 200); t++) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2];
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
        const nx = N[3 * a], ny = N[3 * a + 1], nz = N[3 * a + 2];
        hand += Math.sign((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz);
        field.sample(P[3 * a], P[3 * a + 1], P[3 * a + 2], out);
        side += Math.sign(outward * (nx * out[1] + ny * out[2] + nz * out[3]));
    }
    return {hand:hand < 0 ? -1 : 1, side:side < 0 ? -1 : 1};
}

// A colour list interpolated linearly over [lower, upper], clamped at its ends, as the legend draws it.
function colorScale(colors, [lower, upper]) {
    const span = upper - lower || 1, last = colors.length - 1;
    return value => {
        const x = Math.min(1, Math.max(0, (value - lower) / span)) * last, i = Math.min(Math.floor(x), Math.max(last - 1, 0)), u = x - i;
        const a = colors[i], b = colors[Math.min(i + 1, last)];
        const mix = shift => Math.round(((a >> shift) & 255) * (1 - u) + ((b >> shift) & 255) * u);
        return (mix(16) << 16) | (mix(8) << 8) | mix(0);
    };
}

// Refines one isosurface representation's new mesh in place, in the buffers Molstar draws, and returns its triangle count;
// a mesh already refined at this geometry is left alone.
const refinedMeshes = new WeakMap();
let viewerCount = 0;

// A field's spline kept for the meshes drawn from it, the ``limit`` most recently used: building it and its lattice is the
// larger part of a surface's cost, and one field serves both signs of a signed surface.
function fieldCache(limit) {
    const fields = new Map();
    return spec => {
        let field = fields.get(spec.key);
        if (field) fields.delete(spec.key); else field = surfaceField(spec.source);
        fields.set(spec.key, field);
        while (fields.size > limit) fields.delete(fields.keys().next().value);
        return field;
    };
}

// The colour of every vertex of a mesh, for a surface coloured by a field: a texture of three bytes a vertex, which reads
// the colour field through its own spline so colours vary as smoothly as the surface.
function vertexColors(mesh, job, fieldOf) {
    const colorField = fieldOf(job.colorField), colorOf = colorScale(job.coloring.colors, job.coloring.range);
    const width = Math.max(1, Math.ceil(Math.sqrt(mesh.vertices))), height = Math.max(1, Math.ceil(mesh.vertices / width));
    const array = new Uint8Array(width * height * 3), sampled = new Float64Array(4);
    for (let v = 0; v < mesh.vertices; v++) {
        colorField.sample(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2], sampled);
        const rgb = colorOf(colorField.fromField(sampled[0]));
        array[3 * v] = (rgb >> 16) & 255; array[3 * v + 1] = (rgb >> 8) & 255; array[3 * v + 2] = rgb & 255;
    }
    return {array, width, height};
}

// One surface from a job, in one step: the level set of the field's spline, cut on a lattice twice as fine as the grid wherever
// the surface can be, with every vertex on the level set and the spline's gradient as its normal, so it
// is accurate at once. It reads nothing but the job, so it runs in a worker as well as on the page; ``fieldOf`` gives the
// spline of a field named by the job. Returns the mesh, its colour texture for a coloured surface and Molstar's winding for this sign.
function denseSurface(job, fieldOf) {
    const field = fieldOf(job.field), level = field.toField(job.value), matrix = job.matrix, strides = job.strides;
    const [d0, d1, d2] = job.dimensions;
    const toCartesian = (g, out) => {
        for (let k = 0; k < 3; k++) out[k] = matrix[k] * g[0] + matrix[4 + k] * g[1] + matrix[8 + k] * g[2] + matrix[12 + k];
    };
    const toVector = (g, out) => {
        for (let k = 0; k < 3; k++) out[k] = matrix[k] * g[0] + matrix[4 + k] * g[1] + matrix[8 + k] * g[2];
    };
    const groupOf = g => job.origin + Math.min(d0 - 1, Math.max(0, Math.round(g[0]))) * strides[0]
        + Math.min(d1 - 1, Math.max(0, Math.round(g[1]))) * strides[1] + Math.min(d2 - 1, Math.max(0, Math.round(g[2]))) * strides[2];
    // Molstar's winding is the same for every surface of a sign, so a job may carry it instead of a mesh to read it from.
    const convention = job.convention || meshConvention(field, job.original, level);
    // Normals point out of the region beyond the level, down the gradient for a positive level, on Molstar's side.
    const orient = convention.side * -(Math.sign(level) || 1);
    const mesh = settleMesh(field, sparseMesh(field, level, convention, toCartesian, toVector, groupOf), level, job.step, orient);
    return {mesh, color:job.colorField ? vertexColors(mesh, job, fieldOf) : null, convention};
}

// The source of the worker that builds surfaces, from the functions above, so that the page stays responsive while a surface is
// built. Work for the newest selection of a viewer comes first: a job of an older selection that has not started is dropped.
const meshWorkerSource = () => [surfaceField, sparseMesh, settleMesh, meshConvention, colorScale, fieldCache, vertexColors,
    denseSurface].map(String).join('\n') + `
const fieldOf = ${fieldCache.name}(3);
const queue = [], newestEpoch = new Map();
let running = false;
function handle(data) {
    try {
        const {mesh, color, convention} = ${denseSurface.name}(data, fieldOf);
        self.postMessage({id:data.id, stage:1, mesh, color, convention}, [mesh.positions.buffer, mesh.normals.buffer,
            mesh.groups.buffer, mesh.indices.buffer, ...(color ? [color.array.buffer] : [])]);
    } catch (error) {
        self.postMessage({id:data.id, stage:0, error:String(error && error.stack || error)});
    }
}
async function pump() {
    running = true;
    // Lets the jobs that are already waiting arrive, so that the newest of them is the one that starts.
    await new Promise(resolve => setTimeout(resolve, 0));
    while (queue.length) {
        const newest = new Map(newestEpoch);
        for (const job of queue) newest.set(job.scope, Math.max(newest.get(job.scope) ?? -1, job.epoch));
        for (let at = queue.length - 1; at >= 0; at--) {
            if (queue[at].epoch < newest.get(queue[at].scope)) self.postMessage({id:queue.splice(at, 1)[0].id, stage:-1});
        }
        if (queue.length) handle(queue.shift());
        // Lets a notice or a job that arrived meanwhile be seen before the next one starts.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    running = false;
}
self.onmessage = ({data}) => {
    // A notice that a viewer's selection changed, sent to every worker, so that a worker drops the older jobs it holds.
    if (data.notice) { newestEpoch.set(data.scope, Math.max(newestEpoch.get(data.scope) ?? -1, data.epoch)); return; }
    queue.push(data);
    if (!running) pump();
};`;

// Builds a surface in a worker, or on the page where a worker cannot be made. The surfaces at plus and minus a level, those of
// other snapshots and those of other viewers are built at once, in as many workers as the machine can spare. The promise resolves with the accurate surface, or
// with null if a newer selection of the viewer made the worker drop the job.
const meshWorker = {pool:[], failed:false, pending:new Map(), count:0, fields:null,
    // As many workers as the machine can spare, up to four, started as work needs them.
    size:Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))};
function startMeshWorker() {
    const worker = new Worker(URL.createObjectURL(new Blob([meshWorkerSource()], {type:'text/javascript'})));
    // ``load`` counts the jobs given to the worker whose surface has not come back; ``keys`` are the fields whose splines it
    // holds, the latest first.
    const info = {worker, load:0, keys:[]};
    const fail = message => {
        for (const waiting of meshWorker.pending.values()) waiting.reject(new Error(message));
        meshWorker.pending.clear();
        info.load = 0;
    };
    worker.onmessage = ({data}) => {
        const waiting = meshWorker.pending.get(data.id);
        if (!waiting) return;
        meshWorker.pending.delete(data.id);
        waiting.info.load--;
        // 1: the surface; -1: the job was dropped for a newer selection; 0: it failed.
        if (data.stage === 1) waiting.resolve(data);
        else if (data.stage === -1) waiting.resolve(null);
        else waiting.reject(new Error(data.error));
    };
    worker.onerror = event => fail(event.message || 'The surface worker failed');
    return info;
}
// Tells every worker that a viewer's selection changed, so that none of them starts a job of an older one.
function announceSelection(selection) {
    for (const info of meshWorker.pool) info.worker.postMessage({notice:true, scope:selection.scope, epoch:selection.epoch});
}
// The worker for a job: the least loaded, preferring one that already holds the field's spline, and a new one while the machine has
// cores to spare and every worker is busy.
function workerFor(job) {
    let best = null;
    for (const info of meshWorker.pool) {
        const cost = info.load + (info.keys.includes(job.field.key) ? 0 : 0.5);
        if (!best || cost < best.cost) best = {info, cost};
    }
    if ((!best || best.info.load > 0) && meshWorker.pool.length < meshWorker.size) {
        const info = startMeshWorker();
        meshWorker.pool.push(info);
        best = {info};
    }
    const info = best.info;
    info.keys = [job.field.key, ...info.keys.filter(key => key !== job.field.key)].slice(0, 3);
    return info;
}
function buildSurface(job) {
    let info = null;
    if (!meshWorker.failed) {
        try {
            info = workerFor(job);
        } catch (error) {
            meshWorker.failed = true;
        }
    }
    if (!info) {
        meshWorker.fields ??= fieldCache(3);
        return Promise.resolve().then(() => denseSurface(job, meshWorker.fields));
    }
    return new Promise((resolve, reject) => {
        const id = ++meshWorker.count;
        meshWorker.pending.set(id, {resolve, reject, info});
        info.load++;
        info.worker.postMessage({...job, id});
    });
}

// The field of a volume as the worker takes it: its samples, grid and the scale of its spline, under a key naming them.
const volumeIds = new WeakMap();
function fieldSpec(volume, scale) {
    const grid = volume.grid;
    if (grid?.transform?.kind !== 'matrix') return null;
    const {Mat3} = molstar.lib.math.LinearAlgebra;
    const matrix = grid.transform.matrix, transform = Mat3.fromMat4(Mat3(), matrix);
    if (!Mat3.determinant(transform)) return null;
    if (!volumeIds.has(volume)) volumeIds.set(volume, (volumeIds.total = (volumeIds.total || 0) + 1));
    const {space, data} = grid.cells, origin = space.dataOffset(0, 0, 0);
    return {key:`${volumeIds.get(volume)}:${scale}`, source:{data, dimensions:[...space.dimensions], base:origin,
        origin:[matrix[12], matrix[13], matrix[14]],
        strides:[space.dataOffset(1, 0, 0) - origin, space.dataOffset(0, 1, 0) - origin, space.dataOffset(0, 0, 1) - origin],
        inverse:Array.from(Mat3.invert(Mat3(), transform)), scale}};
}

// How Molstar winds its meshes for the surfaces of each sign, read from the first one built and then known without a mesh.
const surfaceConventions = new Map();

// The job that builds the surface of a volume at ``value``: its fields as the worker takes them, with the spline's scale a
// power of two at or below the level, so that nearby levels share one spline and one lattice. ``original`` is Molstar's mesh
// of the surface, from which its winding is read when it is not yet known. Null where the volume has no matrix grid.
function surfaceJob(volume, coloring, value, original = null, selection = {scope:0, epoch:0}) {
    const grid = volume?.grid, floorPower = magnitude => 2 ** Math.floor(Math.log2(magnitude || 1));
    const field = grid && fieldSpec(volume, floorPower(Math.abs(value)));
    if (!field) return null;
    const colorField = coloring && fieldSpec(coloring.volume, floorPower(Math.max(...coloring.range.map(Math.abs))));
    const {Vec3} = molstar.lib.math.LinearAlgebra;
    const matrix = grid.transform.matrix, {space} = grid.cells, origin = space.dataOffset(0, 0, 0);
    const convention = surfaceConventions.get(Math.sign(value));
    if (!original && !convention) return null;
    return {field, colorField, value, matrix:Array.from(matrix),
        step:Math.min(...[0, 4, 8].map(offset => Vec3.magnitude(Vec3.fromArray(Vec3(), matrix, offset)))), origin,
        strides:[space.dataOffset(1, 0, 0) - origin, space.dataOffset(0, 1, 0) - origin, space.dataOffset(0, 0, 1) - origin],
        dimensions:[...space.dimensions], coloring:coloring && {colors:coloring.colors, range:coloring.range},
        convention, original:convention ? null : original, scope:selection.scope, epoch:selection.epoch};
}

// A mesh being refined, so that a request arriving meanwhile waits for it and then refines what Molstar built since.
const refining = new WeakMap();
function refineObject(object, work) {
    let entry = refining.get(object);
    if (entry) { entry.again = true; entry.work = work; return entry.promise; }
    entry = {again:false, work, result:0};
    entry.promise = (async () => {
        try {
            do { entry.again = false; entry.result = await entry.work(); } while (entry.again);
        } finally {
            refining.delete(object);
        }
        return entry.result;
    })();
    refining.set(object, entry);
    return entry.promise;
}

// Makes one isosurface representation's new mesh smooth, in the buffers Molstar draws, and resolves to its triangle count
// once the worker has built it; Molstar's own mesh shows meanwhile. A mesh already refined at this geometry is left alone.
// ``coloring`` is the registered colour field, its colours and range, for a surface coloured by one.
async function refineIsosurface(cell, volume, coloring, prefetched, selection) {
    const repr = cell?.obj?.data?.repr, iso = cell?.transform?.params?.type?.params?.isoValue, grid = volume?.grid;
    if (!repr || !iso) return 0;
    const value = iso.kind === 'absolute' ? iso.absoluteValue : iso.relativeValue * grid.stats.sigma + grid.stats.mean;
    if (!fieldSpec(volume, 1)) return 0;
    const set = (target, content) => { target.ref.value = content; target.ref.version += 1; };
    const tasks = [];
    for (const object of repr.renderObjects) {
        const values = object.values;
        if (values.dGeometryType?.ref.value !== 'mesh' || !values.aPosition || !values.aNormal) continue;
        tasks.push(refineObject(object, async () => {
            const array = values.aPosition.ref.value, version = values.aPosition.ref.version;
            if (refinedMeshes.get(array) === version) return values.drawCount.ref.value / 3;
            // The job may already be under way: the viewer starts it before Molstar's own mesh is ready.
            const started = prefetched?.get(String(value));
            prefetched?.delete(String(value));
            const result = await (started ?? buildSurface(surfaceJob(volume, coloring, value, {
                positions:values.aPosition.ref.value, normals:values.aNormal.ref.value, groups:values.aGroup.ref.value,
                indices:values.elements.ref.value, vertices:values.uVertexCount.ref.value, triangles:values.drawCount.ref.value / 3}, selection)));
            // A newer selection of the viewer made the worker drop this job: Molstar's own mesh stays until it is replaced.
            if (!result) return values.drawCount.ref.value / 3;
            const {mesh, color} = result;
            surfaceConventions.set(Math.sign(value), result.convention);
            // A mesh Molstar replaced while this one was built is refined by the request that follows its replacement.
            if (values.aPosition.ref.value !== array || values.aPosition.ref.version !== version) return values.drawCount.ref.value / 3;
            set(values.aPosition, mesh.positions); set(values.aNormal, mesh.normals); set(values.aGroup, mesh.groups);
            set(values.elements, mesh.indices); set(values.drawCount, 3 * mesh.triangles); set(values.uVertexCount, mesh.vertices);
            // A coloured surface takes one colour per vertex, so the colour texture covers every new vertex.
            if (color) {
                set(values.tColor, {array:color.array, width:color.width, height:color.height});
                set(values.uColorTexDim, new Float32Array([color.width, color.height]));
            }
            refinedMeshes.set(mesh.positions, values.aPosition.ref.version);
            return mesh.triangles;
        }));
    }
    return (await Promise.all(tasks)).reduce((sum, count) => sum + count, 0);
}

function signedTeX(value) {
    if (Math.abs(value) < 1e-12) return '0';
    const text = Number(value.toPrecision(4)).toString();
    return (value > 0 ? '+' : '') + text.replace(/e([+-]?)(\d+)/, (_, sign, power) => `\\times10^{${sign === '-' ? '-' : ''}${power}}`);
}

// Map fog volumes back to their original field values for hover labels.
const fogFields = new WeakMap(), fogOriginals = new WeakMap();

// Replaces Molstar's highlight labels, which join chain, entity, model and instance codes with bars, by labels in
// words with LaTeX: the atom, bond, measurement, field value or surface under the pointer. Every loci kind Molstar
// defines is covered; shapes, segments and particles keep their own label text, joined with commas instead of bars.
// ``currentView`` gives the shown view of a volume viewer's field, whose quantity names field values; none for molecules.
// ``currentDetails`` gives the hover details of the atoms as now shown, such as each atom's share of the shown orbital.
function installLabels(plugin, model, currentView, currentDetails = () => model.get('atom_details') || []) {
    const {StructureElement, StructureProperties} = molstar.lib.structure;
    const {Loci} = molstar.lib.loci;
    const manager = plugin.managers.lociLabels;
    // Molstar's providers, including any registered later, feed only the kinds left to them.
    const native = manager.providers;
    manager.providers = [];
    manager.addProvider = provider => { native.push(provider); native.sort((a, b) => (b.priority || 0) - (a.priority || 0)); };
    manager.removeProvider = provider => { const at = native.indexOf(provider); if (at >= 0) native.splice(at, 1); };
    const nativeText = (loci, repr) => native.map(provider => provider.label(loci, repr)).filter(Boolean)
        .map(text => text.replace(/\s*\|\s*/g, ', ')).join('</br>');
    const groups = model.get('annotations') || [];
    // Earlier annotations take precedence for atoms in multiple groups.
    const atomGroups = new Map();
    groups.forEach(group => (group.atoms || []).forEach(index => {
        if (!atomGroups.has(index)) atomGroups.set(index, group);
    }));
    // Virtual points are named by their label wherever an atom's name would stand.
    const markerLabels = new Map((model.get('markers') || []).flatMap(marker => marker.label ? marker.atoms.map(atom => [atom, marker.label]) : []));
    const atom = location => {
        const unit = location.unit;
        const index = unit.model.atomicConformation.atomId.value(location.element) + 1;
        const symbol = StructureProperties.atom.type_symbol(location);
        return {index, symbol, position:[StructureProperties.atom.x(location), StructureProperties.atom.y(location),
                                         StructureProperties.atom.z(location)]};
    };
    // An atom as its element symbol with its one-based number as a subscript, such as C_{15}.
    const atomTeX = a => markerLabels.has(a.index) ? markerLabels.get(a.index) : `\\mathrm{${a.symbol}}_{${a.index}}`;
    const first = loci => atom(StructureElement.Loci.getFirstLocation(loci));
    const {Vec3} = molstar.lib.math.LinearAlgebra;
    const distance = Vec3.distance;
    const angle = (p, q, r) => Vec3.angle(Vec3.sub(Vec3(),p,q), Vec3.sub(Vec3(),r,q)) * 180 / Math.PI;
    // Preserve the existing displayed torsion convention, opposite to Molstar's signed angle.
    const dihedral = (a, b, c, d) => -Vec3.dihedralAngle(a,b,c,d) * 180 / Math.PI;
    const lines = parts => parts.filter(Boolean).join('</br>');
    const field = () => {
        const view = currentView();
        // A field named only by its symbol has no top line; the name may hold $...$ LaTeX.
        return {name:view?.field_name || (view?.field_symbol ? '' : 'Field'), symbol:view?.field_symbol, unit:view?.field_unit, scale:view?.field_scale || 1};
    };
    // The number is braced, so a leading sign reads as part of it rather than as an operator after the equals sign.
    const value = (f, v) => f.symbol ? richHTML(`$${f.symbol}={${signedTeX(v * f.scale)}}${f.unit ? '\\,' + f.unit : ''}$`)
        : richHTML(`value $${signedTeX(v * f.scale)}$`);
    function label(loci, repr) {
        switch (loci.kind) {
            case 'element-loci': {
                const size = StructureElement.Loci.size(loci);
                if (size !== 1) return `<b>${size} atoms</b>`;
                const a = first(loci);
                const group = atomGroups.get(a.index), details = currentDetails();
                return lines([`<b>${richHTML(`$${atomTeX(a)}$`)}</b>`, details[a.index - 1] && richHTML(details[a.index - 1]),
                              group && richHTML(group.text)]);
            }
            case 'bond-loci': {
                const bond = loci.bonds[0];
                if (!bond) return '';
                const end = (unit, index) => atom(StructureElement.Location.create(loci.structure, unit, unit.elements[index]));
                const a = end(bond.aUnit, bond.aIndex), b = end(bond.bUnit, bond.bIndex);
                return lines([`<b>${richHTML(`$${atomTeX(a)}\\text{–}${atomTeX(b)}$`)}</b>`,
                              richHTML(`$r=${distance(a.position, b.position).toFixed(3)}\\,\\text{\\AA}$`)]);
            }
            case 'data-loci': {
                // Native measurements: distances, angles and dihedrals between atoms.
                const parts = loci.elements?.[0]?.loci;
                if (Array.isArray(parts) && parts.length >= 2 && parts.length <= 4
                    && parts.every(part => part.kind === 'element-loci')) {
                    const atoms = parts.map(first), centres = parts.map(part => Array.from(Loci.getCenter(part)));
                    const chain = atoms.map(atomTeX).join('\\text{–}');
                    const quantity = parts.length === 2 ? `d=${distance(...centres).toFixed(3)}\\,\\text{\\AA}`
                        : parts.length === 3 ? `\\theta=${angle(...centres).toFixed(2)}^{\\circ}`
                        : `\\varphi=${dihedral(...centres).toFixed(2)}^{\\circ}`;
                    return lines([`<b>${richHTML(`$${chain}$`)}</b>`, richHTML(`$${quantity}$`)]);
                }
                return nativeText(loci, repr);
            }
            case 'cell-loci': {
                const f = field();
                const index = Number((nativeText(loci, repr).match(/Cell #(\d+)/) || [])[1]);
                if (!Number.isFinite(index)) return f.name ? `<b>${richHTML(f.name)}</b>` : '';
                const original = fogOriginals.get(loci.volume), stored = loci.volume.grid.cells.data[index], inverse = fogFields.get(loci.volume);
                return lines([f.name && `<b>${richHTML(f.name)}</b>`, value(f, original ? original[index] : inverse ? inverse(stored) : stored)]);
            }
            case 'isosurface-loci': {
                const f = field(), iso = loci.isoValue;
                const level = iso.kind === 'absolute' ? iso.absoluteValue
                    : iso.relativeValue * loci.volume.grid.stats.sigma + loci.volume.grid.stats.mean;
                return lines([f.name && `<b>${richHTML(f.name)} surface</b>`, value(f, level)]);
            }
            case 'volume-loci':
                return field().name ? `<b>${richHTML(field().name)}</b>` : '';
            case 'structure-loci':
                return '<b>Molecule</b>';
            case 'every-loci':
            case 'empty-loci':
                return '';
            default:
                // Shapes, shape groups (such as arrows with their tooltips), segments and particles.
                return nativeText(loci, repr);
        }
    }
    manager.providers.push({label, priority:0});
}

function installLazyTargets() {
    if (globalThis.molstarLazyTargets) return;
    globalThis.molstarLazyTargets = true;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const gl = getContext.call(this, type, ...rest);
        if (gl && /^(webgl2?|experimental-webgl)$/.test(type) && !gl.lazyTargets) deferStorage(gl);
        return gl;
    };
}

function deferStorage(gl) {
    gl.lazyTargets = true;
    const FRAMEBUFFER = gl.FRAMEBUFFER, DRAW = 0x8CA9, READ = 0x8CA8;
    // Deferred storage calls by object, the textures bound to each unit and target, and each framebuffer's attachments.
    const pending = new Map(), units = [{}], attachments = new Map();
    let unit = 0, renderbuffer = null, draw = null, read = null;
    const call = (name, args) => gl.constructor.prototype[name].apply(gl, args);
    const own = (name, wrapper) => { const original = gl[name].bind(gl); gl[name] = (...args) => wrapper(original, ...args); };
    function realize(object) {
        const deferred = pending.get(object);
        if (!deferred) return;
        pending.delete(object);
        if (deferred.texture) {
            const previous = units[unit][deferred.target] ?? null;
            call('bindTexture', [deferred.target, object]);
            call(deferred.name, deferred.args);
            call('bindTexture', [deferred.target, previous]);
        } else {
            call('bindRenderbuffer', [gl.RENDERBUFFER, object]);
            call(deferred.name, deferred.args);
            call('bindRenderbuffer', [gl.RENDERBUFFER, renderbuffer]);
        }
    }
    const realizeFramebuffer = framebuffer => { for (const object of attachments.get(framebuffer)?.values() ?? []) realize(object); };
    const realizeBound = () => { for (const targets of units) if (targets) for (const object of Object.values(targets)) if (object) realize(object); };
    const use = (reads, draws) => () => { if (!pending.size) return; if (draws) { realizeFramebuffer(draw); realizeBound(); } if (reads) realizeFramebuffer(read); };
    own('activeTexture', (original, texture) => { unit = texture - gl.TEXTURE0; units[unit] ??= {}; original(texture); });
    own('bindTexture', (original, target, texture) => { units[unit][target] = texture; original(target, texture); });
    own('bindRenderbuffer', (original, target, object) => { renderbuffer = object; original(target, object); });
    own('bindFramebuffer', (original, target, framebuffer) => {
        if (target === FRAMEBUFFER || target === DRAW) draw = framebuffer;
        if (target === FRAMEBUFFER || target === READ) read = framebuffer;
        original(target, framebuffer);
    });
    const attach = (target, attachment, object) => {
        const framebuffer = target === READ ? read : draw;
        if (!framebuffer) return;
        if (!attachments.has(framebuffer)) attachments.set(framebuffer, new Map());
        attachments.get(framebuffer).set(attachment, object);
    };
    own('framebufferTexture2D', (original, target, attachment, textarget, texture, level) => { attach(target, attachment, texture); original(target, attachment, textarget, texture, level); });
    own('framebufferRenderbuffer', (original, target, attachment, rbtarget, object) => { attach(target, attachment, object); original(target, attachment, rbtarget, object); });
    // Storage without data is deferred; uploads of data and any partial update first realize it.
    own('texImage2D', (original, ...args) => {
        const texture = units[unit][args[0] === gl.TEXTURE_2D ? gl.TEXTURE_2D : gl.TEXTURE_CUBE_MAP];
        if (args.length === 9 && args[8] == null && args[0] === gl.TEXTURE_2D && texture && args[1] === 0) {
            // Render targets in 32-bit float hold accumulated colour and blend weights; half floats, which every
            // float-capable GPU blends, hold them at half the memory.
            if (args[2] === 0x8814) args = [args[0], args[1], 0x881A, ...args.slice(3)];
            pending.set(texture, {texture: true, target: gl.TEXTURE_2D, name: 'texImage2D', args});
            return;
        }
        if (texture) pending.delete(texture);
        original(...args);
    });
    for (const name of ['renderbufferStorage', 'renderbufferStorageMultisample']) if (gl[name]) own(name, (original, ...args) => {
        if (renderbuffer) { pending.set(renderbuffer, {texture: false, name, args}); return; }
        original(...args);
    });
    for (const name of ['texSubImage2D', 'copyTexSubImage2D', 'generateMipmap']) own(name, (original, ...args) => {
        const texture = units[unit][args[0]];
        if (texture) realize(texture);
        if (name === 'copyTexSubImage2D') realizeFramebuffer(read);
        original(...args);
    });
    // An attachment still waiting for storage would make its framebuffer incomplete; it will be complete when used.
    own('checkFramebufferStatus', (original, target) => {
        const framebuffer = target === READ ? read : draw;
        for (const object of attachments.get(framebuffer)?.values() ?? []) if (pending.has(object)) return gl.FRAMEBUFFER_COMPLETE;
        return original(target);
    });
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'])
        if (gl[name]) { const before = use(false, true); own(name, (original, ...args) => { before(); return original(...args); }); }
    for (const name of ['readPixels', 'copyTexImage2D']) { const before = use(true, false); own(name, (original, ...args) => { before(); return original(...args); }); }
    if (gl.blitFramebuffer) { const before = use(true, true); own('blitFramebuffer', (original, ...args) => { before(); return original(...args); }); }
    own('deleteTexture', (original, texture) => { pending.delete(texture); original(texture); });
    own('deleteRenderbuffer', (original, object) => { pending.delete(object); original(object); });
}
installLazyTargets();

// All viewers of a page share one WebGL context, its compiled shaders and one set of Molstar's render targets,
// instead of one of each per viewer. Molstar keeps its context factory and input observer private, so the pinned
// build is fetched and patched to expose them; each viewer then gets a context of its own visible 2D canvas and
// input, around the shared WebGL context and passes. Before a viewer draws or picks, the shared canvas takes its
// size; after each draw, the frame is copied onto its canvas.
const MOLSTAR = 'https://cdn.jsdelivr.net/npm/molstar@5.13.1/build/viewer/molstar.js';
function loadMolstar() {
    if (globalThis.molstarNotebookAssets) return globalThis.molstarNotebookAssets;
    const loading = (async () => {
        let source = await (await fetch(MOLSTAR)).text();
        // Literal searches; a pattern opening on an identifier would rescan the 5 MB source at every position.
        const call = source.indexOf(',preventGestures:!0})'), dot = source.lastIndexOf('.fromElement(', call);
        const input = call > 0 && dot > 0 && /[\w$]+$/.exec(source.slice(Math.max(0, dot - 40), dot));
        const factory = source.indexOf('.fromCanvas=') > 0 && /\.fromCanvas=[\w$]+\}\)\(([\w$]+)\|\|=\{\}\);/.exec(source);
        if (input && factory) source = source.replace(factory[0], factory[0]
            + `globalThis.molstarInternals={Canvas3DContext:${factory[1]},InputObserver:${input[0]}};`);
        // Each text label uploads its own copy of the font atlas, sized for 350 glyphs at the highest font quality:
        // 43 MB of GPU memory per label set. Labels here use printable ASCII and the angstrom sign; a glyph beyond the
        // smaller atlas falls back to Molstar's placeholder.
        source = source.replace(/(this\.texture=[\w$]+\()350(\*this\.lineHeight\*this\.maxWidth)/, (match, start, end) => start + '96' + end);
        // Molstar's depth-of-field parameter has a description but no label, so its UI otherwise renders "Dof".
        source = source.replace('description:"DOF"', 'label:"DOF",description:"DOF"');
        const script = document.createElement('script');
        script.src = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
        await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new Error('Could not load Molstar'));
            document.head.appendChild(script);
        });
        URL.revokeObjectURL(script.src);
        const internals = globalThis.molstarInternals, Plugin = globalThis.molstar.lib.plugin.PluginContext;
        if (internals) {
            const initContainer = Plugin.prototype._initContainer;
            Plugin.prototype._initContainer = function (options) {
                if (this.container || options?.canvas3dContext) return initContainer.call(this, options);
                const context = sharedContext(this, internals);
                const done = initContainer.call(this, {...options, canvas3dContext:context});
                // Molstar does not place a canvas it is given; its holder fills Molstar's own container.
                if (done) this.container.parent.append(context.holder);
                return done;
            };
        }
        return globalThis.molstar;
    })();
    globalThis.molstarNotebookAssets = loading;
    loading.catch(() => {
        if (globalThis.molstarNotebookAssets === loading) delete globalThis.molstarNotebookAssets;
    });
    return loading;
}

function sharedContext(plugin, {Canvas3DContext, InputObserver}) {
    const shared = globalThis.molstarSharedContext ??= (() => {
        const canvas = document.createElement('canvas'), holder = document.createElement('div');
        // Set the first drawing-buffer size before acquiring WebGL. Resizing a live context can synchronously flush
        // its initial GPU work, which otherwise causes a long stall as the first viewer enters the viewport.
        const initial = globalThis.molstarInitialCanvasSize;
        if (initial?.width > 0 && initial?.height > 0) {
            canvas.width = initial.width;
            canvas.height = initial.height;
        }
        delete globalThis.molstarInitialCanvasSize;
        // Molstar watches the canvas's parent for size changes; the shared canvas sits in a hidden empty holder.
        Object.assign(holder.style, {position:'fixed', width:'0', height:'0', overflow:'hidden', visibility:'hidden'});
        holder.append(canvas);
        document.body.append(holder);
        // Molstar draws into its own targets and smooths edges in post-processing, so the canvas needs no
        // multisampled buffer, and each frame is copied out as soon as it is drawn.
        const context = Canvas3DContext.fromCanvas(canvas, plugin.managers.asset,
            {antialias:false, preserveDrawingBuffer:false, handleResize:() => {}});
        return {canvas, context, owner:null};
    })();
    const base = shared.context, canvas = document.createElement('canvas'), holder = document.createElement('div');
    // Molstar's input observer watches the canvas's parent for size changes, so the canvas has its holder from the start.
    Object.assign(holder.style, {position:'absolute', inset:'0'});
    Object.assign(canvas.style, {display:'block', width:'100%', height:'100%'});
    holder.append(canvas);
    const input = InputObserver.fromElement(canvas, {pixelScale:base.pixelScale, preventGestures:true});
    return {
        canvas, input, webgl:base.webgl, passes:base.passes, attribs:base.attribs, assetManager:base.assetManager,
        contextLost:base.contextLost, contextRestored:base.contextRestored, changed:base.changed,
        get props() { return base.props; }, get pixelScale() { return base.pixelScale; },
        syncPixelScale: () => { base.syncPixelScale(); input.setPixelScale(base.pixelScale); },
        setProps: props => base.setProps(props),
        dispose: () => input.dispose(),
        shared, holder, view:canvas.getContext('2d'),
    };
}

// Route one viewer's drawing and picking through the shared context and copy each frame it draws to its canvas.
function shareCanvas(canvas3d, context) {
    const {shared, view, canvas} = context;
    if (!shared) return;
    const activate = () => {
        shared.owner = canvas3d;
        if (shared.canvas.width === canvas.width && shared.canvas.height === canvas.height) return;
        shared.canvas.width = canvas.width;
        shared.canvas.height = canvas.height;
        canvas3d.handleResize(false);
        // The frame on the viewer's canvas was drawn at the old size; without a new one it would stay, cut off or
        // stretched, until something else redrew the view.
        canvas3d.requestDraw();
    };
    for (const name of ['tick', 'commit', 'identify', 'asyncIdentify']) {
        const original = canvas3d[name];
        canvas3d[name] = (...args) => {
            // Off-screen animation ticks must not resize or claim the shared GPU canvas.
            if (name === 'tick' && context.visible === false) return;
            activate();
            return original(...args);
        };
    }
    // Molstar can redraw only the hover/selection overlay over its last frame. The underlying colour target is shared,
    // so after another viewer drew it belongs to that viewer; force a full draw before applying this viewer's marking.
    const mark = canvas3d.mark;
    canvas3d.mark = (...args) => {
        if (shared.lastRendered && shared.lastRendered !== canvas3d) canvas3d.requestDraw();
        return mark(...args);
    };
    view.globalCompositeOperation = 'copy';
    canvas3d.notifyDidDraw = true;
    canvas3d.didDraw.subscribe(() => {
        if (shared.owner === canvas3d) { view.drawImage(shared.canvas, 0, 0); shared.lastRendered = canvas3d; }
    });
}

// A large view on a high-density display draws four times the pixels of its CSS size or more. While it is being
// turned, moved or zoomed it draws at its CSS size, Molstar's "scaled" resolution, and once still for a moment it
// sharpens again to the display's own, so interaction keeps its frame rate and the resting view stays crisp.
function installAdaptiveResolution(container, plugin) {
    const context = plugin.canvas3dContext, controller = new AbortController();
    // Drawing pixels above which a view is drawn coarser while it moves: about a 1600 px square.
    const budget = 2.5e6;
    let lowered = false, timer = 0;
    const set = mode => {
        context.setProps({resolutionMode:mode});
        context.syncPixelScale();
        plugin.canvas3d.handleResize();
        plugin.canvas3d.requestDraw();
    };
    const start = () => {
        clearTimeout(timer);
        const ratio = window.devicePixelRatio || 1;
        if (lowered || ratio <= 1 || container.clientWidth * container.clientHeight * ratio * ratio <= budget) return;
        lowered = true;
        set('scaled');
    };
    const settle = delay => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (lowered) { lowered = false; set('auto'); } }, delay);
    };
    const onCanvas = event => event.composedPath().some(element => element.tagName === 'CANVAS');
    container.addEventListener('pointerdown', event => { if (onCanvas(event)) start(); }, {capture:true, signal:controller.signal});
    window.addEventListener('pointerup', () => { if (lowered) settle(150); }, {signal:controller.signal});
    window.addEventListener('pointercancel', () => { if (lowered) settle(150); }, {signal:controller.signal});
    container.addEventListener('wheel', event => { if (onCanvas(event)) { start(); settle(250); } },
                               {capture:true, passive:true, signal:controller.signal});
    return () => { clearTimeout(timer); controller.abort(); };
}

// Adapt wheel units while retaining Molstar's native camera and drag controls.
function installWheelInput(container) {
    const controller = new AbortController(), replayed = new WeakSet();
    let frame = 0, pending = 0, previous = 0, source = null, controlDown = false;
    function cancel() {
        cancelAnimationFrame(frame);
        frame = 0; pending = 0; previous = 0; source = null;
    }
    function advance(time) {
        frame = 0;
        if (!source?.target.isConnected) {cancel(); return;}
        const elapsed = previous ? Math.min(time - previous, 64) : 1000 / 60;
        previous = time;
        const portion = Math.abs(pending) < 0.001 ? pending : pending * (1 - Math.exp(-elapsed / 45));
        pending -= portion;
        const event = new WheelEvent('wheel', {
            deltaY:portion, deltaMode:0, ctrlKey:true,
            clientX:source.x, clientY:source.y, shiftKey:source.shift,
            bubbles:true, composed:true, cancelable:true
        });
        replayed.add(event); source.target.dispatchEvent(event);
        if (pending) frame = requestAnimationFrame(advance);
        else {previous = 0; source = null;}
    }
    container.addEventListener('wheel', event => {
        const target = event.composedPath().find(element => element.tagName === 'CANVAS');
        if (!target || event.metaKey || event.altKey) return;
        const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
        // Ease only Ctrl-wheel trackpad pinches; regular scroll and dragging stay native.
        if (event.ctrlKey && !controlDown && !replayed.has(event)) {
            event.preventDefault(); event.stopImmediatePropagation();
            pending += event.deltaY * unit;
            source = {target, x:event.clientX, y:event.clientY, shift:event.shiftKey};
            if (!frame) frame = requestAnimationFrame(advance);
            return;
        }
        if (!event.ctrlKey) cancel();
        const pixels = event.deltaY * unit * (event.ctrlKey ? 2.5 : 1);
        // Native trackball multiplies spin by 0.075; preserve fractional vertical motion.
        const wheelDelta = -pixels * 120 / 750;
        Object.defineProperties(event, {
            wheelDelta: {value:wheelDelta, configurable:true},
            wheelDeltaY: {value:wheelDelta, configurable:true},
            wheelDeltaX: {value:0, configurable:true},
            deltaX: {value:0, configurable:true},
            deltaZ: {value:0, configurable:true}
        });
    }, {capture:true, passive:false, signal:controller.signal});
    container.addEventListener('pointerdown', cancel, {capture:true, signal:controller.signal});
    container.addEventListener('touchstart', cancel, {capture:true, passive:true, signal:controller.signal});
    window.addEventListener('keydown', event => {
        if (event.key === 'Control') {controlDown = true; cancel();}
    }, {signal:controller.signal});
    window.addEventListener('keyup', event => {
        if (event.key === 'Control') {controlDown = false; cancel();}
    }, {signal:controller.signal});
    window.addEventListener('blur', () => {controlDown = false; cancel();}, {signal:controller.signal});
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancel();
    }, {signal:controller.signal});
    return () => {cancel(); controller.abort();};
}

// Every icon control shows what it does on hover, in Molstar's own hover box, the markup of its Fullscreen entry, instead of
// the browser's slow tooltip. The box is fixed to the window, so it moves nothing. A control with a hover box keeps its own.
function installControlLabels(container) {
    const controller = new AbortController();
    const label = document.createElement('div');
    label.className = 'msp-hover-box-wrapper molstar-control-label';
    label.hidden = true;
    label.innerHTML = '<div class="msp-hover-box-body"><div class="msp-flex-column"><div class="msp-flex-row">'
        + '<button type="button" tabindex="-1" aria-hidden="true" class="msp-btn msp-btn-block"></button></div></div></div>';
    const text = label.querySelector('button');
    let shownFor = null;
    const named = element => {
        const button = element?.closest?.('button');
        if (!button || !container.contains(button) || button.closest('.molstarview-menu-list')) return null;
        if (button.closest('.msp-hover-box-wrapper')?.querySelector('.msp-hover-box-body')) return null;
        return button.title || button.getAttribute('aria-label') ? button : null;
    };
    const hide = () => { label.hidden = true; shownFor = null; };
    container.addEventListener('pointerover', event => {
        const button = named(event.target);
        if (!button) return hide();
        // An empty title on a child covering the button keeps the browser's own tooltip away; the button keeps its title.
        const cover = button.firstElementChild;
        if (cover) { cover.title = ''; cover.classList.add('molstar-control-cover'); }
        if (button.getAttribute('aria-expanded') === 'true') return hide();
        text.textContent = button.title || button.getAttribute('aria-label');
        // Inside Molstar's root, whose styles it takes.
        const root = button.closest('.msp-plugin') ?? container;
        if (label.parentElement !== root) root.append(label);
        label.hidden = false;
        shownFor = button;
        const box = button.getBoundingClientRect(), own = label.getBoundingClientRect();
        const bounds = root.getBoundingClientRect();
        const beside = button.closest('.msp-viewport-controls-buttons');
        const left = beside ? box.left - own.width - 4 : box.left;
        const top = beside ? box.top : box.bottom + 4;
        label.style.left = Math.max(bounds.left + 4, Math.min(left, bounds.right - own.width - 4)) + 'px';
        label.style.top = top + 'px';
    }, {signal:controller.signal});
    container.addEventListener('pointerout', event => {
        if (shownFor && named(event.relatedTarget) !== shownFor) hide();
    }, {signal:controller.signal});
    container.addEventListener('pointerdown', hide, {capture:true, signal:controller.signal});
    return () => { controller.abort(); label.remove(); };
}

function alignCameraToAxes(canvas) {
    const {Vec3} = molstar.lib.math.LinearAlgebra;
    const state = canvas.camera.state;
    const direction = Vec3.sub(Vec3(), Vec3.fromArray(Vec3(), state.position, 0), Vec3.fromArray(Vec3(), state.target, 0));
    const distance = Vec3.magnitude(direction);
    if (!distance) return;
    const normal = Vec3.normalize(Vec3(), Vec3.scale(direction, direction, 1 / distance));
    const cameraUp = Vec3.fromArray(Vec3(), state.up, 0);
    const rawUp = Vec3.scaleAndAdd(Vec3(), cameraUp, normal, -Vec3.dot(cameraUp, normal));
    const length = Vec3.magnitude(rawUp);
    if (!length) return;
    const up = Vec3.normalize(Vec3(), rawUp), right = Vec3.cross(Vec3(), up, normal);
    const axes = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]]
        .map(axis => Vec3.fromArray(Vec3(), axis, 0));
    let best = null, score = -Infinity;
    for (const axis of axes) for (const vertical of axes) {
        if (Vec3.dot(axis, vertical)) continue;
        const similarity = Vec3.dot(normal, axis) + Vec3.dot(up, vertical)
            + Vec3.dot(right, Vec3.cross(Vec3(), vertical, axis));
        if (similarity > score) { score = similarity; best = {axis, vertical}; }
    }
    const target = Array.from(state.target);
    canvas.requestCameraReset({snapshot:{target,
        position:Array.from(Vec3.scaleAndAdd(Vec3(), Vec3.fromArray(Vec3(), target, 0), best.axis, distance)),
        up:Array.from(best.vertical)}, durationMs:0});
}

// The one-based frame a Molstar trajectory button asks for, or undefined for any other control.
function stepFrame(title, frame) {
    return {'First Model':1, 'Previous Model':frame - 1, 'Next Model':frame + 1,
            'First Frame':1, 'Previous Frame':frame - 1, 'Next Frame':frame + 1}[title];
}

// A trajectory can name particular one-based frames without creating separate Molstar snapshots.
function createFrameChoices(labels, selectFrame) {
    const menu = document.createElement('div');
    menu.className = 'molstarview-menu molstar-frame-choices';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msp-btn molstarview-menu-button';
    button.setAttribute('aria-label', 'Choose Labelled Frame');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.className = 'molstar-frame-choice-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 3h2v2h10l-2 4 2 4H8v8H6z"></path></svg>';
    const arrow = document.createElement('span');
    arrow.className = 'molstarview-menu-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(icon, arrow);
    const list = document.createElement('div');
    list.className = 'molstarview-menu-list';
    list.hidden = true;
    const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const items = labels.map(({label, frame}) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'msp-btn molstarview-menu-item';
        item.textContent = label;
        item.addEventListener('click', event => {
            event.stopPropagation();
            close();
            selectFrame(frame);
        });
        list.append(item);
        return item;
    });
    button.addEventListener('click', event => {
        event.stopPropagation();
        list.hidden = !list.hidden;
        button.setAttribute('aria-expanded', String(!list.hidden));
    });
    const escape = event => { if (event.key === 'Escape' && !list.hidden) { close(); button.focus(); } };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escape);
    menu.append(button, list);
    return {element:menu, setRange(start, count) {
        items.forEach((item, index) => {
            const frame = labels[index].frame - 1;
            item.hidden = item.disabled = frame < start || frame >= start + count;
        });
        menu.hidden = !items.some(item => !item.disabled);
        if (menu.hidden) close();
    }, dispose() {
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', escape);
    }};
}

// A button at the end of Molstar's right-hand toolbar, in its own style, that shows the viewer's next view.
function installViewSwitch(container, onClick) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msp-hover-box-wrapper';
    const background = document.createElement('div');
    background.className = 'msp-semi-transparent-background';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msp-btn msp-btn-icon';
    // Material Design Icons "swap-horizontal" (Apache 2.0), from the family of Molstar's own material icons.
    button.innerHTML = '<span class="msp-icon msp-material-icon"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M21,9L17,5V8H10V10H17V13M7,11L3,15L7,19V16H14V14H7V11Z"></path></svg></span>';
    wrapper.append(background, button);
    button.addEventListener('click', onClick);
    const attach = () => {
        const buttons = container.querySelector('.msp-viewport-controls-buttons');
        if (buttons && buttons.lastElementChild !== wrapper) buttons.append(wrapper);
    };
    const toolbar = new MutationObserver(attach);
    toolbar.observe(container, {childList:true, subtree:true});
    attach();
    const title = text => { button.title = text; button.setAttribute('aria-label', text); };
    return {title, dispose:() => { toolbar.disconnect(); wrapper.remove(); }};
}

// A toggle at the end of Molstar's right-hand toolbar, styled and sized as its own icon toggles: the icon dark when on
// and light when off, with a constant title in their Title Case. Unlike the view switch it does not keep itself last, so the two never
// move each other.
function installFieldToggle(container, title, path, onClick, on) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msp-hover-box-wrapper';
    const background = document.createElement('div');
    background.className = 'msp-semi-transparent-background';
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<span class="msp-icon msp-material-icon"><svg width="24px" height="24px" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"></path></svg></span>`;
    wrapper.append(background, button);
    button.addEventListener('click', onClick);
    const look = shown => {
        button.className = 'msp-btn msp-btn-icon molstarview-field-toggle msp-btn-link-toggle-' + (shown ? 'on' : 'off');
        button.setAttribute('aria-pressed', String(shown));
    };
    look(on);
    const attach = () => {
        const buttons = container.querySelector('.msp-viewport-controls-buttons');
        if (buttons && wrapper.parentElement !== buttons) buttons.append(wrapper);
    };
    const toolbar = new MutationObserver(attach);
    toolbar.observe(container, {childList:true, subtree:true});
    attach();
    return {look, dispose:() => { toolbar.disconnect(); wrapper.remove(); }};
}

function installAxisAlignment(container, viewer) {
    const controller = new AbortController();
    const wrapper = document.createElement('div');
    wrapper.className = 'msp-hover-box-wrapper';
    const background = document.createElement('div');
    background.className = 'msp-semi-transparent-background';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msp-btn msp-btn-icon';
    button.title = 'Align to Nearest Coordinate Axes (Right-Click)';
    button.setAttribute('aria-label', button.title);
    // Material Design Icons "axis-arrow" (Apache 2.0), from the family of Molstar's own material icons.
    button.innerHTML = '<span class="msp-icon msp-material-icon"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12,2L16,6H13V13.85L19.53,17.61L21,15.03L22.5,20.5L17,21.96L18.53,19.35L12,15.58L5.47,19.35L7,21.96L1.5,20.5L3,15.03L4.47,17.61L11,13.85V6H8L12,2Z"></path></svg></span>';
    wrapper.append(background, button);
    const align = () => {
        const canvas = viewer.plugin.canvas3d;
        if (canvas) alignCameraToAxes(canvas);
    };
    button.addEventListener('click', align, {signal:controller.signal});
    const attach = () => {
        const buttons = container.querySelector('.msp-viewport-controls-buttons');
        if (!buttons) return;
        const reset = [...buttons.querySelectorAll('button')].find(node => /reset.*(?:camera|zoom)|(?:camera|zoom).*reset/i.test(node.title || node.getAttribute('aria-label') || ''));
        const neighbor = reset?.closest('.msp-hover-box-wrapper') || reset;
        // At the head of the control column, beside Molstar's reset button rather than among the view tools below it.
        if (neighbor?.parentElement === buttons) {
            if (neighbor.previousElementSibling !== wrapper) buttons.insertBefore(wrapper, neighbor);
        } else if (buttons.firstElementChild !== wrapper) buttons.prepend(wrapper);
    };
    const toolbar = new MutationObserver(attach);
    toolbar.observe(container, {childList:true, subtree:true});
    attach();
    let pressed = null;
    container.addEventListener('pointerdown', event => {
        if (event.button !== 2 || !event.target.closest('canvas')) return;
        pressed = {x:event.clientX, y:event.clientY, pointer:event.pointerId, reset:event.ctrlKey};
    }, {capture:true, signal:controller.signal});
    window.addEventListener('pointerup', event => {
        if (!pressed || event.pointerId !== pressed.pointer) return;
        const click = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 5;
        if (click) {
            if (pressed.reset) viewer.plugin.canvas3d?.requestCameraReset({durationMs:0});
            else align();
            event.preventDefault(); event.stopImmediatePropagation();
        }
        pressed = null;
    }, {capture:true, signal:controller.signal});
    container.addEventListener('contextmenu', event => {
        if (event.target.closest('canvas')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, {capture:true, signal:controller.signal});
    return () => { controller.abort(); toolbar.disconnect(); wrapper.remove(); };
}

        async function mount({model, el}) {
            // A volume viewer's views of its field, each with its own fields, surfaces, colour scale and settings; ``view``
            // is the one shown. A molecule viewer has none.
            const views = model.get('views') || [];
            let viewIndex = 0, view = views[0];
            const stylesheet = document.createElement('link');
            stylesheet.rel = 'stylesheet';
            stylesheet.href = 'https://cdn.jsdelivr.net/npm/molstar@5.13.1/build/viewer/molstar.css';
            const stylesReady = new Promise((resolve, reject) => {
                stylesheet.onload = resolve;
                stylesheet.onerror = () => reject(new Error('Could not load Molstar styles'));
            });
            el.appendChild(stylesheet);
            // Load the official viewer once, shared by notebook widget instances.
            const [molstar] = await Promise.all([loadMolstar(), stylesReady]);
            const container = document.createElement('div');
            container.className = 'molstar-notebook-viewer';
            container.style.height = model.get('height') + 'px';
            el.appendChild(container);
            const disposeWheel = installWheelInput(container);
            let disposeResolution = () => {};
            // Titles of native snapshots; each shows one frame with its own surface.
            const titles = model.get('snapshots') || [];
            // Dropdown axes that together select a snapshot, and each snapshot's option index on every axis.
            const choiceAxes = model.get('choices') || [];
            const snapshotChoices = model.get('snapshot_choices') || [];
            // Frame counts of animated snapshots, consecutive in the trajectory; empty when each snapshot is one frame.
            const segments = model.get('segments') || [];
            // Compute snapshot frame offsets once for playback and snapshot creation.
            const segmentStarts = [];
            segments.reduce((start, count) => { segmentStarts.push(start); return start + count; }, 0);
            // The selected snapshot's index, kept here because Molstar's current entry is not one of ours when it
            // carries no key, as its own initial snapshot does.
            let snapshotIndex = 0;
            function currentSnapshot() {
                const manager = viewer.plugin?.managers.snapshot;
                const entry = manager ? manager.getEntry(manager.state.current) : undefined;
                const index = entry?.key != null ? Number(entry.key) - 1 : NaN;
                const count = segments.length || titles.length || 1;
                return Number.isInteger(index) && index >= 0 && index < count ? index : snapshotIndex;
            }
            const animated = model.get('frame_count') > 1 && (!titles.length || segments.length > 0);
            // The snapshot dropdown that replaces Molstar's selector, created on first use.
            let snapshotMenu = null, closeSnapshotMenu = null, choiceMenus = null;
            if (!globalThis.molstarSharedContext) {
                const ratio = window.devicePixelRatio || 1;
                globalThis.molstarInitialCanvasSize = {
                    width: Math.round(container.clientWidth * ratio),
                    height: Math.round(container.clientHeight * ratio),
                };
            }
            const viewer = await molstar.Viewer.create(container, {
                layoutIsExpanded: false, layoutShowControls: false,
                layoutShowSequence: false, layoutShowLog: false,
                layoutShowLeftPanel: false, layoutShowRemoteState: false,
                viewportShowAnimation: animated && !segments.length,
                viewportShowTrajectoryControls: animated,
                // Molstar draws into its own targets and smooths edges in post-processing, so the canvas needs no
                // multisampled buffer of its own.
                disableAntialiasing: true,
                extensions: ['mvs']
            });
            const disposeAlignment = installAxisAlignment(container, viewer);
            const disposeLabels = installControlLabels(container);
            // Secondary clicks are handled by the alignment and reset gestures, not Molstar's focus bindings. A click
            // neither moves the camera onto the clicked atoms nor focuses them: Molstar's focus draws its own copy of
            // them and their surroundings in element colours with a halo, over the scene's colours, such as charges or
            // an orbital's composition, and the camera jumps away. Selection mode and hover labels are unchanged.
            const behaviors = molstar.lib.plugin.DefaultPluginSpec().behaviors;
            const behavior = name => behaviors.find(entry => entry.transformer.definition.name === name)?.transformer;
            await viewer.plugin.state.updateBehavior(behavior('camera-focus-loci'), params => {
                for (const key of ['clickCenterFocus', 'clickCenterFocusSelectMode',
                                   'clickResetCameraOnEmpty', 'clickResetCameraOnEmptySelectMode']) {
                    const binding = params.bindings[key];
                    const reset = key.startsWith('clickReset');
                    params.bindings[key] = {...binding, triggers:reset ? binding.triggers.filter(trigger =>
                        !(trigger.buttons & 2) && !(trigger.buttons === 1
                            && !Object.values(trigger.modifiers || {}).some(Boolean))) : []};
                }
            });
            const representationFocus = behavior('representation-focus-loci');
            if (representationFocus) await viewer.plugin.state.updateBehavior(representationFocus, params => {
                for (const key of Object.keys(params.bindings)) params.bindings[key] = {...params.bindings[key], triggers:[]};
            });
            // Temporal multisampling accumulates frames in two full-size float targets; post-processing antialiasing
            // smooths edges without them.
            shareCanvas(viewer.plugin.canvas3d, viewer.plugin.canvas3dContext);
            disposeResolution = installAdaptiveResolution(container, viewer.plugin);
            // Fog and the far clipping plane fade and cut whatever lies beyond the scene's bounding sphere; an
            // isosurface reaches past the atoms that set it, so turned views lose its far side. Both are off.
            viewer.plugin.canvas3d.setProps({trackball:{gestureScaleFactor:1.25, staticMoving:true}, multiSample:{mode:'off'},
                // Every viewer starts orthographic; perspective remains available from Molstar's camera settings.
                camera:{...viewer.plugin.canvas3d.props.camera, mode:'orthographic'},
                cameraFog:{name:'off', params:{}}, cameraClipping:{...viewer.plugin.canvas3d.props.cameraClipping, far:false},
                // Screen-space occlusion and shadows sample the depth buffer at a fixed radius in pixels; zoomed in, they
                // draw bands and stepped lines across bonds and through transparent surfaces. Plain lighting has neither.
                postprocessing:{...viewer.plugin.canvas3d.props.postprocessing,
                    occlusion:{name:'off', params:{}}, shadow:{name:'off', params:{}}},
                dpoitIterations:8});
            // Depth peeling orders transparent surfaces exactly, so where a red lobe lies behind or inside a blue one each
            // shows as it is; a weighted blend only approximates the order and smears overlapping surfaces into dark rims.
            // The motion trail switches to the weighted blend while it is shown (installTrail).
            viewer.plugin.canvas3dContext.setProps({transparency:'dpoit'});
            // Molstar keeps the near plane at least minNear in front of the camera, and an orthographic zoom moves the camera
            // towards its target, so zooming in sliced the front of every surface away, showing its inside as dark bands. An
            // orthographic projection is valid with any near plane, even behind the camera, so there it lies just in front of
            // everything within the camera's radius; perspective keeps Molstar's limit, which it needs.
            const camera = viewer.plugin.canvas3d.camera, cameraUpdate = camera.update.bind(camera);
            camera.update = () => {
                camera.state.minNear = camera.state.mode === 'orthographic' ? -Infinity : 5;
                return cameraUpdate();
            };
            // Molstar shows its snapshot selector and player for any saved snapshot; with a single one there
            // is nothing to switch, so they appear only when several exist. The stylesheet lays the controls out with
            // an important flex display, so hiding them must be important too.
            const snapshotStyle = document.createElement('style');
            snapshotStyle.textContent = '.molstar-notebook-viewer[data-snapshots="0"] .msp-state-snapshot-viewport-controls,'
                + '.molstar-notebook-viewer[data-snapshots="1"] .msp-state-snapshot-viewport-controls{display:none!important}'
                // Molstar disables the selector and buttons while a snapshot is applied; keeping their normal
                // look stops them flashing on every switch.
                + '.molstar-notebook-viewer .msp-state-snapshot-viewport-controls [disabled]'
                + '{opacity:1!important;background-color:#f3f2ee!important;color:#332b1f!important}'
                // Molstar stacks its selection toolbar and the other top-left controls in two grid rows; here they
                // share one wrapping row, clear of the right-hand column, and fold only when they do not fit.
                // Molstar's grid and toolbar margins come from more specific rules, so the overrides need !important;
                // the selection toolbar comes first.
                + '.molstar-notebook-viewer .msp-layout-static{display:flex!important;flex-wrap:wrap;align-items:flex-start;'
                + 'align-content:flex-start;gap:8px 10px;padding:10px 52px 0 10px;box-sizing:border-box}'
                // Molstar sizes the selection toolbar at 430 px and shares it among its controls; as a flex item of
                // its content's width it would shrink them, truncating the granularity menu and squeezing the buttons.
                + '.molstar-notebook-viewer .msp-selection-viewport-controls{margin:0!important;order:0;'
                + 'flex:0 1 430px;width:430px!important;max-width:100%!important;box-sizing:border-box}'
                + '.molstar-notebook-viewer .msp-viewport-top-left-controls{margin:0!important;order:1}'
                // The trajectory controls sit on one row when they fit; otherwise the frame controls keep the
                // first row and Molstar's step buttons and frame label fold together onto a second one.
                + '.molstar-notebook-viewer .msp-traj-controls{display:flex;align-items:center;flex-wrap:nowrap}'
                + '.molstar-notebook-viewer[data-fold="1"] .msp-traj-controls{flex-wrap:wrap;width:min-content}'
                // Molstar blanks its own "Model n / N" label once the motion trail adds trajectories of its own, so the
                // frame controls carry a "Frame n / N" label, counted within the played frames and styled as a native one,
                // which is hidden (Molstar's rule for it is as specific as this one). The motion-trail toggle is an icon
                // button in Molstar's right-hand toolbar, beside its other viewport controls.
                + '.molstar-notebook-viewer .msp-traj-controls>span:not(.molstar-frame-label){display:none!important}'
                + '.molstar-notebook-viewer .molstar-frame-label{white-space:nowrap}'
                + '.molstar-notebook-viewer .molstar-trail-toggle{background:transparent}'
                + '.molstar-notebook-viewer .molstar-trail-toggle .msp-icon{font-size:18px}';
            el.appendChild(snapshotStyle);
            const countSnapshots = () => { container.dataset.snapshots = String(viewer.plugin.managers.snapshot.state.entries.size); };
            countSnapshots();
            const snapshotCount = viewer.plugin.managers.snapshot.events.changed.subscribe(countSnapshots);
            // Probe individual atoms and coarse elements through Molstar's native selection tools.
            // Molstar's selection toolbar starts hidden; its pointer button turns it on, picking single atoms.
            viewer.plugin.managers.interactivity.setProps({granularity: 'element'});
            let pending = null, updating = false, loaded = false, disposed = false, modelRef, cameraObserver;
            // The viewer's selection: each change of what is shown (a snapshot, a level, a view) is a new epoch, and the workers
            // build for the newest epoch of each viewer first.
            const selection = {scope:++viewerCount, epoch:0};
            // Starts one piece of work and returns the call that ends it, so callers can wait for all of it.
            let working = 0;
            const begin = () => {
                working++;
                let ended = false;
                return () => { if (!ended) { ended = true; working--; } };
            };
            const track = promise => { const end = begin(); promise.then(end, end); return promise; };
            // Each displayed field: its parsed volume, its isosurface cells (the negative one first for a signed field)
            // and, once first shown, its direct-volume cell. The render mode decides which of them are visible.
            // A snapshot's set is null until the snapshot is first shown: parsing a field and extracting its
            // isosurfaces is the slow part of loading, so only the first snapshot's field is built when it is shown.
            let surfaceSets = [], renderMode = 'isosurface', ensureSurface = async () => {}, buildFields = () => {};
            // Makes one field's isosurfaces smooth once Molstar has built their mesh, and has them drawn anew.
            // The meshes are built in workers, so this returns at once and the surfaces change when they are ready.
            async function refineSet(set) {
                if (set.evicted) return;
                const plugin = viewer.plugin, cells = plugin.state.data.cells;
                const counts = await Promise.all(set.iso.map(async ref => {
                    const count = await refineIsosurface(cells.get(ref), set.volume.data, set.coloring, set.prefetch, selection);
                    const repr = cells.get(ref)?.obj?.data?.repr;
                    if (repr && !disposed) plugin.canvas3d.update(repr, true);
                    return count;
                }));
                if (disposed || set.evicted) return;
                container.dataset.surfaceTriangles = String(counts.reduce((sum, count) => sum + count, 0));
                plugin.canvas3d.requestDraw();
            }
            const refineSilently = set => track(refineSet(set)).catch(error => console.error('Isosurface refinement failed', error));
            let disposeClipping = () => {};
                        // Molstar's near and far planes enclose the sphere of the camera's radius around its target. Without its
            // own resets, the radius grows here to reach the viewer's bounds, which hold every frame, snapshot field
            // and arrow, so nothing shown is ever cut off; it only grows, which keeps the view and zoom as they are.
            function fitClipping() {
                const canvas = viewer.plugin.canvas3d;
                if (!canvas) return;
                const [lower, upper] = model.get('bounds');
                const centre = lower.map((value, axis) => (value + upper[axis]) / 2);
                const {target, radius, radiusMax} = canvas.camera.state;
                const {Vec3} = molstar.lib.math.LinearAlgebra;
                const reach = Vec3.distance(centre,target) + 0.5 * Vec3.distance(lower,upper);
                if (reach > radius || reach > radiusMax) {
                    canvas.camera.setState({radius:Math.max(radius, reach), radiusMax:Math.max(radiusMax, reach)}, 0);
                }
            }
            // Whether the snapshots and their dropdown's observer exist, so building them again adds neither twice.
            let snapshotsBuilt = false, snapshotObserver = null;
            // Shows the fields of one snapshot, by index, in the current render mode and settings; set by the field
            // settings when they exist. It commits its changes without pausing the canvas, which its caller holds.
            let showFields = null;
            // Snapshot and field updates both change the same Molstar tree and must not overlap.
            let fieldTask = Promise.resolve();
            const queueField = task => {
                const next = track(fieldTask.then(task));
                fieldTask = next.catch(() => {});
                return next;
            };
            // The colour scale's tick row and tick format, so the settings can move the ticks with the level.
            let legendTicks = null, legendFormat = null;
            // The composition shown on the atoms in place of the field, declared before any snapshot is first shown.
            const snapshotAtoms = model.get('snapshot_atoms') || [];
            const COMPOSITION = 'molstarview-composition';
            let compositionShown = false, compositionLegend = null, surfacesHidden = false;
            // The motion trail's model cells and its representation cells, each with its copy's place among the frames being built.
            const trailModels = [], trailRepresentations = [];

            function atomLocations(structure) {
                // XYZ atom IDs are zero-based within each model; retain the first matching unit.
                const locations = new Map();
                structure.units.filter(unit => unit.kind === 0).forEach(unit => {
                    unit.elements.forEach((element, index) => {
                        const id = unit.model.atomicConformation.atomId.value(element);
                        if (!locations.has(id)) locations.set(id, {kind:'element-loci', structure,
                            elements:[{unit, indices:Int32Array.of(index)}]});
                    });
                });
                return id => {
                    const loci = locations.get(id);
                    if (!loci) throw new Error('A distance measurement atom is missing');
                    return loci;
                };
            }

            // Labels drawn over the canvas at each group's centroid for the displayed frame. Each label's outline
            // lies just below its own text, and labels are ordered by depth, so a nearer label's outline covers a
            // farther label's text where they overlap.
            const annotations = model.get('annotations') || [];
            let shownFrame = 0, overlay = null, labelNodes = [], renderText = null, shownTexts = [];
            function placeLabels() {
                const canvas3d = viewer.plugin.canvas3d, element = container.querySelector('canvas');
                if (!overlay || !canvas3d || !element) return;
                const camera = canvas3d.camera, viewport = camera.viewport, state = camera.state;
                const scaleX = element.clientWidth / viewport.width, scaleY = element.clientHeight / viewport.height;
                const {Vec3} = molstar.lib.math.LinearAlgebra;
                const forward = Vec3.sub(Vec3(),state.target,state.position);
                const right = Vec3.normalize(Vec3(),Vec3.cross(Vec3(),forward,state.up));
                const out = [0, 0, 0, 0], shifted = [0, 0, 0, 0], stack = [];
                annotations.forEach((annotation, index) => {
                    const centre = annotation.centers[Math.min(shownFrame, annotation.centers.length - 1)];
                    // A readout's text follows the frame.
                    const text = annotation.texts ? annotation.texts[Math.min(shownFrame, annotation.texts.length - 1)] : null;
                    if (text !== null && renderText && shownTexts[index] !== text) {
                        shownTexts[index] = text;
                        labelNodes[index].forEach(node => node.innerHTML = renderText(text));
                    }
                    camera.project(out, centre);
                    const nodes = labelNodes[index], visible = out[3] > 0;
                    nodes.forEach(node => node.style.display = visible ? '' : 'none');
                    if (!visible) return;
                    // Text height matches Molstar's default 0.5 angstrom measurement labels at this depth.
                    camera.project(shifted, Vec3.scaleAndAdd(Vec3(),centre,right,annotation.size ?? 0.5));
                    const size = Math.hypot(shifted[0] - out[0], shifted[1] - out[1]) * scaleX;
                    nodes.forEach(node => {
                        node.style.fontSize = size + 'px';
                        const [across, down] = annotation.offset ?? [0, 0];
                        node.style.left = (out[0] - viewport.x) * scaleX + across * size + 'px';
                        node.style.top = element.clientHeight - (out[1] - viewport.y) * scaleY + down * size + 'px';
                    });
                    stack.push({nodes, depth:out[2]});
                });
                // Each label is one plane, its outline just below its own text. Planes stack by window depth, nearest on
                // top (1/w cannot rank them, being the same for every point of an orthographic view), and labels at the
                // same depth by their order, so no plane's text ever lies between another plane's outline and text.
                stack.sort((a, b) => b.depth - a.depth).forEach(({nodes}, rank) => {
                    nodes[0].style.zIndex = String(2 * rank);
                    nodes[1].style.zIndex = String(2 * rank + 1);
                });
            }
            function drawLabels() {
                if (!annotations.length || overlay) return;
                overlay = document.createElement('div');
                Object.assign(overlay.style, {position:'absolute', inset:'0', overflow:'hidden', pointerEvents:'none'});
                container.style.position = 'relative';
                container.appendChild(overlay);
                const layer = () => {
                    const element = document.createElement('div');
                    Object.assign(element.style, {position:'absolute', inset:'0', isolation:'isolate'});
                    overlay.appendChild(element);
                    return element;
                };
                const labels = layer();
                // Molstar's native 3D text: sans-serif, black fill and a thin opaque grey outline.
                const base = {position:'absolute', transform:'translate(-50%,-50%)', fontSize:'0.5px', lineHeight:'1',
                              whiteSpace:'nowrap', fontFamily:'sans-serif', fontWeight:'normal'};
                labelNodes = annotations.map(() => {
                    const halo = document.createElement('span'), text = document.createElement('span');
                    // The outline is filled as well as stroked, so a nearer label's grey covers the black text of a farther one.
                    Object.assign(halo.style, base, {color:'#808080', webkitTextStroke:'0.2em #808080'});
                    Object.assign(text.style, base, {color:'#000000'});
                    labels.append(halo, text);
                    return [halo, text];
                });
                // Inline Markdown (bold, italic, code) with $...$ LaTeX typeset by the page's KaTeX.
                const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const markdown = text => escape(text)
                    .replace(/`([^`]+)`/g, '<code>$1</code>')
                    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
                const typeset = () => {
                    const math = globalThis.katex;
                    if (!math && annotations.some(a => a.text.includes('$'))) { setTimeout(typeset, 200); return; }
                    renderText = text => text.split(/(\$[^$]+\$)/).map(part => {
                        if (part.length > 2 && part.startsWith('$') && part.endsWith('$'))
                            return math.renderToString(part.slice(1, -1), {throwOnError: false});
                        return markdown(part);
                    }).join('');
                    annotations.forEach((annotation, index) => {
                        shownTexts[index] = annotation.text;
                        labelNodes[index].forEach(node => node.innerHTML = renderText(annotation.text));
                    });
                    placeLabels();
                };
                typeset();
                viewer.plugin.canvas3d.didDraw.subscribe(placeLabels);
            }

            async function update(target = model.get('requested')) {
                pending = target;
                if (updating || disposed) return;
                updating = true;
                const endLoading = begin();
                const canvas = viewer.plugin.canvas3d;
                // Retain the last rendered frame until the native scene transaction
                // has loaded its replacement, including geometry and measurements.
                canvas.pause(true);
                try {
                    while (pending !== null && !disposed) {
                        const target = pending;
                        pending = null;
                        if (!Number.isInteger(target) || target < 1 || target > model.get('frame_count')) {
                            throw new Error('Requested scan target is outside the trajectory');
                        }
                        const plugin = viewer.plugin;
                        if (!loaded) {
                            const scene = model.get('scene');
                            await viewer.loadMvsData(isStored(scene) ? new Uint8Array(await readStored(scene)) : scene, 'mvsx');
                            // A snapshot may name its field by its own symbol, such as one atom's part of an orbital.
                            installLabels(plugin, model, () => {
                                    const symbol = (model.get('snapshot_fields') || [])[currentSnapshot()]?.symbol;
                                    return symbol && view ? {...view, field_symbol:symbol} : view;
                                },
                                () => (model.get('snapshot_atoms') || [])[currentSnapshot()]?.details || model.get('atom_details') || []);
                            const hierarchy = plugin.managers.structure.hierarchy.current;
                            if (hierarchy.structures.length !== 1 || hierarchy.models.length !== 1) {
                                throw new Error('Expected one molecular trajectory');
                            }
                            modelRef = hierarchy.models[0].cell.transform.ref;
                            // Reactive trajectories must infer bonds again when coordinates change.
                            const root = hierarchy.structures[0].cell;
                            const type = root.params.values.type;
                            await plugin.state.data.build().to(root.transform.ref).update({
                                type:{...type, params:{...type.params, dynamicBonds:true}}
                            }).commit();
                            const current = plugin.managers.structure.hierarchy.current;
                            // This is the preset used by the native Cartoon button.
                            const preset = plugin.builders.structure.representation.resolveProvider(
                                'preset-structure-representation-polymer-and-ligand');
                            if (!(model.get('atom_colors') || []).length && !(model.get('markers') || []).length) {
                                await plugin.managers.structure.component.applyPreset(current.structures, preset);
                            } else {
                                // Atoms coloured by a quantity keep the scene's colours, drawn at the sizes of the native
                                // ball-and-stick preset: its default geometry and physical atom radii, not MolViewSpec's.
                                const provider = plugin.representation.structure.registry.get('ball-and-stick');
                                const transformer = molstar.lib.plugin.StateTransforms.Representation.StructureRepresentation3D;
                                // Atoms not coloured by a quantity take the colours of the native preset: element colours, with
                                // carbon by chain.
                                const elementColors = (model.get('atom_colors') || []).length ? null
                                    : plugin.representation.structure.themes.colorThemeRegistry.get('element-symbol');
                                const resize = plugin.state.data.build();
                                for (const cell of plugin.state.data.cells.values()) {
                                    if (cell.transform.transformer !== transformer
                                        || cell.transform.params?.type?.name !== 'ball-and-stick') continue;
                                    resize.to(cell.transform.ref).update(old => ({...old,
                                        type:{name:'ball-and-stick', params:{...provider.defaultValues, alpha:old.type.params.alpha ?? 1}},
                                        sizeTheme:{name:'physical', params:{}},
                                        ...(elementColors ? {colorTheme:{name:'element-symbol', params:elementColors.defaultValues}} : {})}));
                                }
                                await resize.commit();
                            }
                            const structure = current.structures[0].cell.obj.data;
                            const manager = plugin.managers.structure.measurement;
                            const distances = model.get('distances');
                            const angles = model.get('angles') || [];
                            const atomLoci = distances.length || angles.length ? atomLocations(structure) : null;
                            // A measurement with a readout keeps its line and loses its native number.
                            const quiet = (kind, atoms) => (model.get('readouts') || []).some(readout => readout.kind === kind && readout.atoms.join() === atoms.join())
                                ? {customText:' '} : undefined;
                            for (const [first, second] of distances) {
                                const result = await manager.addDistance(atomLoci(first-1), atomLoci(second-1), quiet('distance', [first, second]));
                                if (!result) throw new Error('Molstar could not register the distance');
                            }
                            for (const [first, vertex, last] of angles) {
                                const result = await manager.addAngle(atomLoci(first-1), atomLoci(vertex-1), atomLoci(last-1), quiet('angle', [first, vertex, last]));
                                if (!result) throw new Error('Molstar could not register the angle');
                            }
                            // Reads the shown view's fields and sets up their surfaces and colour scale.
                            buildFields = () => {
                            const readVolume = async (text, label) => {
                                    const data = await readField(text);
                                    const raw = await plugin.builders.data.rawData({data, label});
                                    const {volume} = await plugin.dataFormats.get('cube').parse(plugin, raw);
                                    // The raw data is the root of the field's cells: deleting it deletes them all.
                                    return {volume, root:raw.ref};
                                };
                            // The isosurfaces of one contour field, with their refs: one coloured by an optional registered
                            // field, or for a signed field one at each sign of the isovalue in the end colours.
                            const addSurface = async (fieldText, colorText) => {
                                const field = await readVolume(fieldText, 'Scalar field');
                                const colorField = colorText ? await readVolume(colorText, 'Color field') : null;
                                const representation = plugin.representation.volume.registry.get('isosurface');
                                const color = plugin.representation.volume.themes.colorThemeRegistry.get('external-volume');
                                const colors = view.colors.map(c => parseInt(c.slice(1), 16));
                                const isovalue = view.isovalue;
                                const levels = view.signed ? [[-isovalue, colors[0]], [isovalue, colors[colors.length - 1]]]
                                    : [[isovalue, colors[0]]];
                                const refs = [];
                                for (const [level, uniform] of levels) {
                                    const surface = plugin.state.data.build().to(field.volume).apply(
                                        molstar.lib.plugin.StateTransforms.Representation.VolumeRepresentation3D, {
                                            type:{name:'isosurface', params:{...representation.defaultValues,
                                                isoValue:molstar.lib.volume.Volume.IsoValue.absolute(level),
                                                alpha:view.opacity, flatShaded:false,
                                                // Seen from inside, a lobe shows its far wall in its own colour and lighting: Molstar's
                                                // defaults leave a transparent surface's back faces undrawn, a see-through hole
                                                // that grows as the camera moves into a lobe, and paint any interior dark grey.
                                                transparentBackfaces:'on', solidInterior:false,
                                                interior:{...representation.defaultValues.interior, colorStrength:0, substanceStrength:0},
                                                // Extracted on the CPU, whose mesh refineIsosurface then makes smooth.
                                                tryUseGpu:false,
                                                bumpFrequency:0, bumpAmplitude:0, quality:'high'}},
                                            colorTheme:colorField ? {name:'external-volume', params:{...color.defaultValues,
                                                volume:{ref:colorField.volume.ref, getValue:()=>colorField.volume.data},
                                                coloring:{name:'absolute-value', params:{
                                                    domain:{name:'custom', params:view.color_range},
                                                    list:{kind:'interpolate', colors}
                                                }}, normalOffset:0}} : {name:'uniform', params:{value:uniform}},
                                            sizeTheme:{name:'uniform', params:{value:1}}
                                        });
                                    await surface.commit();
                                    refs.push(surface.ref);
                                }
                                return {volume:field.volume, text:fieldText, iso:refs, fog:null, direct:null,
                                    roots:[field.root, ...(colorField ? [colorField.root] : [])],
                                    coloring:colorField ? {volume:colorField.volume.data, colors, range:view.color_range} : null};
                            };
                            // The fields in snapshot order; only the first is built now, the others when first shown.
                            const sources = !view ? [] : view.field ? [[view.field, view.color_field]]
                                : view.fields.map((text, index) => [text, view.color_fields[index]]);
                            const surfaces = sources.map(() => null);
                            const building = new Map();
                            // Built snapshots, the most recently shown last; the oldest beyond KEPT_SNAPSHOTS are
                            // released through the field queue, after whatever is showing now.
                            const recent = [];
                            const evict = index => queueField(async () => {
                                const set = surfaces[index];
                                if (!set || recent.includes(index) || disposed) return;
                                surfaces[index] = null;
                                set.evicted = true;
                                const state = plugin.state.data, release = state.build();
                                for (const ref of set.roots) if (state.cells.has(ref)) release.delete(ref);
                                await release.commit();
                            });
                            const touch = index => {
                                const at = recent.indexOf(index);
                                if (at >= 0) recent.splice(at, 1);
                                recent.push(index);
                                while (recent.length > KEPT_SNAPSHOTS) void evict(recent.shift());
                            };
                            ensureSurface = index => {
                                if (sources.length > 1) touch(index);
                                if (surfaces[index] || !sources[index]) return Promise.resolve();
                                if (!building.has(index)) building.set(index, track(addSurface(...sources[index])).then(set => {
                                    surfaces[index] = set;
                                    // Released while it was being built: let it go as soon as it is in place.
                                    if (sources.length > 1 && !recent.includes(index)) void evict(index);
                                    refineSilently(set);
                                    if (index === 0 && !disposed) {
                                        container.dataset.surface = 'ready';
                                        model.set('error', '');
                                        model.save_changes();
                                    }
                                }).finally(() => building.delete(index)));
                                return building.get(index);
                            };
                            surfaceSets = surfaces;
                            // Build the first snapshot's field when the scene is ready; subsequent fields build on demand.
                            const buildFirstSurface = () => {
                                if (disposed) return;
                                ensureSurface(0).catch(error => {
                                    container.dataset.surface = 'error';
                                    model.set('error', error.message);
                                    model.save_changes();
                                    console.error('Molstar viewer:', error);
                                });
                            };
                            // Snapshot initialization requests its first surface itself.
                            if (!titles.length) {
                                if (window.requestIdleCallback) requestIdleCallback(buildFirstSurface, {timeout:2000});
                                else setTimeout(buildFirstSurface, 0);
                            }
                            if (view && (view.color_field || view.color_fields.some(Boolean) || view.signed)) addLegend(view);
                            // Atoms coloured by a quantity take the molecule viewer's own colour scale.
                            else if ((model.get('atom_colors') || []).length) addLegend({color_range:model.get('color_range'),
                                colors:model.get('colors'), color_label:model.get('color_label'),
                                color_description:model.get('color_description'), signed:false});
                            };
                            buildFields();
                            const camera = plugin.canvas3d.camera;
                            const [lower, upper] = model.get('bounds');
                            const centre = lower.map((value, axis) => (value + upper[axis]) / 2);
                            const half = lower.map((value, axis) => (upper[axis] - value) / 2);
                            const initialSnapshot = () => {
                                // Hidden tab panels are fitted again on their first measurable layout.
                                const width = container.clientWidth, height = container.clientHeight;
                                const aspect = width > 0 && height > 0 ? width / height : 1;
                                if (model.get('fit_atoms')) {
                                    // The molecule sets the view, with Molstar's own fit and a margin for the drawn
                                    // atoms, as in the viewers without a field; the field's box can reach far beyond it.
                                    const {Vec3} = molstar.lib.math.LinearAlgebra;
                                    const sphere = structure.boundary.sphere;
                                    const focus = camera.getFocus(Vec3.clone(sphere.center), sphere.radius + 1,
                                        Vec3.create(0, 1, 0), Vec3.create(0, 0, -1));
                                    container.dataset.initialDistance = String(Vec3.distance(focus.position, focus.target));
                                    return focus;
                                }
                                const distance = Math.max(half[1], half[0] / aspect)
                                    / Math.tan(camera.state.fov / 2) * 1.12 / 0.90 + half[2];
                                // Camera-target distance is in angstrom, matching the shared bounds.
                                container.dataset.initialDistance = String(distance);
                                return {target:centre, position:[centre[0],centre[1],centre[2]+distance],up:[0,1,0]};
                            };
                            const reset=plugin.canvas3d.requestCameraReset.bind(plugin.canvas3d);
                            // Resetting jumps straight to the initial view: Molstar's camera transition redraws every frame
                            // at full cost, which stutters where interactive drags do not.
                            plugin.canvas3d.requestCameraReset=(options={})=>reset({...options,snapshot:options.snapshot ?? initialSnapshot(),
                                durationMs:0});
                            plugin.canvas3d.requestCameraReset({durationMs:0});
                            // Molstar resets the camera by itself whenever a commit shows something beyond the previous
                            // visible bounds, such as another snapshot's larger field, which changes the zoom unasked.
                            // Resets here come only from the reset button and the first fit; the clipping range follows
                            // whatever is visible instead (fitClipping).
                            plugin.canvas3d.setProps({camera:{...plugin.canvas3d.props.camera, manualReset:true}});
                            const clippingCommits = plugin.canvas3d.reprCount.subscribe(fitClipping);
                            const clippingMoves = plugin.canvas3d.camera.stateChanged.subscribe(fitClipping);
                            disposeClipping = () => { clippingCommits.unsubscribe(); clippingMoves.unsubscribe(); };
                            let fittedVisible = container.clientWidth > 0 && container.clientHeight > 0;
                            cameraObserver = new ResizeObserver(() => {
                                if (!fittedVisible && container.clientWidth > 0 && container.clientHeight > 0) {
                                    fittedVisible = true;
                                    plugin.canvas3d.requestCameraReset({durationMs:0});
                                }
                            });
                            cameraObserver.observe(container);
                            if (titles.length) await buildSnapshots();
                        }
                        // Advance the existing native model; measurements and representations follow it.
                        await plugin.state.data.build().to(modelRef).update({modelIndex:target-1}).commit();
                        const measurements = plugin.managers.structure.measurement.state;
                        if (measurements.distances.length !== model.get('distances').length
                            || measurements.angles.length !== (model.get('angles') || []).length) {
                            throw new Error('Unexpected native measurement count');
                        }
                        loaded = true;
                        container.dataset.frame = target;
                        shownFrame = target - 1;
                        drawLabels();
                        placeLabels();
                        model.set('frame', target); model.set('error', ''); model.save_changes();
                    }
                } catch (error) {
                    console.error('Molstar viewer:', error);
                    model.set('error', error.message);
                    model.save_changes();
                } finally {
                    canvas.commit(true);
                    canvas.resume();
                    canvas.requestDraw();
                    updating = false;
                    endLoading();
                }
            }
            // The colour scale of a coloured isosurface or of coloured atoms, ``look``: its colours from the lower to the upper end
            // of its range, with the quantity and unit above, at the bottom centre of the viewport.
            function addLegend(look) {
                const [lower, upper] = look.color_range, colors = look.colors;
                const legend = document.createElement('div');
                legend.className = 'molstarview-legend';
                const title = document.createElement('div');
                title.className = 'molstarview-legend-title';
                let label = look.color_label;
                // The title's $...$ LaTeX is typeset by the page's KaTeX once it has loaded.
                // The quantity's explanation opens from the page's info button beside the label, added once the
                // label is typeset and the page has the button.
                let description = look.color_description;
                const explain = () => {
                    if (!description || !label) return;
                    if (!globalThis.quartoInfoButton) { setTimeout(explain, 200); return; }
                    title.append(globalThis.quartoInfoButton(description));
                };
                const typeset = () => {
                    const math = globalThis.katex;
                    if (!math && label.includes('$')) { setTimeout(typeset, 200); return; }
                    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    title.innerHTML = label.split(/(\$[^$]+\$)/).map(part =>
                        part.length > 2 && part.startsWith('$') && part.endsWith('$')
                            ? math.renderToString(part.slice(1, -1), {throwOnError:false}) : escape(part)).join('');
                    explain();
                };
                typeset();
                // A snapshot showing another quantity of the same field, such as one atom's part of an orbital, retitles
                // the scale while it is shown.
                legend.relabel = (text, about) => {
                    if (text === label && (about === undefined || about === description)) return;
                    label = text;
                    if (about !== undefined) description = about;
                    typeset();
                };
                const bar = document.createElement('div');
                bar.className = 'molstarview-legend-bar';
                // A signed field shows only its two surfaces: one colour per sign, split at zero.
                const signed = look.signed;
                bar.style.background = signed
                    ? `linear-gradient(to right, ${colors[0]} 50%, ${colors[colors.length - 1]} 50%)`
                    : `linear-gradient(to right, ${colors.join(', ')})`;
                const ticks = document.createElement('div');
                ticks.className = 'molstarview-legend-ticks';
                const format = value => Math.abs(value) < 1e-12 ? '0'
                    : (signed && value > 0 ? '+' : '') + Number(value.toPrecision(3)).toString().replace('-', '\u2212');
                for (const value of signed ? [lower, upper] : [lower, (lower + upper) / 2, upper]) {
                    const tick = document.createElement('span');
                    tick.textContent = format(value);
                    ticks.append(tick);
                }
                legendTicks = ticks; legendFormat = format;
                // Another quantity on the same colours, such as another part's shares, takes its own range.
                legend.rescale = ([low, high]) => {
                    const values = signed ? [low, high] : [low, (low + high) / 2, high];
                    [...ticks.children].forEach((tick, index) => { tick.textContent = format(values[index]); });
                };
                if (label) legend.append(title);
                legend.append(bar, ticks);
                container.style.position = 'relative';
                container.append(legend);
            }
            const requested = () => update(model.get('requested'));
            model.on('change:requested', requested);
            await update(model.get('requested'));
            const disposeFrames = animated ? installFrameControls() : () => {};
            const disposeTrail = model.get('trail') ? installTrail() : () => {};
            let disposeField = installFieldControls();
            // The views take turns in this viewer, switched by a button at the end of Molstar's right-hand toolbar. Each
            // keeps its surfaces, colour scale and settings, built when it is first shown; the molecule and the camera stay.
            const viewStates = [];
            let switching = false;
            const nextTitle = () => 'Show ' + views[(viewIndex + 1) % views.length].title;
            async function switchView() {
                if (switching) return;
                if (compositionShown) await toggleComposition();
                if (surfacesHidden) await toggleSurfaces();
                switching = true;
                selection.epoch++;
                announceSelection(selection);
                const endLoading = begin();
                const plugin = viewer.plugin, state = plugin.state.data, canvas = plugin.canvas3d;
                canvas.pause();
                try {
                    const legend = container.querySelector('.molstarview-legend');
                    viewStates[viewIndex] = {surfaceSets, ensureSurface, legend, legendTicks, legendFormat};
                    disposeField();
                    legend?.remove();
                    for (const set of surfaceSets) if (set) {
                        set.iso.forEach(ref => state.updateCellState(ref, {isHidden:true}));
                        if (set.direct) state.updateCellState(set.direct, {isHidden:true});
                    }
                    renderMode = 'isosurface';
                    viewIndex = (viewIndex + 1) % views.length;
                    view = views[viewIndex];
                    const saved = viewStates[viewIndex];
                    if (saved) {
                        ({surfaceSets, ensureSurface, legendTicks, legendFormat} = saved);
                        if (saved.legend) container.append(saved.legend);
                    } else buildFields();
                    // The shown snapshot's field, or the only one.
                    const shown = surfaceSets.length > 1 ? currentSnapshot() : 0;
                    await ensureSurface(shown);
                    disposeField = installFieldControls();
                    // The view's settings start from its defaults, so its surfaces are shown at them.
                    if (showFields) await queueField(() => showFields(surfaceSets.length > 1 ? shown : -1));
                    else surfaceSets.forEach((set, index) => {
                        if (!set || index !== shown) return;
                        refineSilently(set);
                        set.iso.forEach(ref => state.updateCellState(ref, {isHidden:false}));
                    });
                    plugin.canvas3dContext.setProps({transparency:'dpoit'});
                    viewSwitch.title(nextTitle());
                } finally {
                    canvas.commit(true);
                    canvas.resume();
                    canvas.requestDraw();
                    switching = false;
                    endLoading();
                }
            }
            const viewSwitch = views.length > 1 ? installViewSwitch(container, switchView) : null;
            viewSwitch?.title(nextTitle());

            // The composition of each snapshot's orbital on the atoms: one toolbar toggle colours every atom by its share of
            // the shown orbital, with that share's colour scale beside the field's, and another hides or shows the field's
            // surfaces, so the shares can be read with or without them. The colours are Molstar overpaint layers on the atoms'
            // own representations, so sizes, bonds and hover stay native.
            // Hides the surfaces when asked and paints the shown snapshot's shares, or removes them; the caller holds the
            // field queue.
            async function showComposition() {
                const plugin = viewer.plugin, state = plugin.state.data;
                const transforms = molstar.lib.plugin.StateTransforms.Representation;
                if (surfacesHidden) for (const set of surfaceSets) if (set) {
                    set.iso.forEach(ref => state.updateCellState(ref, {isHidden:true}));
                    if (set.direct) state.updateCellState(set.direct, {isHidden:true});
                }
                const build = state.build();
                for (const cell of state.cells.values()) if (cell.transform.tags?.includes(COMPOSITION)) build.delete(cell.transform.ref);
                const entry = snapshotAtoms[currentSnapshot()];
                if (compositionShown && entry && compositionLegend) {
                    // The scale of the shown part's shares, such as w_{A,s} for the s functions.
                    const scale = compositionScale(entry);
                    compositionLegend.relabel(scale.color_label, scale.color_description || '');
                    compositionLegend.rescale(scale.color_range);
                }
                if (compositionShown && entry) {
                    const structure = plugin.managers.structure.hierarchy.current.structures[0].cell.obj.data;
                    const locate = atomLocations(structure), {StructureElement} = molstar.lib.structure;
                    const layers = entry.colors.map((color, index) => ({bundle:StructureElement.Bundle.fromLoci(locate(index)),
                        color:parseInt(color.slice(1), 16), clear:false}));
                    for (const cell of state.cells.values()) {
                        if (cell.transform.transformer !== transforms.StructureRepresentation3D || cell.transform.tags?.includes(COMPOSITION)) continue;
                        build.to(cell.transform.ref).apply(transforms.OverpaintStructureRepresentation3DFromBundle, {layers}, {tags:COMPOSITION});
                    }
                }
                await build.commit();
            }
            // Both colour scales sit side by side while both apply; otherwise the one that applies is centred.
            function placeLegends() {
                const field = [...container.querySelectorAll('.molstarview-legend')].find(legend => legend !== compositionLegend);
                const both = compositionShown && !surfacesHidden && field;
                if (field) { field.style.display = surfacesHidden ? 'none' : ''; field.style.left = both ? 'calc(50% - 115px)' : ''; }
                if (compositionLegend) {
                    compositionLegend.style.display = compositionShown ? '' : 'none';
                    compositionLegend.style.left = both ? 'calc(50% + 115px)' : '';
                }
            }
            // The colour scale of a snapshot's atom shares.
            const compositionScale = entry => {
                const scales = (model.get('atom_scale') || {}).scales || {};
                return scales[entry?.scale] || Object.values(scales)[0] || {};
            };
            async function toggleComposition() {
                compositionShown = !compositionShown;
                if (compositionShown && !compositionLegend) {
                    // The field's level controls keep updating the field's own scale.
                    const kept = [legendTicks, legendFormat];
                    addLegend({...compositionScale(snapshotAtoms[currentSnapshot()]), signed:false});
                    compositionLegend = container.lastElementChild;
                    compositionLegend.classList.add('molstarview-composition-legend');
                    [legendTicks, legendFormat] = kept;
                }
                placeLegends();
                compositionSwitch.look(compositionShown);
                await queueField(showComposition);
            }
            async function toggleSurfaces() {
                surfacesHidden = !surfacesHidden;
                placeLegends();
                surfaceSwitch.look(!surfacesHidden);
                if (surfacesHidden) await queueField(showComposition);
                else await showSnapshot(currentSnapshot());
            }
            const scale = model.get('atom_scale') || {};
            // Material Design Icons "chart-pie" and "eye" (Apache 2.0), from the family of Molstar's own material icons.
            const compositionSwitch = snapshotAtoms.length ? installFieldToggle(container, scale.title || 'Toggle Atom Shares',
                'M11,2V22C5.9,21.5 2,17.2 2,12C2,6.8 5.9,2.5 11,2M13,2V11H22C21.5,6.2 17.8,2.5 13,2M13,13V22C17.7,21.5 21.5,17.8 22,13H13Z',
                toggleComposition, false) : null;
            const surfaceSwitch = snapshotAtoms.length ? installFieldToggle(container, scale.surface_title || 'Toggle Surfaces',
                'M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z',
                toggleSurfaces, true) : null;

            // A motion blur: faded copies of the molecule at the frames Python chose for each range, as many as the motion
            // needs, each a native model of its own copy of the trajectory.
            // What the scene draws, as each visible representation with the transforms from the shown structure down to it.
            // The copies repeat exactly these, so they select, bond, colour and size atoms as the scene does: a virtual
            // point stays out of the molecule's bonds, keeps its colour, and is absent if the scene does not draw it.
            function sceneRecipes() {
                const state = viewer.plugin.state.data, recipes = [];
                const representation = molstar.lib.plugin.StateTransforms.Representation.StructureRepresentation3D;
                for (const cell of state.cells.values()) {
                    if (cell.transform.transformer !== representation || cell.state.isHidden || !cell.obj?.data?.repr) continue;
                    const chain = [];
                    let step = cell;
                    while (step && step.transform.parent !== modelRef && step.transform.parent !== step.transform.ref) {
                        chain.unshift(step);
                        step = state.cells.get(step.transform.parent);
                    }
                    // Whatever does not descend from the shown model, such as a measurement's own structure, is not copied.
                    if (step?.transform.parent === modelRef) recipes.push(chain);
                }
                return recipes;
            }
            // Molstar colours carbons by model, so a copy takes the shown molecule's carbon colour as a uniform one.
            function fixedCarbons(cell) {
                const plugin = viewer.plugin, colorTheme = cell.transform.params.colorTheme;
                if (colorTheme.name !== 'element-symbol') return colorTheme;
                const structure = plugin.state.data.cells.get(cell.transform.parent).obj?.data;
                const unit = structure?.units.find(unit => unit.kind === 0);
                const element = unit && Array.from(unit.elements).find(atom => unit.model.atomicHierarchy.atoms.type_symbol.value(atom) === 'C');
                if (element === undefined) return colorTheme;
                const theme = plugin.representation.structure.themes.colorThemeRegistry.create(colorTheme.name, {structure}, colorTheme.params);
                return {...colorTheme, params:{...colorTheme.params, carbonColor:{name:'uniform', params:{
                    value:theme.color({kind:'element-location', structure, unit, element}, false)}}}};
            }
            async function addTrail(frames, parent, onParent) {
                const plugin = viewer.plugin, state = plugin.state.data;
                // Keep the displayed model on its own trajectory for Molstar's native controls; the trail copies
                // share one separate trajectory so its data are parsed only once.
                const source = state.cells.get(state.cells.get(modelRef).transform.parent).transform;
                const recipes = sceneRecipes();
                const transforms = molstar.lib.plugin.StateTransforms, build = state.build();
                const trajectory = parent ? build.to(parent) : build.to(source.parent).apply(source.transformer, source.params);
                onParent(trajectory.ref);
                // Use the native model implementation under its own transformer identity. Molstar's viewport controls
                // otherwise mistake these background models for extra user-controlled trajectories and disappear.
                const nativeModel = transforms.Model.ModelFromTrajectory;
                const trailModel = globalThis.molstarTrailModel ??= molstar.lib.plugin.PluginStateTransform.BuiltIn({
                    name:'molstarview-trail-model', from:nativeModel.definition.from, to:nativeModel.definition.to,
                    display:'Motion trail model', params:nativeModel.definition.params
                })({...nativeModel.definition, name:'molstarview-trail-model'});
                frames.forEach((modelIndex, frame) => {
                    const copy = build.to(trajectory.ref).apply(trailModel, {modelIndex});
                    trailModels.push(copy.ref);
                    const structure = copy.apply(transforms.Model.StructureFromModel, {type:{name:'model', params:{dynamicBonds:true}}});
                    // Representations sharing a component share its copy.
                    const copied = new Map();
                    for (const chain of recipes) {
                        let node = structure;
                        chain.forEach((cell, depth) => {
                            const {ref, transformer, params} = cell.transform;
                            if (depth < chain.length - 1) {
                                if (!copied.has(ref)) copied.set(ref, node.apply(transformer, params));
                                node = copied.get(ref);
                                return;
                            }
                            const drawn = node.apply(transformer, {...params, type:{...params.type, params:{...params.type.params, alpha:0.35}},
                                colorTheme:fixedCarbons(cell)}, {state:{isHidden:true}});
                            trailRepresentations.push({ref:drawn.ref, frame});
                        });
                    }
                });
                await build.commit();
                return trajectory.ref;
            }

            // Combine Molstar's own ball-and-stick geometries into two render objects. The native representations
            // remain the source of atom sizes, colours, bonds and per-frame geometry; only their draw submission is
            // batched. A group per native colour/size group keeps each frame independently fadeable in one texture.
            async function batchTrail(frames) {
                const base = 'https://cdn.jsdelivr.net/npm/molstar@5.13.1/lib/';
                const [spheresModule, cylindersModule, transparency] = await Promise.all([
                    import(base + 'mol-geo/geometry/spheres/spheres.js/+esm'),
                    import(base + 'mol-geo/geometry/cylinders/cylinders-builder.js/+esm'),
                    import(base + 'mol-geo/geometry/transparency-data.js/+esm')]);
                const state = viewer.plugin.state.data, canvas = viewer.plugin.canvas3d;
                const sources = {
                    spheres:{centers:[], groups:[], colors:[], sizes:[], runs:[], offset:0},
                    cylinders:{builder:cylindersModule.CylindersBuilder.create(), colors:[], sizes:[], runs:[], offset:0}
                };
                // This bounds temporary native state and GPU objects, not the number or distribution of samples.
                const chunkSize = 8;
                let parent = null;
                try {
                    for (let first = 0; first < frames.length; first += chunkSize) {
                        parent = await addTrail(frames.slice(first, first + chunkSize), parent, ref => { parent = ref; });
                        const native = trailRepresentations.map(({ref, frame}) => ({frame, repr:state.cells.get(ref)?.obj?.data?.repr}));
                        if (native.some(({repr}) => !repr)) throw new Error('Motion trail representation is missing');
                        native.forEach(({repr, frame}) => repr.renderObjects.forEach(object => {
                            const v = object.values, kind = v.dGeometryType.ref.value, part = sources[kind];
                            const colorType = v.dColorType.ref.value, sizeType = v.dSizeType.ref.value;
                            if (!part || !['group', 'groupInstance', 'uniform'].includes(colorType) || !['group', 'uniform'].includes(sizeType)
                                || v.instanceCount.ref.value !== 1) throw new Error('Unsupported motion trail geometry or theme');
                            // Each representation has its own size factor, so it goes into the sizes of its groups.
                            part.props ??= {...repr.props, sizeFactor:1};
                            const factor = v.uSizeFactor.ref.value, count = v.uGroupCount.ref.value;
                            const c = colorType === 'uniform' ? v.uColor.ref.value.map(value => Math.round(255 * value)) : v.tColor.ref.value.array;
                            const z = sizeType === 'uniform' ? null : v.tSize.ref.value.array;
                            for (let j = 0; j < count; j++) {
                                const k = colorType === 'uniform' ? 0 : 3 * j;
                                part.colors.push((c[k] << 16) | (c[k+1] << 8) | c[k+2]);
                                part.sizes.push(factor * (z ? (z[3*j]*65536 + z[3*j+1]*256 + z[3*j+2] - 1) / 100 : v.uSize.ref.value));
                            }
                            part.runs.push({frame:first + frame, start:part.offset, end:part.offset + count});
                            if (kind === 'spheres') {
                                const xyz = v.centerBuffer.ref.value, ids = v.groupBuffer.ref.value;
                                for (let j = 0; j < v.uVertexCount.ref.value / 6; j++) {
                                    part.centers.push(xyz[3*j], xyz[3*j+1], xyz[3*j+2]);
                                    part.groups.push(part.offset + ids[j]);
                                }
                            } else {
                                const start = v.aStart.ref.value, end = v.aEnd.ref.value, ids = v.aGroup.ref.value;
                                const scale = v.aScale.ref.value, caps = v.aCap.ref.value, mode = v.aColorMode.ref.value;
                                for (let j = 0; j < v.uVertexCount.ref.value; j += 6) {
                                    const k = j * 3, cap = caps[j];
                                    part.builder.add(start[k], start[k+1], start[k+2], end[k], end[k+1], end[k+2],
                                        scale[j], !!(cap & 1), !!(cap & 2), mode[j], part.offset + ids[j]);
                                }
                            }
                            part.offset += count;
                        }));
                        native.forEach(({repr}) => canvas.remove(repr));
                        const remove = state.build();
                        trailModels.forEach(ref => remove.delete(ref));
                        await remove.commit();
                        trailModels.length = 0;
                        trailRepresentations.length = 0;
                        // Give pointer and playback events an opportunity between geometry batches.
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                } finally {
                    if (parent && state.cells.has(parent)) await state.build().delete(parent).commit();
                    trailModels.length = 0;
                    trailRepresentations.length = 0;
                }
                const packed = [];
                for (const kind of ['spheres', 'cylinders']) {
                    const part = sources[kind];
                    if (!part.offset) continue;
                    const geometry = kind === 'spheres'
                        ? spheresModule.Spheres.create(new Float32Array(part.centers), new Float32Array(part.groups), part.groups.length)
                        : part.builder.getCylinders();
                    const shape = molstar.lib.shape.Shape.create('Motion trail', null, geometry,
                        group => part.colors[group], group => part.sizes[group], () => 'Motion trail');
                    const object = molstar.lib.shape.Shape.createRenderObject(shape, part.props);
                    object.state.pickable = false;
                    transparency.createTransparency(part.offset, 'groupInstance', object.values);
                    packed.push({object, runs:part.runs, count:part.offset});
                }
                if (!packed.length) throw new Error('Motion trail has no supported geometry');
                const repr = {renderObjects:packed.map(item => item.object), state:{syncManually:true},
                    updated:{subscribe:() => ({unsubscribe(){}})}, mark:() => false,
                    getLoci:() => ({kind:'empty-loci'}), getAllLoci:() => []};
                canvas.add(repr);
                return {repr, packed};
            }

            // A toggle in Molstar's right-hand toolbar shows the trail. Each copy keeps a fixed frame of the shown range, so
            // stepping through frames only refades the copies instead of rebuilding their models, bonds and geometry;
            // only a change of range moves them. A copy's opacity depends only on its distance in frames from the shown
            // one, so the trail looks the same whichever way or however fast the frames are stepped.
            function installTrail() {
                const plugin = viewer.plugin, state = plugin.state.data, total = model.get('frame_count');
                // Hidden until the toggle turns it on.
                let shown = false, last = null, busy = false, again = false;
                const trailFrames = model.get('trail_frames');
                let batch = null, batchFrames = null;
                const range = index => {
                    // Find the last snapshot start no greater than the current frame.
                    let low = 0, high = segments.length;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        if (segmentStarts[middle] <= index) low = middle + 1; else high = middle;
                    }
                    const segment = Math.max(0, low - 1), start = segmentStarts[segment], count = segments[segment];
                    return count !== undefined && index < start + count ? [start, count] : [0, total];
                };
                const follow = async () => {
                    if (busy) { again = true; return; }
                    busy = true;
                    try {
                        do {
                            again = false;
                            const index = state.cells.get(modelRef).transform.params.modelIndex, [start] = range(index);
                            last = index;
                            const frames = trailFrames[segments.length ? segmentStarts.indexOf(start) : 0];
                            if (!batch || batchFrames !== frames) {
                                // Temporary native models supply exact Molstar bonds, sizes and colours, then are
                                // discarded in small chunks so neither GPU memory nor state size scales with frames.
                                const previous = batch;
                                batch = await batchTrail(frames);
                                batchFrames = frames;
                                if (previous) plugin.canvas3d.remove(previous.repr);
                            }
                            apply();
                            fade(index, frames);
                        } while (again && !disposed);
                    } finally { busy = false; }
                };
                // Sets the copies' transparency, which changes no geometry. Opacity falls with the distance in copies from the
                // shown frame, to a floor that keeps every copy visible, so all the path always shows. A copy at the shown
                // frame is hidden, and more copies are each fainter, so they do not pile up.
                const fade = (index, frames) => {
                    const reach = Math.max(1, frames.length - 1), peak = Math.min(1, Math.sqrt(10 / frames.length));
                    const after = frames.findIndex(frame => frame >= index);
                    const position = after < 0 ? frames.length - 1 : after;
                    const opacity = Uint8Array.from(frames, (frame, k) => frame === index ? 255
                        : Math.round(255 * (1 - peak * (0.25 + 0.75 * (1 - Math.abs(k - position) / reach) ** 2))));
                    if (batch) for (const {object, runs, count:groupCount} of batch.packed) {
                        const values = object.values, texture = values.tTransparency.ref.value;
                        let sum = 0, min = 255;
                        for (const {frame, start, end} of runs) {
                            const value = opacity[frame];
                            texture.array.fill(value, start, end);
                            sum += value * (end - start);
                            if (value > 0 && value < min) min = value;
                        }
                        // ValueCell's immutable version tells Molstar to upload the changed texture.
                        values.tTransparency.ref = {...values.tTransparency.ref, value:texture, version:values.tTransparency.ref.version + 1};
                        const update = (cell, value) => { cell.ref = {...cell.ref, value, version:cell.ref.version + 1}; };
                        update(values.transparencyAverage, sum / (255 * groupCount));
                        update(values.transparencyMin, min / 255);
                    }
                    plugin.canvas3d?.requestDraw();
                };
                const apply = () => {
                    if (batch) {
                        batch.packed.forEach(({object}) => { object.state.visible = shown; });
                        plugin.canvas3d?.syncVisibility();
                        return;
                    }
                    trailRepresentations.forEach(({ref, frame}) => {
                        const hidden = !shown;
                        if (state.cells.get(ref)?.state.isHidden !== hidden) state.updateCellState(ref, {isHidden:hidden});
                    });
                };
                const button = document.createElement('button');
                button.type = 'button';
                button.title = 'Toggle Motion Trail';
                button.setAttribute('aria-label', button.title);
                // Material "blur_on" icon, as Molstar's own buttons use material icons.
                button.innerHTML = '<span class="msp-icon msp-material-icon"><svg width="24px" height="24px" viewBox="0 0 24 24">'
                    + '<path d="M6 13c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0-8c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-3 .5c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zM6 5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm15 5.5c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5zM14 7c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1zm0-3.5c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5zm-11 10c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zm7 7c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zm0-17c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5zM10 7c.55 0 1-.45 1-1s-.45-1-1-1-1 .45-1 1 .45 1 1 1zm0 5.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm8 .5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0-8c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0-4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3 8.5c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zM14 17c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 3.5c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zm-4-12c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0 8.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm4-4.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-4c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"></path></svg></span>';
                const look = () => {
                    button.className = 'msp-btn molstar-trail-toggle msp-btn-link-toggle-' + (shown ? 'on' : 'off');
                    button.setAttribute('aria-pressed', String(shown));
                };
                let building = null, ready = false;
                const showTrail = () => {
                    if (building) return building;
                    // State events also fire during the first commit. Do not update copies until both commits finish:
                    // a competing commit interrupts construction and leaves some structures pending.
                    building = Promise.resolve().then(async () => { ready = true; await follow(); }).catch(error => {
                        building = null; ready = false; shown = false; look();
                        console.error('Molstar viewer:', error);
                    });
                    return building;
                };
                // Weighted order-independent transparency accumulates every trail copy in one pass, an approximate blend
                // that avoids repeated depth-peeling passes for hundreds of overlapping copies.
                button.addEventListener('click', () => {
                    shown = !shown;
                    viewer.plugin.canvas3dContext.setProps({transparency:shown ? 'wboit' : 'dpoit'});
                    look(); if (shown) { if (ready) follow(); else showTrail(); } else apply();
                });
                look();
                apply();
                // The toggle is an icon button in Molstar's right-hand toolbar, like its other viewport controls.
                const wrapper = document.createElement('div');
                wrapper.className = 'msp-hover-box-wrapper';
                const background = document.createElement('div');
                background.className = 'msp-semi-transparent-background';
                wrapper.append(background, button);
                const attach = () => {
                    const buttons = container.querySelector('.msp-viewport-controls-buttons');
                    if (buttons && wrapper.parentElement !== buttons) buttons.append(wrapper);
                };
                const toolbar = new MutationObserver(attach);
                toolbar.observe(container, {childList:true, subtree:true});
                // Applying a snapshot restores its recorded visibility and trail frames; restore the toggle's choice and
                // follow the native model again after every state change.
                const frames = state.events.cell.stateUpdated.subscribe(({ref}) => { if (ready && shown && ref === modelRef) follow(); });
                const changes = state.events.changed.subscribe(() => {
                    if (!ready) return;
                    apply();
                    // State changes unrelated to the displayed frame do not change the trail's opacity or geometry.
                    if (shown && state.cells.get(modelRef)?.transform.params.modelIndex !== last) follow();
                });
                attach();
                return () => { toolbar.disconnect(); frames.unsubscribe(); changes.unsubscribe();
                    if (batch) plugin.canvas3d?.remove(batch.repr); wrapper.remove(); };
            }

            // The first frame of a snapshot: its own frame, or for an animated one the first of its frames.
            function firstFrame(index) {
                return segments.length ? segmentStarts[index] : index;
            }
            // One snapshot: its frame and any fields in the current render mode, built on first being shown, in one held frame.
            function showSnapshot(index) {
                snapshotIndex = index;
                return queueField(async () => {
                const plugin = viewer.plugin, state = plugin.state.data, canvas = plugin.canvas3d;
                canvas.pause(true);
                try {
                    await ensureSurface(index);
                    await state.build().to(modelRef).update({modelIndex:firstFrame(index)}).commit();
                    if (showFields) await showFields(index);
                    else surfaceSets.forEach((set, other) => set?.iso.forEach(ref =>
                        state.updateCellState(ref, {isHidden:other !== index})));
                    if (compositionShown || surfacesHidden) await showComposition();
                    const field = (model.get('snapshot_fields') || [])[index];
                    if (field) [...container.querySelectorAll('.molstarview-legend')]
                        .find(legend => legend !== compositionLegend)?.relabel?.(field.label);
                } finally {
                    canvas.commit(true);
                    canvas.resume();
                    canvas.requestDraw();
                }
                });
            }

            // One menu entry per title, all sharing one recorded state, so an option costs nothing until it is chosen:
            // nothing is built or moved for the options never shown, however many there are. Every way of switching
            // (dropdown, buttons, keys) goes straight to that snapshot's frame and fields as they are currently shown,
            // with the last frame held on screen and the camera kept.
            async function buildSnapshots(key = '1') {
                const plugin = viewer.plugin, manager = plugin.managers.snapshot;
                const Entry = manager.constructor.Entry;
                manager.clear();
                const recorded = plugin.state.getSnapshot({camera:false, behavior:false});
                titles.forEach((title, index) => {
                    // Molstar finds an entry by its snapshot's id. The native name, without dollars, is only Molstar's own
                    // record; the dropdown shows the title.
                    manager.add(Entry({...recorded, id:`${recorded.id}-${index}`}, {key:String(index + 1), name:title.replace(/\$/g, '')}));
                });
                if (!snapshotsBuilt) {
                    const setSnapshot = plugin.state.setSnapshot;
                    plugin.state.setSnapshot = async function (snapshot, ...rest) {
                        const entry = manager.getEntry(manager.state.current);
                        if (!entry || entry.snapshot !== snapshot) return setSnapshot.call(this, snapshot, ...rest);
                        const index = Number(entry.key) - 1;
                        if (!Number.isInteger(index)) return setSnapshot.call(this, snapshot, ...rest);
                        try { await showSnapshot(index); }
                        catch (error) {
                            model.set('error', error.message); model.save_changes();
                            console.error('Molstar viewer:', error);
                        }
                    };
                }
                if (!snapshotsBuilt) {
                    manager.events.changed.subscribe(showSnapshotMenu);
                    // Molstar draws its snapshot controls asynchronously and redraws them as the state changes; the
                    // dropdown is placed whenever its selector exists without it, not only when the snapshots change.
                    snapshotObserver = new MutationObserver(() => {
                        const select = container.querySelector('.msp-state-snapshot-viewport-controls select');
                        if (select) decorateStarts(select.parentElement);
                    if (select && (!snapshotMenu || snapshotMenu.parentElement !== select.parentElement)) showSnapshotMenu();
                    });
                    snapshotObserver.observe(container, {childList:true, subtree:true});
                }
                snapshotsBuilt = true;
                await manager.applyKey(key);
                snapshotIndex = Math.max(0, Number(key) - 1 || 0);
                showSnapshotMenu();
            }

            // The toolbar switches rendering mode; the settings panel holds field level and opacity for every snapshot.
            function installFieldControls() {
                const range = view?.level_range || [];
                if (range.length !== 2 || !surfaceSets.length) return () => {};
                const plugin = viewer.plugin, lib = molstar.lib;
                const transformer = lib.plugin.StateTransforms.Representation.VolumeRepresentation3D;
                const signed = view.signed, sign = Math.sign(view.isovalue) || 1;
                const colors = view.colors.map(c => parseInt(c.slice(1), 16));
                const scale = view.field_scale || 1;
                // The level is a magnitude in the units the field is written in; the opacity is that of the surfaces.
                const settings = {level:Math.abs(view.isovalue), opacity:view.opacity};
                const shownIndex = () => currentSnapshot();
                // Direct volume rendering as a fog: each cell's opacity grows smoothly with the field's magnitude m,
                // alpha = peak (1 - exp(-((m - edge) / (level - edge))^2)) above the edge and none below it. The box keeps
                // every point at or above the slider's lowest level, so its faces lie just below it; the edge sits a little
                // above. Unlit, so the fog has no surface shading of its own.
                //
                // Molstar looks the opacity up in a table of 256 bytes spread over the rendered values' range and
                // smooths it with a spline, so a fog drawn from the field itself fades within one entry of zero, and the
                // faint opacity leaking into that entry fills the whole box. The fog is therefore drawn from its own
                // volume: f = FOG asinh(v / s) / asinh(top / s), with s the default level and top the largest magnitude,
                // exactly zero below the edge. Near the level f is linear in v and both signs share it, so a potential's
                // weak negative lobes keep as many entries as its positive ones, while the nuclei's huge values are
                // compressed logarithmically; the table is zero for some entries beyond the edge, so nothing near zero is drawn.
                const edge = 1.25 * range[0], FOG = 20000, margin = 3;
                // The fog volume of a field, parsed from its own cube with every value mapped as above.
                async function fogVolume(set) {
                    if (set.fog && plugin.state.data.cells.has(set.fog.ref)) return;
                    const stats = set.volume.data.grid.stats, top = Math.max(Math.abs(stats.min), Math.abs(stats.max)) || 1;
                    const s = Math.abs(view.isovalue) || 1, compressed = Math.asinh(top / s);
                    const text = await readField(set.text);
                    const lines = text.split('\n'), count = Math.abs(parseInt(lines[2], 10));
                    const words = lines.slice(6 + count).join(' ').trim().split(/\s+/);
                    // The GPU interpolates the compressed field trilinearly, which varies smoothly across the fog's
                    // shells, so the fog keeps the field's own grid.
                    // The field is cut off at the faces of its box, where it may still be strong, so the fog fades to nothing
                    // over the outer fifth of each axis instead of ending in a visible box.
                    const dimensions = [3, 4, 5].map(row => Math.abs(parseInt(lines[row], 10)));
                    const taper = dimensions.map(n => {
                        const width = Math.max(4, Math.ceil(0.2 * n));
                        return index => { const t = Math.min(1, Math.min(index, n - 1 - index) / width); return t * t * (3 - 2 * t); };
                    });
                    const zero = Math.asinh(edge / s), mapped = [];
                    let flat = 0;
                    for (let i = 0; i < words.length; i += 6) mapped.push(words.slice(i, i + 6).map(word => {
                        const z = flat % dimensions[2], y = Math.floor(flat / dimensions[2]) % dimensions[1];
                        const x = Math.floor(flat / (dimensions[1] * dimensions[2]));
                        flat++;
                        const u = Math.asinh(Number(word) / s) * taper[0](x) * taper[1](y) * taper[2](z);
                        return Math.abs(u) <= zero ? 0 : Math.round(FOG * u / compressed);
                    }).join(' '));
                    const cube = lines.slice(0, 6 + count).join('\n') + '\n' + mapped.join('\n') + '\n';
                    const raw = await plugin.builders.data.rawData({data:cube, label:'Fog field'});
                    set.roots.push(raw.ref);
                    const parsed = await plugin.dataFormats.get('cube').parse(plugin, raw);
                    fogFields.set(parsed.volume.data, f => s * Math.sinh(f * compressed / FOG));
                    // Hovering reads the field itself, which the fade at the box's faces does not change.
                    fogOriginals.set(parsed.volume.data, set.volume.data.grid.cells.data);
                    set.fog = parsed.volume;
                    set.top = top;
                    set.fogScale = s;
                    set.compressed = compressed;
                    set.direct = null;
                }
                const directParams = set => {
                    const {min, max} = set.fog.data.grid.stats, span = max - min || 1, top = set.top;
                    const x = f => Math.min(1, Math.max(0, (f - min) / span));
                    const toFog = m => FOG * Math.asinh(m / set.fogScale) / set.compressed;
                    const fromFog = f => set.fogScale * Math.sinh(f * set.compressed / FOG);
                    // The fog matches the isosurfaces' opacity: a ray crossing the region inside the level gathers the
                    // surfaces' opacity, 1 - (1 - peak)^chord = opacity. The chord is half the cube root of that region's
                    // cell count, since the fog inside only rises to its peak towards the lobes' cores. Molstar scales
                    // each sample's alpha by its share of a cell, so the peak is per cell.
                    const level = settings.level, counts = set.insideCounts ??= new Map();
                    let inside = counts.get(level);
                    if (inside === undefined) {
                        const data = set.volume.data.grid.cells.data;
                        inside = 0;
                        for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) >= level) inside++;
                        counts.set(level, inside);
                    }
                    const chord = Math.max(1, Math.cbrt(inside) / 2);
                    // A fog fills the whole region, not only its boundary, so it takes half the surfaces' opacity, which
                    // keeps the molecule and the other lobes visible through it.
                    const peak = 1 - Math.pow(1 - Math.min(settings.opacity / 2, 0.999), 1 / chord);
                    // The fog starts a few table entries beyond the edge, so the zero entries around it stay zero.
                    const start = Math.max(edge, fromFog(toFog(edge) + margin * span / 256));
                    const width = Math.max(settings.level - start, 0.5 * start);
                    const magnitudes = [0, start];
                    for (let m = start * 1.1; m < top; m *= 1.1) magnitudes.push(m);
                    magnitudes.push(top);
                    const alpha = m => m <= start ? 0 : peak * (1 - Math.exp(-(((m - start) / width) ** 2)));
                    const side = s => magnitudes.map(m => [x(s * toFog(m)), alpha(m)]);
                    const points = (signed ? [...side(-1).reverse(), ...side(1).slice(1)] : side(sign))
                        .sort((p, q) => p[0] - q[0]);
                    const extent = Math.max(Math.abs(min), Math.abs(max));
                    const provider = plugin.representation.volume.registry.get('direct-volume');
                    const theme = plugin.representation.volume.themes.colorThemeRegistry.get('volume-value');
                    return {
                        type:{name:'direct-volume', params:{...provider.defaultValues, controlPoints:points,
                            ignoreLight:true, stepsPerCell:2,
                            // Molstar's default packs the volume into 8 bits over its whole range, which shows as
                            // stepped shells in a fog; half floats keep it smooth and, unlike full floats, are filtered
                            // linearly on every WebGL2 device.
                            dataType:'halfFloat'}},
                        colorTheme:{name:'volume-value', params:{...theme.defaultValues,
                            colorList:{kind:'interpolate', colors:signed
                                ? [[colors[0], 0], [colors[0], 0.499], [colors[colors.length - 1], 0.501], [colors[colors.length - 1], 1]]
                                : colors.map((color, index) => [color, index / Math.max(colors.length - 1, 1)])},
                            domain:{name:'custom', params:signed ? [-extent, extent] : [min, max]}, isRelative:false}},
                        sizeTheme:{name:'uniform', params:{value:1}}
                    };
                };
                // The fields of snapshot ``shown`` (-1 without snapshots) in the current render mode and settings,
                // committed in one transaction; the caller holds the canvas.
                // Starts the surfaces of a field at the current level in the workers before Molstar has built its own meshes,
                // which they would otherwise wait for, so the smooth surfaces are ready about when the first ones show.
                function prefetch(set) {
                    set.prefetch = new Map();
                    set.iso.forEach((ref, k) => {
                        const value = (signed ? (k === 0 ? -1 : 1) : sign) * settings.level;
                        const job = surfaceJob(set.volume.data, set.coloring, value, null, selection);
                        if (!job) return;
                        const started = buildSurface(job);
                        started.catch(() => {});
                        set.prefetch.set(String(value), started);
                    });
                }
                async function show(shown) {
                    selection.epoch++;
                    announceSelection(selection);
                    const IsoValue = lib.volume.Volume.IsoValue, state = plugin.state.data;
                    if (renderMode === 'isosurface') for (const [index, set] of surfaceSets.entries()) {
                        if (set && (shown < 0 || index === shown)) prefetch(set);
                    }
                    // The shown field's fog volume, built when first volume rendered.
                    if (renderMode === 'volume') for (const [index, set] of surfaceSets.entries()) {
                        if (set && (shown < 0 || index === shown)) await fogVolume(set);
                    }
                    // Depth peeling draws transparent visuals once per peel; a volume is drawn whole each time, so
                    // volume rendering blends in one pass and isosurfaces keep exact ordering.
                    plugin.canvas3dContext.setProps({transparency:renderMode === 'volume' ? 'blended' : 'dpoit'});
                    const build = state.build(), created = [];
                    for (const [index, set] of surfaceSets.entries()) {
                        if (!set) continue;
                        const visible = shown < 0 || index === shown;
                        set.iso.forEach((ref, k) => {
                            build.to(ref).update(old => ({...old, type:{...old.type,
                                params:{...old.type.params, alpha:settings.opacity, isoValue:IsoValue.absolute(
                                    (signed ? (k === 0 ? -1 : 1) : sign) * settings.level)}}}));
                        });
                        // Only the shown field is volume rendered; the others are built when first shown.
                        if (renderMode === 'volume' && visible && !set.direct) {
                            const direct = build.to(set.fog).apply(transformer, directParams(set));
                            created.push([set, direct.ref]);
                        } else if (set.direct) {
                            build.to(set.direct).update(directParams(set));
                        }
                    }
                    await build.commit();
                    created.forEach(([set, ref]) => { set.direct = ref; });
                    // A builder starts from a snapshot of the state tree: visibility changed before its commit can be
                    // overwritten by the older tree. Apply it afterward, including newly created representations.
                    surfaceSets.forEach((set, index) => {
                        if (!set) return;
                        const visible = shown < 0 || index === shown;
                        if (visible && renderMode === 'isosurface') refineSilently(set);
                        set.iso.forEach(ref => state.updateCellState(ref, {isHidden:!visible || renderMode !== 'isosurface'}));
                        if (set.direct) state.updateCellState(set.direct, {isHidden:!visible || renderMode !== 'volume'});
                    });
                    // A signed field's scale spans the two surfaces, at minus and plus the level.
                    if (legendTicks && signed) [...legendTicks.children].forEach((tick, index) =>
                        tick.textContent = legendFormat((index === 0 ? -1 : 1) * settings.level * scale));
                }
                showFields = show;
                // A settings change, applied with the last frame held on screen until every changed visual is rebuilt,
                // so moving a slider never shows the field vanishing and reappearing; changes arriving meanwhile are
                // gathered into one more pass.
                let running = null, queued = false;
                async function update() {
                    if (running) { queued = true; return; }
                    running = (async () => {
                        do {
                            queued = false;
                            await queueField(async () => {
                                const canvas = plugin.canvas3d;
                                canvas.pause(true);
                                try {
                                    await show(titles.length ? shownIndex() : -1);
                                } finally {
                                    canvas.commit(true);
                                    canvas.resume();
                                    canvas.requestDraw();
                                }
                            });
                        } while (queued && !disposed);
                    })();
                    try { await running; } catch (error) {
                        model.set('error', error.message); model.save_changes();
                        console.error('Molstar viewer:', error);
                    } finally { running = null; }
                }
                const mode = document.createElement('button');
                mode.type = 'button';
                mode.innerHTML = '<span class="msp-icon msp-material-icon"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.66 8L12 2.35 6.34 8C4.78 9.56 4 11.64 4 13.64s.78 4.11 2.34 5.67 3.61 2.35 5.66 2.35 4.1-.79 5.66-2.35S20 15.64 20 13.64 19.22 9.56 17.66 8zM6 14c.01-2 .62-3.27 1.76-4.4L12 5.27l4.24 4.38C17.38 10.77 17.99 12 18 14H6z"></path></svg></span>';
                const look = () => {
                    const volume = renderMode === 'volume';
                    mode.className = 'msp-btn msp-btn-icon msp-btn-link-toggle-' + (volume ? 'on' : 'off');
                    mode.title = volume ? 'Show Isosurfaces' : 'Show Volume Rendering';
                    mode.setAttribute('aria-label', mode.title);
                    mode.setAttribute('aria-pressed', String(volume));
                };
                // The settings group, built once in the markup of Molstar's own control groups and sliders.
                const group = document.createElement('div');
                group.className = 'msp-control-group-wrapper molstarview-field-group';
                group.innerHTML = '<div class="msp-control-group-header"><button class="msp-btn msp-form-control msp-btn-block"'
                    + ' type="button"><b>Field Display</b></button></div>';
                const rows = document.createElement('div');
                rows.className = 'msp-control-offset';
                group.append(rows);
                // One slider row: Molstar's rail, track and handle, dragged with the pointer, and its typed value beside.
                const row = (label, min, max, value, toLabel, fromLabel, onChange, logarithmic) => {
                    const element = document.createElement('div');
                    element.className = 'msp-control-row';
                    element.innerHTML = '<span class="msp-control-row-label"></span><div class="msp-control-row-ctrl"><div class="msp-slider">'
                        + '<div><div class="msp-slider-base"><div class="msp-slider-base-rail"></div>'
                        + '<div class="msp-slider-base-track"></div><div class="msp-slider-base-step"></div>'
                        + '<div class="msp-slider-base-handle" role="slider" tabindex="0"></div></div></div>'
                        + '<div><input type="text" class="msp-form-control"></div></div></div>';
                    const name = element.querySelector('.msp-control-row-label');
                    name.innerHTML = richHTML(label);
                    const base = element.querySelector('.msp-slider-base'), track = element.querySelector('.msp-slider-base-track');
                    const handle = element.querySelector('.msp-slider-base-handle'), text = element.querySelector('input');
                    // A logarithmic slider spreads levels evenly over their orders of magnitude.
                    const toFraction = v => logarithmic ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
                    const fromFraction = f => logarithmic ? min * Math.pow(max / min, f) : min + (max - min) * f;
                    const show = v => {
                        const percent = 100 * Math.min(1, Math.max(0, toFraction(v)));
                        handle.style.left = percent + '%';
                        Object.assign(track.style, {left:'0%', width:percent + '%'});
                        text.value = toLabel(v);
                    };
                    const pick = event => {
                        const box = base.getBoundingClientRect();
                        const v = fromFraction(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
                        show(v); onChange(v);
                    };
                    base.addEventListener('pointerdown', event => {
                        event.preventDefault(); event.stopPropagation();
                        base.setPointerCapture(event.pointerId);
                        pick(event);
                        const move = e => pick(e);
                        const up = () => { base.removeEventListener('pointermove', move); base.removeEventListener('pointerup', up); };
                        base.addEventListener('pointermove', move);
                        base.addEventListener('pointerup', up);
                    });
                    text.addEventListener('keydown', event => { if (event.key === 'Enter') text.blur(); });
                    text.addEventListener('change', () => {
                        const v = fromLabel(text.value.replace('\u2212', '-'));
                        if (Number.isFinite(v)) { const clamped = Math.min(max, Math.max(min, v)); show(clamped); onChange(clamped); }
                        else show(value);
                    });
                    show(value);
                    rows.append(element);
                };
                const unit = view.field_unit;
                row(`Level${unit ? ` $[${unit}]$` : ''}`, range[0], range[1], settings.level,
                    v => Number((v * scale).toPrecision(3)).toString(), text => Number(text) / scale,
                    v => { settings.level = v; update(); }, true);
                row('Opacity', 0.05, 1, settings.opacity, v => v.toFixed(2), Number,
                    v => { settings.opacity = v; update(); }, false);
                mode.addEventListener('click', () => { renderMode = renderMode === 'volume' ? 'isosurface' : 'volume'; look(); update(); });
                look();
                // Keep the mode button alongside the display controls when Molstar redraws its toolbar.
                // Molstar creates the settings panel on demand; do not insert field controls into its screenshot panel.
                const attach = () => {
                    const settings = container.querySelector('.msp-viewport-controls-buttons button[title="Settings / Controls Info"]');
                    if (settings && settings.nextElementSibling !== mode) settings.after(mode);
                    const settingsPanel = [...container.querySelectorAll('.msp-viewport-controls-panel')].find(panel =>
                        panel.querySelector('.msp-control-group-header')?.textContent.includes('Settings / Controls Info'));
                    const panel = settingsPanel?.querySelector('.msp-viewport-controls-panel-controls');
                    if (panel && panel.firstElementChild !== group) panel.prepend(group);
                };
                const toolbar = new MutationObserver(attach);
                toolbar.observe(container, {childList:true, subtree:true});
                attach();
                return () => { toolbar.disconnect(); showFields = null; mode.remove(); group.remove(); };
            }

            // A dropdown in Molstar's control style in place of its native selector, whose options cannot hold
            // typeset math: the closed button and every item show the snapshot titles with their LaTeX. It follows
            // the current snapshot, however it was chosen, and is placed again if Molstar redraws its controls.
            function showSnapshotMenu() {
                const select = container.querySelector('.msp-state-snapshot-viewport-controls select');
                if (!select) return;
                decorateStarts(select.parentElement);
                // Titles with LaTeX wait for the page's KaTeX.
                const typeset = [...titles, ...choiceAxes.flatMap(axis => [axis.label, ...axis.options])];
                if (!globalThis.katex && typeset.some(text => text.includes('$'))) { setTimeout(showSnapshotMenu, 200); return; }
                const current = currentSnapshot();
                if (choiceAxes.length) { showChoiceMenus(select, current); return; }
                if (!snapshotMenu) {
                    snapshotMenu = document.createElement('div');
                    snapshotMenu.className = 'molstarview-menu';
                    const button = document.createElement('button');
                    button.className = 'msp-btn molstarview-menu-button';
                    button.type = 'button';
                    const list = document.createElement('div');
                    list.className = 'molstarview-menu-list';
                    list.hidden = true;
                    const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); };
                    closeSnapshotMenu = close;
                    titles.forEach((title, index) => {
                        const item = document.createElement('button');
                        item.className = 'msp-btn molstarview-menu-item';
                        item.type = 'button';
                        item.innerHTML = richHTML(title);
                        item.addEventListener('click', event => {
                            event.stopPropagation();
                            close();
                            viewer.plugin.managers.snapshot.applyKey(String(index + 1));
                        });
                        list.append(item);
                    });
                    button.addEventListener('click', event => {
                        event.stopPropagation();
                        list.hidden = !list.hidden;
                        button.setAttribute('aria-expanded', String(!list.hidden));
                    });
                    document.addEventListener('click', close);
                    snapshotMenu.append(button, list);
                }
                if (snapshotMenu.parentElement !== select.parentElement) select.parentElement.insertBefore(snapshotMenu, select);
                const [button, list] = snapshotMenu.children;
                button.innerHTML = `<span class="molstarview-menu-count">[${current + 1}/${titles.length}]</span>`
                    + `<span class="molstarview-menu-title">${richHTML(titles[current] ?? '')}</span>`
                    + '<span class="molstarview-menu-arrow" aria-hidden="true"></span>';
                [...list.children].forEach((item, index) => item.classList.toggle('molstarview-menu-current', index === current));
            }

            // Whether a snapshot has this option on one axis and the current options on every earlier axis: earlier
            // dropdowns limit the options of later ones to combinations that exist.
            function optionAvailable(axis, option, selected) {
                return snapshotChoices.some(choice => choice[axis] === option && choice.slice(0, axis).every((value, other) => value === selected[other]));
            }

            // Molstar's snapshot buttons, named and drawn for what they do here: they play through, and step between,
            // the starts, with double chevrons and a playlist icon, apart from the single chevrons and the play of the
            // frames of one start. While Molstar cycles it shows its own stop control, which is left alone.
            function decorateStarts(controls) {
                const starts = [
                    ['Play Through Starts', 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z'],
                    ['Previous Start', 'M17.59 18L19 16.59 14.42 12 19 7.41 17.59 6l-6 6zM11 18l1.41-1.41L7.83 12l4.58-4.59L11 6l-6 6z'],
                    ['Next Start', 'M6.41 6L5 7.41 9.58 12 5 16.59 6.41 18l6-6zM13 6l-1.41 1.41L16.17 12l-4.58 4.59L13 18l6-6z'],
                ];
                [...controls.querySelectorAll(':scope > button.msp-btn-icon')].forEach((button, index) => {
                    if (!starts[index] || button.dataset.start || (index === 0 && button.title !== 'Cycle States')) return;
                    const [title, path] = starts[index];
                    button.dataset.start = '1';
                    button.title = title;
                    button.setAttribute('aria-label', title);
                    const drawing = button.querySelector('svg');
                    if (drawing) drawing.innerHTML = `<path d="${path}"></path>`;
                });
            }

            // The snapshot with a given option on one axis that keeps the earlier axes and agrees with the current
            // snapshot on the most later axes, the first of them on a tie, so later dropdowns move to the nearest
            // combination that exists.
            function snapshotWithOption(axis, option) {
                const selected = snapshotChoices[currentSnapshot()] ?? [];
                let best = -1, bestScore = -1;
                snapshotChoices.forEach((choice, index) => {
                    if (choice[axis] !== option || choice.slice(0, axis).some((value, other) => value !== selected[other])) return;
                    const score = choice.filter((value, other) => other > axis && value === selected[other]).length;
                    if (score > bestScore) { best = index; bestScore = score; }
                });
                return best;
            }

            // One dropdown per choice axis in place of the single snapshot menu, joined to the player buttons in one
            // row that wraps by whole dropdowns; each shows its axis label and the current option.
            function showChoiceMenus(select, current) {
                const selected = snapshotChoices[current] ?? [];
                if (!choiceMenus) {
                    const closeAll = () => choiceMenus.forEach(({list, button}) => { if (!list) return; list.hidden = true; button.setAttribute('aria-expanded', 'false'); });
                    choiceMenus = choiceAxes.map((axis, axisIndex) => {
                        // A long run of options, such as atom numbers, is typed into Molstar's own text field instead
                        // of picked from a list. A number is clamped to the nearest option the earlier choices allow;
                        // any other text must be such an option.
                        if (axis.input) {
                            const menu = document.createElement('div');
                            menu.className = 'molstarview-menu molstarview-menu-input';
                            menu.innerHTML = '<span class="molstarview-menu-label"></span><input type="text" class="msp-form-control" inputmode="numeric" spellcheck="false">';
                            menu.querySelector('.molstarview-menu-label').innerHTML = richHTML(axis.label);
                            const input = menu.querySelector('input');
                            input.setAttribute('aria-label', axis.label.replace(/\$/g, ''));
                            const restore = () => { input.value = axis.options[(snapshotChoices[currentSnapshot()] ?? [])[axisIndex]] ?? ''; };
                            input.addEventListener('keydown', event => {
                                event.stopPropagation();
                                if (event.key === 'Enter') input.blur();
                                if (event.key === 'Escape') { restore(); input.blur(); }
                            });
                            input.addEventListener('change', () => {
                                const selected = snapshotChoices[currentSnapshot()] ?? [];
                                const allowed = axis.options.map((text, option) => [text, option])
                                    .filter(([, option]) => optionAvailable(axisIndex, option, selected));
                                const typed = input.value.trim().replace('\u2212', '-'), number = Number(typed);
                                let option = allowed.find(([text]) => text === typed)?.[1] ?? -1;
                                const numeric = allowed.filter(([text]) => text !== '' && Number.isFinite(Number(text)));
                                if (option < 0 && typed !== '' && Number.isFinite(number) && numeric.length) {
                                    option = numeric.reduce((best, entry) =>
                                        Math.abs(Number(entry[0]) - number) < Math.abs(Number(best[0]) - number) ? entry : best)[1];
                                }
                                const index = option >= 0 ? snapshotWithOption(axisIndex, option) : -1;
                                if (index >= 0) viewer.plugin.managers.snapshot.applyKey(String(index + 1));
                                else restore();
                            });
                            return {menu, input};
                        }
                        const menu = document.createElement('div');
                        menu.className = 'molstarview-menu';
                        const button = document.createElement('button');
                        button.className = 'msp-btn molstarview-menu-button';
                        button.type = 'button';
                        const list = document.createElement('div');
                        list.className = 'molstarview-menu-list';
                        list.hidden = true;
                        const items = axis.options.map((option, optionIndex) => {
                            const item = document.createElement('button');
                            item.className = 'msp-btn molstarview-menu-item';
                            item.type = 'button';
                            item.innerHTML = richHTML(option);
                            item.addEventListener('click', event => {
                                event.stopPropagation();
                                closeAll();
                                const index = snapshotWithOption(axisIndex, optionIndex);
                                if (index >= 0) viewer.plugin.managers.snapshot.applyKey(String(index + 1));
                            });
                            list.append(item);
                            return item;
                        });
                        button.addEventListener('click', event => {
                            event.stopPropagation();
                            const open = list.hidden;
                            closeAll();
                            list.hidden = !open;
                            button.setAttribute('aria-expanded', String(open));
                        });
                        menu.append(button, list);
                        return {menu, button, list, items};
                    });
                    closeSnapshotMenu = closeAll;
                    document.addEventListener('click', closeAll);
                    // The first dropdown stands for all of them when the controls are redrawn.
                    snapshotMenu = choiceMenus[0].menu;
                }
                for (const {menu} of choiceMenus) if (menu.parentElement !== select.parentElement) select.parentElement.insertBefore(menu, select);
                choiceMenus.forEach(({menu, button, items, input}, axisIndex) => {
                    const axis = choiceAxes[axisIndex];
                    const available = axis.options.map((_, optionIndex) => optionAvailable(axisIndex, optionIndex, selected));
                    // A collapsing choice is hidden while its first option, such as "all atoms" for a whole orbital, is
                    // the only one it offers; a single real option, such as the one element of the atoms, stays shown.
                    menu.style.display = axis.collapse && available[0] && available.filter(Boolean).length === 1 ? 'none' : '';
                    if (input) {
                        if (document.activeElement !== input) input.value = axis.options[selected[axisIndex]] ?? '';
                        const allowed = axis.options.filter((_, optionIndex) => available[optionIndex]);
                        input.placeholder = allowed.length ? `${allowed[0]}–${allowed[allowed.length - 1]}` : '';
                        input.title = `${axis.label.replace(/\$/g, '')}: ${allowed.join(', ')}`;
                        input.size = Math.max(3, ...allowed.map(text => text.length + 1));
                        return;
                    }
                    button.innerHTML = `<span class="molstarview-menu-label">${richHTML(choiceAxes[axisIndex].label)}</span>`
                        + `<span class="molstarview-menu-title">${richHTML(choiceAxes[axisIndex].options[selected[axisIndex]] ?? '')}</span>`
                        + '<span class="molstarview-menu-arrow" aria-hidden="true"></span>';
                    items.forEach((item, optionIndex) => {
                        item.classList.toggle('molstarview-menu-current', optionIndex === selected[axisIndex]);
                        item.hidden = !available[optionIndex];
                    });
                });
            }

            // Play/pause and Molstar's own slider markup (as in the Structure Tools panel) inside the native
            // trajectory group, ahead of its buttons, so the changing "Model n / N" width never shifts them. All controls
            // drive the same native model index, so slider, labels and step buttons always show one frame.
            function installFrameControls() {
                const plugin = viewer.plugin, total = model.get('frame_count');
                // The frames the controls play: all of them, or the selected animated snapshot's, as [start, count].
                function range() {
                    if (!segments.length) return [0, total];
                    const index = currentSnapshot();
                    return [segmentStarts[index] ?? 0, segments[index] ?? total];
                }
                // At normal speed a whole loop takes about three seconds.
                const interval = 3000 / (segments.length ? Math.max(...segments) : total);
                // Playback speeds, cycled by their own button, starting at normal speed, with the usual slower options
                // below it and faster ones above. Frames never change faster than every 60 ms: a speed that would
                // change them faster advances several frames per step instead, keeping the rate proportional.
                const speeds = [0.25, 0.5, 1, 1.5, 2];
                let speed = 2;
                const pace = () => {
                    const period = interval / speeds[speed], stride = period < 60 ? Math.round(60 / period) : 1;
                    return [period * stride, stride];
                };
                const icons = {play:'M8 5v14l11-7z', pause:'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
                               repeat:'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
                               swap:'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
                               speed:'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z'};
                // Loop modes, cycled by their own button: forward and repeat, back and forth, backward and repeat.
                const modes = [
                    {title:'Loop Forward', path:icons.repeat, flip:false},
                    {title:'Back and Forth', path:icons.swap, flip:false},
                    {title:'Loop Backward', path:icons.repeat, flip:true},
                ];
                // Back and forth is the default.
                let mode = 1, direction = 1;
                const element = (tag, className, style = {}) => {
                    const node = document.createElement(tag);
                    if (className) node.className = className;
                    Object.assign(node.style, style);
                    return node;
                };
                const group = element('div', 'molstar-frame-controls', {display:'inline-flex', alignItems:'center', verticalAlign:'top'});
                const button = element('button', 'msp-btn msp-btn-icon molstar-play-button'), modeButton = element('button', 'msp-btn msp-btn-icon molstar-mode-button');
                // The speed is chosen from a menu, behind a gauge icon.
                const speedMenu = element('div', 'molstarview-menu molstar-speed-menu');
                const speedButton = element('button', 'msp-btn molstarview-menu-button');
                speedButton.type = 'button';
                speedButton.setAttribute('aria-haspopup', 'true');
                const speedList = element('div', 'molstarview-menu-list');
                speedList.hidden = true;
                speedMenu.append(speedButton, speedList);
                // Same structure and classes as Molstar's Slider in its no-input form: a base with rail and handle.
                const slider = element('div', 'msp-slider msp-slider-no-input', {position:'relative', width:'160px', height:'32px'});
                const track = element('div'), base = element('div', 'msp-slider-base');
                const rail = element('div', 'msp-slider-base-rail');
                const handle = element('div', 'msp-slider-base-handle msp-slider-base-handle-1 msp-slider-base-handle-lower msp-slider-base-handle-upper');
                base.append(rail, handle); track.append(base); slider.append(track, element('div'));
                // The label always takes the width of its longest value, a hidden copy sharing its grid cell, so stepping through
                // frames never moves the controls beside it.
                const label = element('span', 'molstar-frame-label', {display:'inline-grid'});
                const shownLabel = element('span', '', {gridArea:'1 / 1'}), ghost = element('span', '', {gridArea:'1 / 1', visibility:'hidden'});
                const longest = segments.length ? Math.max(...segments) : total;
                ghost.textContent = `Frame ${longest} / ${longest}`;
                label.append(shownLabel, ghost);
                const frameLabels = model.get('frame_labels') || [];
                const choices = frameLabels.length ? createFrameChoices(frameLabels, frame => {
                    const [start, count] = range();
                    if (frame > start && frame <= start + count) { stop(); request(frame - start); }
                }) : null;
                group.append(modeButton, speedMenu, button, slider);
                if (choices) group.append(choices.element);
                let playing = false, timer = 0, busy = false, wanted = null, dragging = false, waiting = false;
                const closeSpeed = () => { speedList.hidden = true; speedButton.setAttribute('aria-expanded', 'false'); };
                const speedItems = speeds.map((value, index) => {
                    const item = element('button', 'msp-btn molstarview-menu-item');
                    item.type = 'button';
                    item.textContent = String(value);
                    item.addEventListener('click', event => {
                        event.stopPropagation();
                        closeSpeed();
                        // A new speed applies at once: a pending step is rescheduled at the new pace.
                        speed = index;
                        icon();
                        if (waiting) { clearTimeout(timer); schedule(); }
                    });
                    speedList.append(item);
                    return item;
                });
                speedButton.addEventListener('click', event => {
                    event.stopPropagation();
                    const open = speedList.hidden;
                    closeSpeed();
                    speedList.hidden = !open;
                    speedButton.setAttribute('aria-expanded', String(open));
                });
                document.addEventListener('click', closeSpeed);
                const current = () => plugin.state.data.cells.get(modelRef).transform.params.modelIndex;
                const svg = (path, flip = false) => '<span class="msp-icon msp-material-icon"><svg width="24px" height="24px" viewBox="0 0 24 24"'
                    + (flip ? ' style="transform:scaleX(-1)"' : '') + `><path d="${path}"></path></svg></span>`;
                function icon() {
                    button.title = playing ? 'Pause' : 'Play Frames';
                    button.innerHTML = svg(playing ? icons.pause : icons.play);
                    modeButton.title = modes[mode].title;
                    modeButton.innerHTML = svg(modes[mode].path, modes[mode].flip);
                    speedButton.innerHTML = svg(icons.speed) + '<span class="molstarview-menu-arrow" aria-hidden="true"></span>';
                    speedButton.title = 'Playback Speed';
                    speedItems.forEach((item, index) => item.classList.toggle('molstarview-menu-current', index === speed));
                }
                // Frames are one-based, as in Molstar's "Model n / N" label.
                function draw(frame) {
                    const [start, count] = range();
                    // The model index can lie outside the range while a snapshot switch settles.
                    const shown = Math.min(count, Math.max(1, frame));
                    choices?.setRange(start, count);
                    handle.style.left = (count > 1 ? (shown - 1) / (count - 1) * 100 : 0) + '%';
                    handle.title = String(shown);
                    shownLabel.textContent = `Frame ${shown} / ${count}`;
                }
                // Commits are serialized; while one runs, only the latest requested frame is kept.
                async function show(index) {
                    wanted = index;
                    if (busy) return;
                    busy = true;
                    try {
                        while (wanted !== null && !disposed) {
                            const next = wanted;
                            wanted = null;
                            if (next !== current()) await plugin.state.data.build().to(modelRef).update({modelIndex:next}).commit();
                        }
                    } finally { busy = false; }
                }
                const stop = () => { playing = false; waiting = false; clearTimeout(timer); icon(); };
                // Frames are counted within the played range.
                const request = frame => {
                    const [start, count] = range();
                    const clamped = Math.min(count, Math.max(1, Math.round(frame)));
                    draw(clamped);
                    show(start + clamped - 1);
                };
                // Frame after the given one within the range for the current loop mode; back and forth reverses at either end.
                function advance(index, count) {
                    if (mode === 0) return (index + 1) % count;
                    if (mode === 2) return (index - 1 + count) % count;
                    if (index + direction < 0 || index + direction >= count) direction = -direction;
                    return index + direction;
                }
                // The frame a step reaches, advancing by the current speed's stride.
                function next() {
                    const [start, count] = range();
                    // A frame outside the range, after switching snapshots, restarts at its first frame.
                    let index = Math.min(count - 1, Math.max(0, current() - start));
                    for (let k = 0; k < pace()[1]; k++) index = advance(index, count);
                    return start + index;
                }
                const schedule = () => { waiting = true; timer = setTimeout(step, pace()[0]); };
                function step() {
                    waiting = false;
                    if (!playing || disposed) return;
                    show(next()).then(() => { if (playing) schedule(); });
                }
                modeButton.addEventListener('click', () => {
                    mode = (mode + 1) % modes.length;
                    direction = mode === 2 ? -1 : 1;
                    icon();
                });
                button.addEventListener('click', () => {
                    playing = !playing;
                    waiting = false;
                    clearTimeout(timer);
                    icon();
                    if (playing) step();
                });
                // Molstar's step buttons walk the whole trajectory; with animated snapshots they stay within the selected one.
                const stepWithinSnapshot = event => {
                    const control = event.target.closest?.('.msp-traj-controls > button');
                    const target = control && stepFrame(control.title, current() - range()[0] + 1);
                    if (!target && target !== 0) return;
                    event.stopPropagation();
                    stop();
                    request(target);
                };
                if (segments.length) container.addEventListener('click', stepWithinSnapshot, true);
                // Pointer dragging on the base, as in Molstar's SliderBase.
                const frameAt = clientX => {
                    const box = base.getBoundingClientRect();
                    return 1 + Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * (range()[1] - 1);
                };
                base.addEventListener('pointerdown', event => {
                    event.preventDefault();
                    stop(); dragging = true;
                    base.setPointerCapture(event.pointerId);
                    request(frameAt(event.clientX));
                });
                base.addEventListener('pointermove', event => { if (dragging) request(frameAt(event.clientX)); });
                base.addEventListener('pointerup', () => { dragging = false; });
                base.addEventListener('wheel', event => {
                    event.preventDefault(); event.stopPropagation();
                    stop();
                    const [start, count] = range();
                    request(current() - start + 1 + (event.deltaY > 0 ? -1 : 1) * Math.max(1, Math.round(count / (event.shiftKey ? 100 : 25))));
                }, {passive:false});
                // Follow every change of the native model index, whichever control made it.
                const subscription = plugin.state.data.events.cell.stateUpdated.subscribe(({ref}) => {
                    if (ref !== modelRef) return;
                    const index = current();
                    if (!dragging) draw(index - range()[0] + 1);
                    shownFrame = index;
                    container.dataset.frame = String(index + 1);
                    placeLabels();
                });
                // Fold the trajectory block onto two rows only when one row would not fit on a line of its own.
                function fit() {
                    const native = container.querySelector('.msp-traj-controls');
                    if (!native) return;
                    const outer = node => {
                        const style = getComputedStyle(node);
                        return node.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
                    };
                    let needed = 0;
                    // The group's own controls take part in the block's layout, ordered with Molstar's step buttons.
                    for (const child of native.children) for (const part of child === group ? group.children : [child]) needed += outer(part);
                    const row = native.parentElement, layout = getComputedStyle(row.parentElement);
                    let available = row.parentElement.clientWidth - parseFloat(layout.paddingLeft) - parseFloat(layout.paddingRight)
                        - parseFloat(getComputedStyle(native).marginRight);
                    container.dataset.fold = needed > available ? '1' : '0';
                }
                // Molstar re-renders its toolbar; keep the group first inside the native trajectory block and the label
                // last, where Molstar puts its own.
                const attach = () => {
                    const native = container.querySelector('.msp-traj-controls');
                    if (!native) return;
                    let moved = false;
                    if (native.firstElementChild !== group) { native.prepend(group); moved = true; }
                    if (native.lastElementChild !== label) { native.append(label); moved = true; }
                    // Molstar's step buttons are named for what they step through here: the frames of one start.
                    const named = {'First Model':'First Frame', 'Previous Model':'Previous Frame', 'Next Model':'Next Frame'};
                    for (const control of native.querySelectorAll(':scope > button')) if (named[control.title]) control.title = named[control.title];
                    if (moved) fit();
                };
                const toolbar = new MutationObserver(attach);
                toolbar.observe(container, {childList:true, subtree:true});
                const resize = new ResizeObserver(fit);
                resize.observe(container);
                icon();
                draw(current() - range()[0] + 1);
                attach();
                return () => { stop(); container.removeEventListener('click', stepWithinSnapshot, true); toolbar.disconnect(); resize.disconnect(); subscription.unsubscribe(); choices?.dispose(); document.removeEventListener('click', closeSpeed); group.remove(); label.remove(); };
            }
            // Reveal only after Molstar has painted the completed scene at its final size.
            const canvas = viewer.plugin.canvas3d;
            canvas.commit(true);
            await new Promise((resolve, reject) => {
                const previous = canvas.didDraw.value;
                const notify = canvas.notifyDidDraw;
                let subscription;
                const finish = error => {
                    subscription?.unsubscribe();
                    canvas.notifyDidDraw = notify;
                    if (error) reject(error); else resolve();
                };
                canvas.notifyDidDraw = true;
                subscription = canvas.didDraw.subscribe(time => {
                    if (time !== previous) finish();
                });
                try { canvas.requestDraw(); } catch (error) { finish(error); }
            }).catch(error => {
                container.dataset.surface = 'error';
                viewer.plugin.dispose();
                throw error;
            });
            container.dataset.ready = '1';
            // Molstar keeps ticking after a viewer leaves the viewport. With a shared GPU canvas, those idle ticks
            // can repeatedly resize the drawing buffer as differently sized viewers take turns, blocking scrolling.
            // Keep state transactions working off screen, but suspend drawing ticks until the view is visible again.
            const visibility = new IntersectionObserver(entries => {
                const visible = entries.some(entry => entry.isIntersecting);
                const context = viewer.plugin.canvas3dContext;
                if (context.visible === visible) return;
                context.visible = visible;
                if (visible) canvas.requestDraw();
            });
            visibility.observe(container);
            // The current view as an image, read from the viewer's own canvas.
            const still = () => viewer.plugin.canvas3dContext.canvas.toDataURL('image/png');
            const dispose = () => {
                disposed = true;
                snapshotCount.unsubscribe();
                disposeFrames();
                disposeTrail();
                disposeField();
                disposeClipping();
                snapshotObserver?.disconnect();
                if (closeSnapshotMenu) document.removeEventListener('click', closeSnapshotMenu);
                disposeWheel();
                disposeAlignment();
                viewSwitch?.dispose();
                compositionSwitch?.dispose();
                surfaceSwitch?.dispose();
                disposeLabels();
                disposeResolution();
                cameraObserver?.disconnect();
                visibility.disconnect();
                model.off('change:requested', requested);
                viewer.plugin.dispose();
            };
            return {dispose, still};
        }

// Every viewer is built as soon as the page loads. Printing cannot draw WebGL, so just before the page prints,
// each viewer leaves a still of its current view, which print styles show in its place.
function initialize({model, el}) {
    el.style.minHeight = model.get('height') + 'px';
    if (!document.getElementById('molstar-print-styles')) {
        const styles = document.createElement('style');
        styles.id = 'molstar-print-styles';
        styles.textContent = '.molstar-print-still{display:none;width:100%}'
            + '@media print{.molstar-notebook-viewer{display:none!important}.molstar-print-still{display:block!important}}';
        document.head.append(styles);
    }
    const image = document.createElement('img');
    image.className = 'molstar-print-still';
    image.alt = 'Molecular viewer';
    el.append(image);
    let viewer = null, disposed = false;
    const print = () => { if (viewer) image.src = viewer.still(); };
    addEventListener('beforeprint', print);
    // The scene, its trajectory upload and Molstar's own render targets are built only once the viewer approaches the
    // viewport, so a page holding many viewers, some of hundreds of frames, does not build them all at load; the
    // height reserved above keeps the layout still until then. A viewer in a closed tab pane mounts when it is shown.
    let started = false;
    const start = () => {
        if (started || disposed) return Promise.resolve();
        started = true;
        observer.disconnect();
        return mount({model, el}).then(result => {
            if (disposed) result.dispose(); else viewer = result;
        }, error => {
            model.set('error', error.message);
            model.save_changes();
            console.error('Molstar viewer:', error);
        });
    };
    const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) void start();
    }, {rootMargin: '200px'});
    observer.observe(el);
    // Shader linking can block on the first draw when parallel shader compilation is unavailable. Warm one nearby,
    // visible-tab viewer during idle time; it populates the shared program cache before the user scrolls to it.
    // The lock prevents a page with many viewers from mounting them all at once.
    const warm = () => {
        if (started || disposed || document.visibilityState !== 'visible' || globalThis.molstarSharedContext ||
            globalThis.molstarWarmMount || getComputedStyle(el).visibility === 'hidden' || !el.getClientRects().length ||
            el.getBoundingClientRect().top > 4 * innerHeight) return;
        globalThis.molstarWarmMount = true;
        void start().finally(() => { globalThis.molstarWarmMount = false; });
    };
    const idle = window.requestIdleCallback ? requestIdleCallback(warm, {timeout:2000}) : setTimeout(warm, 1500);
    return () => {
        disposed = true;
        if (window.cancelIdleCallback) cancelIdleCallback(idle); else clearTimeout(idle);
        observer.disconnect();
        removeEventListener('beforeprint', print);
        viewer?.dispose();
        el.replaceChildren();
    };
}

// One Molstar download and evaluation is shared by every viewer on the page. Started at the browser's first idle
// moment, it is ready long before a viewer scrolls into view or a tab is opened, so that interaction never waits for it.
const warmMolstar = () => loadMolstar().catch(() => {});
if (window.requestIdleCallback) requestIdleCallback(warmMolstar, {timeout:3000});
else setTimeout(warmMolstar, 1500);

export default {render: initialize};
