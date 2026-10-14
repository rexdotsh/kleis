const prefersMotion = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: no-preference)").matches ??
  false;
const detailResizes = new WeakMap();

// Re-renders replace the list's HTML, so rows are moved from where they were
// to where they now are (FLIP); rows that are new simply appear.
const flipAnimations = new WeakMap();

// `anchor` names a row (its data-flip key) that should stay put on screen;
// the page scrolls to absorb height changes above it.
function renderWithMotion(container, update, { anchor = null } = {}) {
  const anchorTop = anchor
    ? container
        .querySelector?.(`[data-flip="${anchor}"]`)
        ?.getBoundingClientRect().top
    : undefined;
  const before = new Map();
  const details = new Map();
  const animate = prefersMotion() && container.querySelectorAll;
  if (animate) {
    for (const element of container.querySelectorAll("[data-flip]")) {
      before.set(element.dataset.flip, element.getBoundingClientRect().top);
    }
    for (const detail of container.querySelectorAll(
      ".detail:not(.inline-form)"
    )) {
      details.set(detail.dataset.detailFor, {
        height: detail.getBoundingClientRect().height,
        children: new Map(
          Array.from(
            detail.querySelectorAll(DETAIL_MOTION_SELECTOR),
            (element) => [
              detailMotionKey(element),
              element.getBoundingClientRect().top,
            ]
          )
        ),
      });
    }
  }
  // Snapshot the currently displayed geometry before interrupting a resize.
  for (const detail of container.querySelectorAll?.(".detail") || []) {
    detailResizes.get(detail)?.();
  }
  update();
  if (anchorTop !== undefined) {
    const top = container
      .querySelector(`[data-flip="${anchor}"]`)
      ?.getBoundingClientRect().top;
    if (top !== undefined && Math.abs(top - anchorTop) >= 1) {
      window.scrollBy({ top: top - anchorTop, behavior: "instant" });
    }
  }
  if (!(animate && before.size)) return;
  // Positions were read mid-slide; stop those slides so the new layout is
  // measured where it really is, and the next slide starts from where the
  // element was shown.
  for (const element of container.querySelectorAll("[data-flip]")) {
    flipAnimations.get(element)?.cancel();
  }
  let resizing = false;
  for (const detail of container.querySelectorAll(
    ".detail:not(.inline-form)"
  )) {
    const previous = details.get(detail.dataset.detailFor);
    if (previous) resizing = animateDetailResize(detail, previous) || resizing;
  }
  let lead = null;
  let leadDistance = 0;
  const offsets = new Map();
  for (const element of container.querySelectorAll("[data-flip]")) {
    const top = before.get(element.dataset.flip);
    // A newly opened detail travels with the row it belongs to.
    const offset =
      top === undefined
        ? (offsets.get(element.previousElementSibling) ?? 0)
        : top - element.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    offsets.set(element, offset);
    // Moving rows are opaque so they slide over the rows they pass.
    element.classList.add("flipping");
    const slide = element.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
      {
        duration: resizing ? 200 : 260,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      }
    );
    flipAnimations.set(element, slide);
    const done = () => {
      if (flipAnimations.get(element) !== slide) return;
      flipAnimations.delete(element);
      element.classList.remove("flipping", "flipping-lead");
    };
    slide.finished.then(done, done);
    if (Math.abs(offset) > leadDistance) {
      lead = element;
      leadDistance = Math.abs(offset);
    }
  }
  lead?.classList.add("flipping-lead");
}

const DETAIL_MOTION_SELECTOR =
  ".facts > .fact, .daily-tokens, .usage-grid, .actions";

function detailMotionKey(element) {
  if (element.classList.contains("fact"))
    return `fact:${element.querySelector(".fact-label").textContent}`;
  if (element.classList.contains("actions")) return "actions";
  return element.classList.contains("daily-tokens") ? "daily" : "usage";
}

function animateDetailResize(detail, previous) {
  const height = detail.getBoundingClientRect().height;
  if (Math.abs(height - previous.height) < 1) return;
  const timing = { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  const animations = [];
  for (const element of detail.querySelectorAll(DETAIL_MOTION_SELECTOR)) {
    const top = previous.children.get(detailMotionKey(element));
    if (top === undefined) continue;
    const offset = top - element.getBoundingClientRect().top;
    if (Math.abs(offset) >= 1)
      animations.push(
        element.animate(
          [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
          timing
        )
      );
  }
  // The temporary shell keeps sibling FLIP motion compositor-only while the
  // detail itself grows; it is removed as soon as the resize finishes.
  // Moving the detail into the shell would replay its opening animation; the
  // height animation below continues the reveal instead.
  detail.classList.remove("entering");
  const shell = document.createElement("div");
  shell.className = "detail-resize";
  shell.style.height = `${height}px`;
  detail.replaceWith(shell);
  shell.append(detail);
  detail.style.position = "absolute";
  detail.style.width = "100%";
  detail.style.overflow = "hidden";
  const finish = () => {
    if (!detailResizes.has(detail)) return;
    detailResizes.delete(detail);
    for (const animation of animations) animation.cancel();
    detail.style.position = "";
    detail.style.width = "";
    detail.style.overflow = "";
    shell.replaceWith(detail);
  };
  detailResizes.set(detail, finish);
  const animation = detail.animate(
    [{ height: `${previous.height}px` }, { height: `${height}px` }],
    timing
  );
  animations.push(animation);
  animation.finished.then(finish, finish);
  return true;
}

export { renderWithMotion };
