
  // Wrap each fold's heading and the content after it in <details>, inside the heading's
  // section, which keeps the id the TOC links to. Runs before widgets render, and again on
  // sections the viewer page adds.
  function wrapFolds(root) {
    for (const fold of root.querySelectorAll("section.fold, div.fold")) {
      const heading = fold.querySelector(":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6");
      if (!heading) continue;
      const details = document.createElement("details"), summary = document.createElement("summary");
      details.className = "fold";
      heading.parentElement.insertBefore(details, heading);
      summary.append(heading);
      details.append(summary);
      while (details.nextSibling) details.append(details.nextSibling);
    }
  }
  window.wrapFolds = wrapFolds;
  wrapFolds(document);
  // Open the fold that holds a linked target, from the TOC, a cross-reference or the URL.
  function openFoldFor(hash) {
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    const details = target && (target.closest("details.fold") || target.querySelector(":scope > details.fold"));
    if (details && !details.open) { details.open = true; target.scrollIntoView(); }
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (link) openFoldFor(link.getAttribute("href"));
  });
  window.addEventListener("hashchange", () => openFoldFor(location.hash));
  openFoldFor(location.hash);
  // Vega and Molstar size to their container, which has zero width while folded.
  document.addEventListener("toggle", (event) => {
    if (event.target.matches("details.fold") && event.target.open) window.dispatchEvent(new Event("resize"));
  }, true);
