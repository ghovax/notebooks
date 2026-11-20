(() => {
  const KEY = "quarto-color-scheme", media = matchMedia("(prefers-color-scheme: dark)");
  const stored = () => { try { return localStorage.getItem(KEY); } catch (error) { return null; } };
  const choice = () => ({alternate: "dark", default: "light"})[stored()] || "auto";
  const dark = () => document.body.classList.contains("quarto-dark");
  const show = () => {
    for (const item of document.querySelectorAll(".theme-menu [data-theme]")) {
      const on = item.dataset.theme === choice();
      item.classList.toggle("active", on);
      if (on) item.setAttribute("aria-current", "true"); else item.removeAttribute("aria-current");
      if (!on) continue;
      for (const name of document.querySelectorAll(".theme-menu .theme-current")) name.textContent = item.textContent;
      for (const icon of document.querySelectorAll(".theme-menu .theme-icon")) {
        icon.className = item.querySelector(".bi").className + " theme-icon";
      }
    }
  };
  const choose = (theme) => {
    const wanted = theme === "dark" || (theme === "auto" && media.matches);
    if (dark() !== wanted && window.quartoToggleColorScheme) window.quartoToggleColorScheme();
    try {
      if (theme === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme === "dark" ? "alternate" : "default");
    } catch (error) {}
    show();
  };
  document.addEventListener("click", (event) => {
    const item = event.target.closest(".theme-menu [data-theme]");
    if (!item) return;
    event.preventDefault();
    choose(item.dataset.theme);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
})();