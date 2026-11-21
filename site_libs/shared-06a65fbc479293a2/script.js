
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
// A native title tooltip shows late and unstyled, so every title on the page becomes the same themed popover as the
// page's other hover texts, the element keeping the text as its accessible name; a menu button, named already, drops
// it, and Mol* viewers and charts keep their own. Hovering a list of job icons opens a table of what each icon means.
if (typeof globalThis.tippy === "function") {
  const hoverTexts = () => {
    for (const element of document.querySelectorAll("[title]")) {
      if (element._tippy || element.closest("svg, .tippy-box, .msp-plugin, .molstar-notebook-viewer, .vega-embed")) continue;
      const text = element.getAttribute("title").trim();
      element.removeAttribute("title");
      if (!element.hasAttribute("aria-label")) element.setAttribute("aria-label", text);
      if (!text || element.matches("[data-bs-toggle=dropdown]")) continue;
      globalThis.tippy(element, {content: text, delay: 100, arrow: false, theme: "quarto", placement: "bottom", appendTo: () => document.body});
    }
    for (const icons of document.querySelectorAll(".job-icons")) {
      const detail = icons.dataset.detail;
      if (!detail || icons._tippy) continue;
      globalThis.tippy(icons, {
        content: () => {
          const box = document.createElement("div");
          box.className = "diagram-popover job-popover";
          box.innerHTML = detail;
          return box;
        },
        allowHTML: true, maxWidth: "none", delay: 100, arrow: false, theme: "quarto", placement: "bottom-start",
        appendTo: () => document.body,
      });
    }
  };
  // The script comes after the page's body, so its elements are there already.
  if (document.body) hoverTexts();
  else document.addEventListener("DOMContentLoaded", hoverTexts);
}
