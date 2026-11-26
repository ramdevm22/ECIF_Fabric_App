/**
 * Scrolls to the top of the app. Fabric shows the app inside its own scroll area, so this
 * scrolls the element into view (which moves every scrollable parent) and also resets the page.
 * It runs again a few times, because the screen is still rendering and loading data.
 */
export function scrollToTop(from?: HTMLElement | null) {
  const run = () => {
    from?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
    let el: HTMLElement | null | undefined = from;
    while (el) {
      if (el.scrollTop > 0) el.scrollTop = 0;
      el = el.parentElement;
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  run();
  requestAnimationFrame(run);
  window.setTimeout(run, 150);
  window.setTimeout(run, 600);
}