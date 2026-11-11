
  // The strokes animate on the main thread; started while the viewers and charts initialise
  // (multi-second tasks), they stutter. Start them at the browser's first idle moment instead,
  // with no added delay; the drawing itself is unchanged.
  const whenIdle = (callback) => (window.requestIdleCallback ? requestIdleCallback(callback) : setTimeout(callback, 0));
  window.addEventListener("load", () => {
    // Wait for KaTeX and web fonts so stroke geometry matches the final line layout.
    document.fonts.ready.then(() => whenIdle(() => {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.annotation.show();
          observer.unobserve(entry.target);
        }
      }, { threshold: 0.5 });
      for (const mark of document.querySelectorAll("span.hl, span.hl-fail")) {
        // A highlighted display equation is marked on the formula, not its full-width block.
        const target = mark.querySelector(".katex-display > .katex") || mark;
        // Anchor the stroke to the enclosing block, so widgets that load above it do not offset it.
        if (getComputedStyle(target.parentElement).position === "static") {
          target.parentElement.style.position = "relative";
        }
        mark.annotation = RoughNotation.annotate(target, {
          type: "highlight",
          color: mark.classList.contains("hl-fail") ? "rgba(255, 92, 92, 0.4)" : "rgba(255, 221, 64, 0.5)",
          multiline: true,
          iterations: 1,
          animationDuration: 700,
        });
        observer.observe(mark);
      }
    }));
  });
