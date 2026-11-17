// Python for the calculation viewer, in a worker so reading files never blocks the page.
//
// The page sends the files dropped on it; they are written to Pyodide's in-memory file system and read there by
// calcpages.browser, with the same runflow parsers and page sections as the calculation pages. Nothing is uploaded:
// the network is used only to load Pyodide, its packages, RDKit's and PySCF's wheels and python.zip, the viewer's own
// Python.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

// Pyodide's builds of the packages it provides, compiled to bytecode, loaded while Pyodide itself starts; this
// repository's libraries and the pure Python packages Pyodide does not provide come precompiled in python.zip, under
// site-packages, as their wheels install them.
const BUILT = ["numpy", "pandas", "pyyaml", "tzdata", "ipython", "pydantic", "jsonschema", "jinja2", "narwhals",
  "packaging", "platformdirs", "typing-extensions", "networkx"];
// Pyodide does not build RDKit or PySCF: researchsite.pyodide_wheels builds their wheels, which sit beside the page.
const WHEELS = {
  rdkit: new URL("rdkit-2026.9.1-cp314-cp314-pyemscripten_2026_0_wasm32.whl", import.meta.url).href,
  pyscf: new URL("pyscf-2.15.0-py3-none-pyemscripten_2026_0_wasm32.whl", import.meta.url).href,
};
// Packages loaded when a dropped file first needs them, each entry's stages in turn: RDKit, which draws every
// structure, with the first file; PySCF, which evaluates a formatted checkpoint's orbitals and densities, with the
// first checkpoint, after SciPy, h5py and OpenBLAS, since its libraries link OpenBLAS.
const ON_DEMAND = [
  [/./, [[WHEELS.rdkit]]],
  [/\.fchk?$/i, [["scipy", "h5py", "libopenblas"], [WHEELS.pyscf]]],
];
const ROOT = "/home/pyodide/viewer";
// The language the page asks its sections in, from the worker's address; English when it names none.
const LANGUAGE = /^[a-z]{2}$/.test(new URL(import.meta.url).searchParams.get("language") || "")
  ? new URL(import.meta.url).searchParams.get("language") : "en";
const DROP = "/home/pyodide/drop";

async function start() {
  const archive = fetch(new URL("python.zip", import.meta.url), { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`python.zip: HTTP ${response.status}`);
    return response.arrayBuffer();
  });
  const pyodide = await loadPyodide({ packages: BUILT });
  pyodide.unpackArchive(await archive, "zip", { extractDir: ROOT });
  pyodide.FS.mkdirTree(DROP);
  // IPython's package module starts its terminal shell, which takes a second here and which nothing here uses; it
  // is replaced by a bare module over the same folder, so its display and core modules import as they are.
  pyodide.runPython(`
import importlib.util, sys, types
sys.path.insert(0, "${ROOT}/site-packages")
spec = importlib.util.find_spec("IPython")
package = types.ModuleType("IPython")
package.__spec__, package.__path__, package.__file__ = spec, spec.submodule_search_locations, spec.origin
package.get_ipython = lambda: None
sys.modules["IPython"] = package
import os
# The pages built here link their icons as icons/, as a page's kernel runs in the page's folder.
os.chdir("${ROOT}")
os.environ["CALCPAGES_ICONS"] = "${ROOT}/icons"
os.environ["CALCPAGES_LANGUAGE"] = "${LANGUAGE}"
import calcpages.browser as viewer
from calcpages.i18n import use_zone
`);
  pyodide.globals.get("use_zone")(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return pyodide;
}

const ready = start();
let queue = Promise.resolve();

// Messages are handled one at a time: files added or removed, then the page re-read.
onmessage = (event) => {
  queue = queue.then(() => handle(event.data)).catch((error) => {
    postMessage({ type: "error", text: String(error && error.message || error) });
  });
};

async function handle(message) {
  const pyodide = await ready;
  const FS = pyodide.FS;
  // A share is packed from, or unpacked into, the files as the page lists them; the page then stores or adds them.
  if (message.type === "pack") {
    const data = pyodide.globals.get("viewer").pack(DROP, pyodide.toPy(message.entries)).toJs();
    postMessage({ type: "packed", data }, [data.buffer]);
    return;
  }
  if (message.type === "unpack") {
    const files = pyodide.globals.get("viewer").unpack(pyodide.toPy(new Uint8Array(message.data))).toJs()
      .map(([path, time, content]) => ({ path, time, content }));
    postMessage({ type: "unpacked", files }, files.map((file) => file.content.buffer));
    return;
  }
  if (message.type === "add") {
    for (const file of message.files) {
      const path = `${DROP}/${file.path}`;
      FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      FS.writeFile(path, new Uint8Array(file.buffer));
    }
  } else if (message.type === "remove") {
    for (const path of message.paths) {
      try { FS.unlink(`${DROP}/${path}`); } catch { /* already gone */ }
    }
  }
  for (const [pattern, stages] of ON_DEMAND) {
    if (!message.paths_now.some((path) => pattern.test(path))) continue;
    for (const names of stages) await pyodide.loadPackage(names);
  }
  const update = pyodide.globals.get("viewer").update;
  const result = update(DROP, pyodide.toPy(message.paths_now)).toJs({ dict_converter: Object.fromEntries });
  postMessage({ type: "result", ...result });
}

ready.then(() => postMessage({ type: "ready" }), (error) => {
  postMessage({ type: "error", start: true, text: String(error && error.message || error) });
});
