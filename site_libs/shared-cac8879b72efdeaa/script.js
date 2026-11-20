
// Hovering a cross-reference to a figure opens Quarto's popover with a copy of the figure. A copied Mol* viewer is an
// empty canvas, so each one shows a still of the page's own viewer instead, taken from the canvas it draws on; a viewer
// the page has not drawn yet keeps its copy.
if (globalThis.tippy) {
  globalThis.tippy.setDefaultProps({
    onShow(instance) {
      if (!instance.reference.matches("a.quarto-xref")) return;
      const id = decodeURIComponent((instance.reference.getAttribute("href") || "").split("#")[1] || "");
      const source = id ? document.getElementById(id) : null;
      const originals = source ? [...source.querySelectorAll(".molstar-notebook-viewer")] : [];
      [...instance.popper.querySelectorAll(".molstar-notebook-viewer")].forEach((copy, index) => {
        const canvases = originals[index] ? [...originals[index].querySelectorAll("canvas")] : [];
        const canvas = canvases.filter((each) => each.width > 0 && each.height > 0).at(-1);
        let still = null;
        try { still = canvas ? canvas.toDataURL("image/png") : null; } catch (error) { still = null; }
        if (!still) return;
        const image = document.createElement("img");
        image.src = still;
        image.alt = "";
        image.className = "molstar-popover-still";
        copy.replaceChildren(image);
        copy.style.height = "auto";
        copy.dataset.ready = "1";
      });
    },
  });
}
