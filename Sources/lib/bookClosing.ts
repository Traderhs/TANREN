export function prepareBookClosing(scene: HTMLDivElement, left: HTMLElement, right: HTMLElement, cover: HTMLElement) {
  const bounds = left.getBoundingClientRect();
  const parentBounds = scene.parentElement!.getBoundingClientRect();
  scene.style.left = `${bounds.left - parentBounds.left}px`;
  scene.style.top = `${bounds.top - parentBounds.top}px`;
  scene.style.width = `${bounds.width * 2}px`;
  scene.style.height = `${bounds.height}px`;
  scene.style.setProperty("--book-depth", `${Math.max(10, bounds.width * .04)}px`);

  const halves = [left, right].map((page, index) => {
    const half = document.createElement("div");
    half.className = `book-volume ${index === 0 ? "book-volume-left" : "book-volume-right"}`;

    const front = document.createElement("div");
    front.className = "book-volume-front";
    const content = page.cloneNode(true) as HTMLElement;
    content.removeAttribute("style");
    content.className = `book-inside-page book-inside-${index === 0 ? "left" : "right"} book-volume-page`;
    front.append(content);

    const sourceElements = [page, ...page.querySelectorAll<HTMLElement>("*")];
    const clonedElements = [content, ...content.querySelectorAll<HTMLElement>("*")];

    const back = document.createElement("div");
    back.className = "book-volume-back";
    if (index === 0) back.append(cover.cloneNode(true));
    half.append(front, back);

    for (const side of ["top", "bottom", "outer"]) {
      const edge = document.createElement("div");
      edge.className = `book-volume-edge book-volume-${side}`;
      half.append(edge);
    }

    const centerEdge = document.createElement("div");
    centerEdge.className = `book-volume-center-edge book-volume-center-edge-${index === 0 ? "left" : "right"}`;
    half.append(centerEdge);

    return { half, sourceElements, clonedElements };
  });

  scene.querySelectorAll(":scope > .book-volume").forEach((node) => node.remove());
  scene.prepend(...halves.map(({ half }) => half));
  scene.style.display = "block";

  for (const { sourceElements, clonedElements } of halves) {
    sourceElements.forEach((source, index) => {
      clonedElements[index].scrollTop = source.scrollTop;
      clonedElements[index].scrollLeft = source.scrollLeft;
    });
  }
}
