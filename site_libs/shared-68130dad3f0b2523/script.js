
// Hovering a link to a project, workflow or calculation page whose hidden details the page carries shows, in Quarto's
// own hover popover, its status box and a table of what it contains, as the calculation labels do in the workflow
// diagrams: in a table and equally in running text, wherever the link points from. Links match by the page they
// resolve to, so a detail needs only the address of its page. Hovering a worked day of a work calendar shows, in the
// same popover, what was worked on that day. The details are copied when the popover opens, after KaTeX has typeset
// the page.
if (globalThis.tippy) {
  const page = address => {
    const url = new URL(address, document.baseURI);
    return url.origin + url.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
  };
  const attach = (target, detail, placement) => tippy(target, {
    content: "",
    onShow(instance) {
      const box = document.createElement("div");
      box.className = "diagram-popover";
      box.append(...detail.cloneNode(true).childNodes);
      instance.setContent(box);
    },
    allowHTML: true, maxWidth: "none", delay: 100, arrow: false, interactive: true, interactiveBorder: 10,
    theme: "quarto", placement, appendTo: () => document.body,
  });
  const details = new Map([...document.querySelectorAll(".link-detail[data-href]")].map(detail => [page(detail.dataset.href), detail]));
  for (const anchor of document.querySelectorAll("a[href]")) {
    const detail = details.get(page(anchor.href));
    if (!detail || anchor._tippy || anchor.closest(".link-details, .calendar-details, .tippy-box")) continue;
    attach(anchor, detail, "bottom-start");
  }
  const days = new Map([...document.querySelectorAll(".calendar-day[data-day]")].map(detail => [detail.dataset.day, detail]));
  for (const cell of document.querySelectorAll(".work-calendar [data-day]")) {
    const detail = days.get(cell.dataset.day);
    if (detail && !cell._tippy) attach(cell, detail, "bottom");
  }
}
