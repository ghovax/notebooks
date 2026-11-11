
  function stepTabs(root) {
    for (const first of root.querySelectorAll("section.step")) {
      if (first.previousElementSibling?.matches("section.step") || first.parentElement.matches(".viewer-steps > .tab-content > .tab-pane")) continue;
      const steps = [first];
      while (steps.at(-1).nextElementSibling?.matches("section.step")) steps.push(steps.at(-1).nextElementSibling);
      const tabset = document.createElement("div");
      tabset.className = "panel-tabset viewer-steps";
      const list = document.createElement("ul"), content = document.createElement("div");
      list.className = "nav nav-tabs";
      list.setAttribute("role", "tablist");
      content.className = "tab-content";
      first.before(tabset);
      tabset.append(list, content);
      steps.forEach((section, index) => {
        const heading = section.querySelector(":scope > .anchored");
        const label = heading.cloneNode(true);
        label.querySelectorAll(".anchorjs-link").forEach((link) => link.remove());
        const pane = document.createElement("div");
        pane.id = `${section.id}-tab`;
        pane.className = `tab-pane${index ? "" : " active"}`;
        pane.setAttribute("role", "tabpanel");
        list.insertAdjacentHTML("beforeend", `<li class="nav-item" role="presentation"><a class="nav-link${index ? "" : " active"}" data-bs-toggle="tab" data-bs-target="#${pane.id}" role="tab" aria-controls="${pane.id}" aria-selected="${!index}" href="">${label.innerHTML}</a></li>`);
        heading.remove();
        pane.append(section);
        content.append(pane);
      });
    }
  }
  window.stepTabs = stepTabs;
  stepTabs(document);
  // A link to a section inside a step, from the steps table, the TOC or the URL, opens the step's tab first. The viewer
  // page resolves its own links, among several calculations, itself.
  function openStepFor(hash) {
    const target = hash?.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    for (let pane = target?.closest(".viewer-steps > .tab-content > .tab-pane"); pane; pane = pane.parentElement.closest(".viewer-steps > .tab-content > .tab-pane")) {
      const link = document.querySelector(`[data-bs-target="#${CSS.escape(pane.id)}"]`);
      if (link && !pane.classList.contains("active")) window.bootstrap?.Tab.getOrCreateInstance(link).show();
    }
    if (target) requestAnimationFrame(() => {
      stepSpy?.refresh();
      target.scrollIntoView();
      markStepToc(target);
    });
  }
  const staticStepPage = !document.getElementById("viewer-calculations") && !location.pathname.includes("/viewer/");
  const stepToc = staticStepPage && document.querySelector(".panel-tabset .tab-pane") && document.getElementById("TOC");
  let stepSpy;
  if (stepToc) {
    // Quarto snapshots hidden tab sections at startup, whose zero offsetTop defeats its active-section search.
    // Bootstrap's native observer filters invisible panes and can refresh when a different tab is shown.
    stepToc.querySelectorAll("a[data-scroll-target]").forEach((link) => link.removeAttribute("data-scroll-target"));
    const depth = Number(stepToc.dataset.tocExpanded || 1);
    for (const list of stepToc.querySelectorAll("ul.collapse")) {
      let level = 0;
      for (let parent = list; parent && parent !== stepToc; parent = parent.parentElement) {
        if (parent.tagName === "UL") level++;
      }
      if (level <= depth) list.classList.remove("collapse");
    }
    const initialize = () => {
      stepSpy = window.bootstrap.ScrollSpy.getOrCreateInstance(document.body, {
        target: stepToc, rootMargin: "0px 0px -60%", threshold: [0.1, 0.5, 1],
      });
      document.body.addEventListener("activate.bs.scrollspy", (event) => {
        for (const link of stepToc.querySelectorAll('a[href^="#"]')) {
          if (link === event.relatedTarget) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        }
        window.dispatchEvent(new CustomEvent("quarto-sectionChanged"));
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
  }
  function markStepToc(target) {
    if (!stepToc || target.closest(".tab-pane:not(.active)")) return;
    const links = [...stepToc.querySelectorAll('a[href^="#"]')];
    const current = links.find((link) => decodeURIComponent(link.hash.slice(1)) === target.id);
    if (!current) return;
    for (const link of links) {
      link.classList.toggle("active", link === current);
      if (link === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    const heading = target.matches(".anchored") ? target : target.querySelector(".anchored");
    if (heading) {
      heading.classList.add("reveal-anchorjs-link");
      heading.addEventListener("mouseout", () => heading.classList.remove("reveal-anchorjs-link"), { once: true });
    }
    window.dispatchEvent(new CustomEvent("quarto-sectionChanged"));
    window.dispatchEvent(new Event("resize"));
  }
  if (staticStepPage) {
    document.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]:not([data-bs-toggle])');
      if (link) openStepFor(link.getAttribute("href"));
    });
    window.addEventListener("hashchange", () => openStepFor(location.hash));
    openStepFor(location.hash);
  }
  // Charts and molecule viewers in a step take their width when its tab is shown.
  document.addEventListener("shown.bs.tab", (event) => {
    stepSpy?.refresh();
    const selector = event.target.getAttribute("data-bs-target");
    const pane = selector && document.querySelector(selector);
    const target = pane?.querySelector("section[id]");
    if (target) markStepToc(target);
    window.dispatchEvent(new Event("resize"));
  });
